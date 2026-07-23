import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { runtimeConfig } from "./config.js";
import {
  createId,
  getReferenceModel,
  getLatestPageGallery,
  insertCompletedGeneration,
  listHistory,
  listModules,
  nowIso,
  openDatabase,
  saveAssist,
  saveReferenceModel,
  searchTemplates,
} from "./database.js";
import { ensureMediaRoot, saveUploadedFiles } from "./media.js";
import {
  ExternalAIError,
  generateCopyText,
  generateMatchedModelImage,
  generateResultImage,
} from "./openai-client.js";
import {
  CONTRACT_ENDPOINT_LITERALS,
  GENERATION_CONFIGS,
  PAGE_IDS,
  PAGE_TO_GENERATION_CONFIG,
} from "./static-data.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 12,
    fileSize: 12 * 1024 * 1024,
  },
});

// Keep the exact contract path literals discoverable outside web/:
void CONTRACT_ENDPOINT_LITERALS;

export function createApp(config = runtimeConfig) {
  const db = openDatabase(config.dbPath, config.seedMode);
  ensureMediaRoot(config.mediaRoot);

  const app = express();
  app.locals.db = db;
  app.locals.config = config;

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use("/media", express.static(config.mediaRoot, { fallthrough: false }));

  app.get("/api/pages/:pageId/bootstrap", (req, res) => {
    const pageId = req.params.pageId;
    if (!PAGE_IDS.includes(pageId)) {
      return sendError(res, 404, "PAGE_NOT_FOUND", "页面不存在");
    }
    if (pageId === "pg-1r") {
      return res.json({ pageId, modules: listModules(db), gallery: [] });
    }
    return res.json({ pageId, modules: [], gallery: getLatestPageGallery(db, pageId) });
  });

  app.get("/api/search/templates", (req, res) => {
    const query = String(req.query.q ?? "").trim();
    if (!query) {
      return sendError(res, 400, "VALIDATION_ERROR", "q 至少需要 1 个字符");
    }
    return res.json({ items: searchTemplates(db, query) });
  });

  app.post("/api/ai/assist-copy", upload.array("files"), async (req, res) => {
    try {
      const pageId = expectBodyString(req, "pageId");
      const field = expectBodyString(req, "field");
      if (!["pg-1s", "pg-1t"].includes(pageId)) {
        return sendError(res, 400, "VALIDATION_ERROR", "pageId 不支持 AI 帮写");
      }
      const text = await generateCopyText(config, {
        pageId,
        field,
        prompt: String(req.body.prompt ?? ""),
        files: req.files ?? [],
      });
      saveAssist(db, {
        pageId,
        field,
        prompt: String(req.body.prompt ?? ""),
        responseText: text,
        fileCount: req.files?.length ?? 0,
      });
      return res.json({ text });
    } catch (error) {
      return handleRouteError(res, error);
    }
  });

  app.post(
    "/api/models/matched-reference",
    upload.array("files"),
    async (req, res) => {
      try {
        const pageId = expectBodyString(req, "pageId");
        if (pageId !== "pg-1t") {
          return sendError(
            res,
            400,
            "VALIDATION_ERROR",
            "匹配模特仅支持 pg-1t",
          );
        }
        const modelImage = await generateMatchedModelImage(config, {
          files: req.files ?? [],
          mediaRoot: config.mediaRoot,
        });
        const saved = saveReferenceModel(db, {
          ...modelImage,
          pageId,
          fileCount: req.files?.length ?? 0,
        });
        return res.json({ modelImage: saved });
      } catch (error) {
        return handleRouteError(res, error);
      }
    },
  );

  for (const [routePath, generationConfig] of Object.entries(
    GENERATION_CONFIGS,
  )) {
    app.post(routePath, upload.array("files"), generationHandler(generationConfig));
  }

  app.get("/api/generations/history", (req, res) => {
    const pageId = String(req.query.pageId ?? "");
    const module = String(req.query.module ?? "");
    if (!PAGE_TO_GENERATION_CONFIG[pageId] || !module.trim()) {
      return sendError(
        res,
        400,
        "VALIDATION_ERROR",
        "pageId 与 module 为必填参数",
      );
    }
    if (isHistoryModule(module, String(req.query.moduleId ?? ""))) {
      return sendError(
        res,
        400,
        "VALIDATION_ERROR",
        "我的生成记录不是可查询的生成模块",
      );
    }
    return res.json({ items: listHistory(db, { pageId, module }) });
  });

  const webDist = path.join(config.projectRoot, "web", "dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/media/")) {
        return next();
      }
      return res.sendFile(path.join(webDist, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res.json({
        status: "ok",
        message: "Backend is running. Run npm run build to serve the frontend.",
      });
    });
  }

  app.use((error, _req, res, _next) => handleRouteError(res, error));
  return app;

  function generationHandler(generationConfig) {
    return async (req, res) => {
      try {
        const pageId = expectBodyString(req, "pageId");
        const module = expectBodyString(req, "module");
        const moduleId = expectBodyString(req, "moduleId");
        if (pageId !== generationConfig.pageId) {
          return sendError(
            res,
            400,
            "VALIDATION_ERROR",
            `该生成接口仅支持 ${generationConfig.pageId}`,
          );
        }
        if (isHistoryModule(module, moduleId)) {
          return sendError(
            res,
            400,
            "VALIDATION_ERROR",
            "我的生成记录不是可提交的生成模块",
          );
        }
        if (!isAllowedGenerationModule(generationConfig, module, moduleId)) {
          return sendError(
            res,
            400,
            "VALIDATION_ERROR",
            "module 与 moduleId 不属于该页面可生成模块",
          );
        }
        const files = req.files ?? [];
        if (generationConfig.requiredFiles && files.length === 0) {
          return sendError(
            res,
            400,
            "VALIDATION_ERROR",
            "请上传至少 1 张图片后再生成",
          );
        }
        const options = parseOptions(req.body.options, { required: true });
        const count = clampCount(options.count);
        const generationFiles = buildGenerationFiles({
          db,
          mediaRoot: config.mediaRoot,
          pageId,
          files,
          options,
        });
        const uploads = saveUploadedFiles(files, config.mediaRoot);
        const createdAt = nowIso();
        const taskId = createId(`task-${pageId}`);
        const origin = {
          id: `${taskId}-origin`,
          label: "原图",
          url: uploads[0].url,
          kind: "upload",
        };
        const generatedGallery = await Promise.all(
          Array.from({ length: count }, async (_item, itemIndex) => {
            const index = itemIndex + 1;
            const padded = String(index).padStart(2, "0");
            const label = `${padded} ${generationConfig.resultName}`;
            const image = await generateResultImage(config, {
              pageId,
              module,
              moduleId,
              label,
              resultName: generationConfig.resultName,
              options,
              files: generationFiles,
              mediaRoot: config.mediaRoot,
            });
            return {
              id: `${taskId}-${index}`,
              label,
              url: image.url,
              kind: "generated",
            };
          }),
        );
        const gallery = [origin, ...generatedGallery];

        const response = insertCompletedGeneration(db, {
          taskId,
          pageId,
          module,
          moduleId,
          endpointId: generationConfig.endpointId,
          options,
          promptSummary: summarizeOptions(options),
          uploads,
          gallery,
          createdAt,
        });
        return res.json(response);
      } catch (error) {
        return handleRouteError(res, error);
      }
    };
  }
}

export function startServer(config = runtimeConfig) {
  const app = createApp(config);
  const server = app.listen(config.port, config.host, () => {
    console.log(
      `Lingling backend listening at http://${config.host}:${config.port}`,
    );
  });
  return { app, server };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

function expectBodyString(req, key) {
  const value = String(req.body?.[key] ?? "").trim();
  if (!value) {
    const error = new Error(`${key} 为必填字段`);
    error.status = 400;
    error.code = "VALIDATION_ERROR";
    throw error;
  }
  return value;
}

function parseOptions(value, { required = false } = {}) {
  if (value && typeof value === "object") return value;
  if (!value) {
    if (required) {
      const error = new Error("options 为必填字段");
      error.status = 400;
      error.code = "VALIDATION_ERROR";
      throw error;
    }
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    const error = new Error("options 必须是 JSON 字符串");
    error.status = 400;
    error.code = "VALIDATION_ERROR";
    throw error;
  }
}

function clampCount(value) {
  const count = Number(value ?? 1);
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(8, Math.floor(count)));
}

function summarizeOptions(options) {
  const keys = [
    "description",
    "promotePoints",
    "template",
    "layout",
    "style",
    "ratio",
    "resolution",
  ];
  return keys
    .map((key) => {
      const value = options[key];
      if (value === undefined || value === null || value === "") return "";
      return `${key}: ${Array.isArray(value) ? value.join("、") : String(value)}`;
    })
    .filter(Boolean)
    .join("\n")
    .slice(0, 1000);
}

function isHistoryModule(module, moduleId) {
  return module === "我的生成记录" || moduleId === "history";
}

function isAllowedGenerationModule(generationConfig, module, moduleId) {
  return (generationConfig.allowedModules ?? []).some(
    ([allowedId, allowedLabel]) =>
      moduleId === allowedId && module === allowedLabel,
  );
}

function buildGenerationFiles({ db, mediaRoot, pageId, files, options }) {
  const referenceModel = options?.referenceModel;
  if (!isPersistedReferenceModel(referenceModel)) return files;

  const saved = getReferenceModel(db, {
    id: referenceModel.id,
    pageId,
  });
  if (!saved || saved.url !== referenceModel.url) {
    const error = new Error("referenceModel 不存在或不属于当前页面");
    error.status = 400;
    error.code = "VALIDATION_ERROR";
    throw error;
  }

  const mediaFile = mediaFileFromUrl(mediaRoot, saved.url);
  return mediaFile ? [...files, mediaFile] : files;
}

function isPersistedReferenceModel(referenceModel) {
  if (!referenceModel || typeof referenceModel !== "object") return false;
  const id = String(referenceModel.id ?? "").trim();
  if (!id) return false;
  return (
    referenceModel.label === "AI匹配模特" ||
    id.startsWith("model") ||
    id.startsWith("models-") ||
    String(referenceModel.url ?? "").startsWith("/media/models/")
  );
}

function mediaFileFromUrl(mediaRoot, url) {
  const prefix = "/media/";
  if (!String(url).startsWith(prefix)) return null;
  const relativePath = path.normalize(String(url).slice(prefix.length));
  if (relativePath.startsWith("..")) return null;
  const diskPath = path.join(mediaRoot, relativePath);
  if (!fs.existsSync(diskPath)) return null;
  return {
    buffer: fs.readFileSync(diskPath),
    mimetype: "image/png",
    originalname: path.basename(diskPath),
    size: fs.statSync(diskPath).size,
  };
}

function handleRouteError(res, error) {
  if (error instanceof ExternalAIError) {
    const message =
      error.code === "OPENAI_NOT_CONFIGURED"
        ? "AI 服务未配置，请在项目根 .env 设置 OPENAI_BASE_URL 与 OPENAI_API_KEY"
        : "AI 服务上游不可用，请检查 OpenAI 兼容接口配置";
    return sendError(
      res,
      503,
      error.code,
      message,
    );
  }
  if (error?.code === "LIMIT_FILE_SIZE") {
    return sendError(res, 413, "FILE_TOO_LARGE", "上传图片过大");
  }
  return sendError(
    res,
    error?.status || 500,
    error?.code || "INTERNAL_ERROR",
    error?.message || "服务器错误",
  );
}

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}
