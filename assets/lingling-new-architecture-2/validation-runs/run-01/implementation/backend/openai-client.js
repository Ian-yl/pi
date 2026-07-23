import { saveGeneratedBase64 } from "./media.js";

const OPENAI_MAX_ATTEMPTS = 3;
const OPENAI_RETRY_DELAY_MS = 250;
const TRANSIENT_OPENAI_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class ExternalAIError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExternalAIError";
    this.status = details.status ?? 503;
    this.code = details.code ?? "OPENAI_UNAVAILABLE";
    this.details = details;
  }
}

export async function generateCopyText(config, input) {
  const fileHint = input.files?.length
    ? `用户上传了 ${input.files.length} 张参考图片。`
    : "用户尚未上传参考图片。";
  const content = await chatCompletion(config, {
    system:
      "你是电商视觉生成工具的中文文案助手，只输出可直接填入表单的一段中文建议，不要解释。",
    text: [
      `页面ID：${input.pageId}`,
      `字段：${input.field}`,
      `现有文本：${input.prompt || "空"}`,
      fileHint,
      "请结合页面业务给出精炼、可执行、适合图像生成的文案。",
    ].join("\n"),
    files: input.files,
  });
  return content.trim().slice(0, 400);
}

export async function generateMatchedModelImage(config, input) {
  const prompt = [
    "为电商服饰试穿生成一张真实自然的参考模特图。",
    "模特应适合亚洲电商场景，干净背景，自然站姿，便于后续服装上身生成。",
    input.files?.length
      ? `参考用户上传的 ${input.files.length} 张服饰或模特图片风格。`
      : "无用户参考图时生成通勤自然风格模特。",
  ].join("\n");
  const image = await generateImage(config, {
    prompt,
    files: input.files,
    mediaRoot: input.mediaRoot,
    folder: "models",
    size: "1024x1536",
  });
  return {
    id: image.id,
    label: "AI匹配模特",
    url: image.url,
  };
}

export async function generateResultImage(config, input) {
  const prompt = buildImagePrompt(input);
  return generateImage(config, {
    prompt,
    files: input.files,
    mediaRoot: input.mediaRoot,
    folder: "generated",
    size: sizeFromRatio(input.options?.ratio),
  });
}

function buildImagePrompt(input) {
  const referenceModel = input.options?.referenceModel;
  const referenceText =
    referenceModel && typeof referenceModel === "object"
      ? `参考模特：${referenceModel.label || ""} ${referenceModel.url || ""}`
      : "";
  return [
    "生成一张可用于电商页面的真实商品视觉图片。",
    `页面：${input.pageId}`,
    `功能模块：${input.module} (${input.moduleId})`,
    `结果标签：${input.label}`,
    `结果类型：${input.resultName}`,
    `用户上传图片数量：${input.files?.length ?? 0}`,
    referenceText,
    `用户参数JSON：${JSON.stringify(input.options ?? {})}`,
    "画面要求：清晰、真实、无多余文字水印，主体商品突出，构图适合电商运营直接使用。",
  ]
    .filter(Boolean)
    .join("\n");
}

async function chatCompletion(config, input) {
  assertConfigured(config);
  const imageItems = (input.files ?? [])
    .filter((file) => file.buffer?.length && file.buffer.length <= 4_000_000)
    .slice(0, 4)
    .map((file) => ({
      type: "image_url",
      image_url: {
        url: `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`,
      },
    }));

  const contentWithImages = [{ type: "text", text: input.text }, ...imageItems];
  try {
    return await postChat(config, contentWithImages, input.system);
  } catch (error) {
    if (!imageItems.length) throw error;
    return postChat(config, input.text, input.system);
  }
}

async function postChat(config, userContent, system) {
  let lastError;
  for (const model of await chatModelCandidates(config)) {
    try {
      const data = await openaiJson(
        config,
        "/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: userContent },
            ],
            temperature: 0.7,
          }),
        },
        { maxAttempts: 1 },
      );
      const text = data?.choices?.[0]?.message?.content;
      if (!text) {
        throw new ExternalAIError("OpenAI chat response did not include content");
      }
      return text;
    } catch (error) {
      lastError = error;
      if (!isChatModelFallbackError(error)) throw error;
    }
  }
  throw lastError;
}

async function chatModelCandidates(config) {
  const configured = config.openaiChatModel;
  const available = await listAvailableChatModels(config).catch(() => []);
  return unique([configured, ...available]);
}

async function listAvailableChatModels(config) {
  const data = await openaiJson(
    config,
    "/v1/models",
    { method: "GET" },
    { maxAttempts: 1 },
  );
  return (data?.data ?? [])
    .map((item) => String(item?.id ?? "").trim())
    .filter(isLikelyChatModel)
    .sort(compareChatModelPreference);
}

function isLikelyChatModel(model) {
  if (!model) return false;
  if (model.startsWith("gpt-image")) return false;
  if (model.includes("codex")) return false;
  return model.startsWith("gpt-") || model.startsWith("o");
}

function compareChatModelPreference(a, b) {
  return chatModelRank(a) - chatModelRank(b);
}

function chatModelRank(model) {
  if (model.includes("luna")) return 0;
  if (model.includes("mini")) return 1;
  if (model.includes("terra")) return 2;
  if (model.includes("sol")) return 3;
  return 4;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isChatModelFallbackError(error) {
  if (isTransientOpenAIError(error)) return true;
  const message = JSON.stringify(error?.details?.body ?? {}).toLowerCase();
  return (
    [400, 404].includes(Number(error?.status)) &&
    (message.includes("model") ||
      message.includes("not found") ||
      message.includes("does not exist") ||
      message.includes("unsupported"))
  );
}

async function openaiJson(config, pathname, init, options = {}) {
  const maxAttempts = options.maxAttempts ?? OPENAI_MAX_ATTEMPTS;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await openaiJsonOnce(config, pathname, init);
    } catch (error) {
      lastError =
        error instanceof ExternalAIError
          ? error
          : new ExternalAIError("OpenAI request failed", {
              code: "OPENAI_NETWORK_ERROR",
              cause: error?.message ?? String(error),
            });
      if (attempt >= maxAttempts || !isTransientOpenAIError(lastError)) {
        throw lastError;
      }
      await delay(OPENAI_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

async function openaiJsonOnce(config, pathname, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(`${config.openaiBaseUrl}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.openaiApiKey}`,
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const body = text ? parseJson(text) : {};
    if (!response.ok) {
      throw new ExternalAIError(`OpenAI request failed with ${response.status}`, {
        code: "OPENAI_UPSTREAM_ERROR",
        status: response.status,
        body,
      });
    }
    return body;
  } catch (error) {
    if (error instanceof ExternalAIError) throw error;
    throw new ExternalAIError("OpenAI request failed", {
      code: "OPENAI_NETWORK_ERROR",
      cause: error?.message ?? String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isTransientOpenAIError(error) {
  if (error.code === "OPENAI_NETWORK_ERROR") return true;
  return TRANSIENT_OPENAI_STATUSES.has(Number(error.status));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertConfigured(config) {
  if (!config.openaiBaseUrl || !config.openaiApiKey) {
    throw new ExternalAIError("OpenAI base URL or API key is not configured", {
      code: "OPENAI_NOT_CONFIGURED",
    });
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function sizeFromRatio(ratio = "1:1") {
  const match = String(ratio).match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return "1024x1024";
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return "1024x1024";
  const value = width / height;
  if (value < 0.85) return "1024x1536";
  if (value > 1.18) return "1536x1024";
  return "1024x1024";
}

function cryptoRandomId(prefix = "image") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function generateImage(config, input) {
  assertConfigured(config);
  const preferredSize = input.size || "1024x1024";
  const attempts = [];
  if (input.files?.length) {
    attempts.push(() => requestImageEdit(config, input, preferredSize));
  }
  attempts.push(() => requestImageGeneration(config, input, preferredSize));
  if (preferredSize !== "1024x1024") {
    attempts.push(() => requestImageGeneration(config, input, "1024x1024"));
  }

  let lastError;
  for (const attempt of attempts) {
    try {
      const imageData = await attempt();
      return materializeImage(imageData, input.mediaRoot, input.folder);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof ExternalAIError
    ? lastError
    : new ExternalAIError("OpenAI image generation failed", {
        cause: lastError?.message,
      });
}

async function requestImageEdit(config, input, size) {
  const form = new FormData();
  form.append("model", config.openaiImageModel);
  form.append("prompt", input.prompt);
  form.append("n", "1");
  form.append("size", size);
  for (const [index, file] of input.files.entries()) {
    form.append(
      "image",
      new Blob([file.buffer], { type: file.mimetype || "image/png" }),
      file.originalname || `reference-${index + 1}.png`,
    );
  }
  return openaiJson(config, "/v1/images/edits", {
    method: "POST",
    body: form,
  });
}

async function requestImageGeneration(config, input, size) {
  return openaiJson(config, "/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.openaiImageModel,
      prompt: input.prompt,
      n: 1,
      size,
    }),
  });
}

async function materializeImage(data, mediaRoot, folder) {
  const item = data?.data?.[0];
  if (item?.b64_json) {
    return saveGeneratedBase64(item.b64_json, mediaRoot, folder);
  }
  if (item?.url) {
    return { id: cryptoRandomId(folder), url: item.url };
  }
  throw new ExternalAIError("OpenAI image response did not include an image");
}
