import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntimeConfig } from "../backend/config.js";
import { createApp } from "../backend/server.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

test("contract API routes persist generation flows and isolated history", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingling-backend-"));
  const upstream = await startMockOpenAI();
  const config = createRuntimeConfig({
    env: {
      HOST: "127.0.0.1",
      PORT: "0",
      SQLITE_PATH: path.join(tempDir, "app.sqlite"),
      MEDIA_ROOT: path.join(tempDir, "public"),
      SEED_MODE: "real",
      OPENAI_BASE_URL: upstream.baseUrl,
      OPENAI_API_KEY: "test-key",
      OPENAI_CHAT_MODEL: "test-chat",
      OPENAI_IMAGE_MODEL: "test-image",
    },
  });
  const app = createApp(config);
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    app.locals.db.close();
    server.close();
    upstream.server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const home = await getJson(baseUrl, "/api/pages/pg-1r/bootstrap");
  assert.equal(home.pageId, "pg-1r");
  assert.equal(home.modules.length, 4);
  assert.deepEqual(home.gallery, []);

  const emptyPage = await getJson(baseUrl, "/api/pages/pg-1s/bootstrap");
  assert.deepEqual(emptyPage, { pageId: "pg-1s", modules: [], gallery: [] });

  const search = await getJson(
    baseUrl,
    "/api/search/templates?q=%E5%95%86%E6%8B%8D",
  );
  assert.ok(search.items.some((item) => item.route === "/photoreal-product"));

  const assist = await postMultipart(baseUrl, "/api/ai/assist-copy", {
    pageId: "pg-1s",
    field: "description",
    prompt: "保温杯",
    files: [{ name: "cup.png", data: PNG_BASE64 }],
  });
  assert.match(assist.text, /测试AI文案/);

  const model = await postMultipart(baseUrl, "/api/models/matched-reference", {
    pageId: "pg-1t",
    files: [{ name: "hoodie.png", data: PNG_BASE64 }],
  });
  assert.equal(model.modelImage.label, "AI匹配模特");
  assert.match(model.modelImage.url, /^\/media\/models\//);

  const product = await postGeneration(baseUrl, "/api/generations/product-suite", {
    pageId: "pg-1s",
    module: "商品套图生成",
    moduleId: "product-suite",
    options: { description: assist.text, ratio: "1:1", count: 2, resolution: "1024px" },
  });
  assert.equal(product.status, "completed");
  assert.equal(product.gallery.length, 3);
  assert.equal(product.gallery[0].label, "原图");
  assert.equal(product.gallery[1].label, "01 商拍图");

  const tryOn = await postGeneration(baseUrl, "/api/generations/try-on", {
    pageId: "pg-1t",
    module: "万物上身",
    moduleId: "try-on",
    options: {
      description: "卫衣上身",
      referenceModel: model.modelImage,
      ratio: "3:4",
      count: 1,
      resolution: "1080P",
    },
  });
  assert.equal(tryOn.gallery[1].label, "01 上身图");

  const marketing = await postGeneration(baseUrl, "/api/generations/marketing-scene", {
    pageId: "pg-1u",
    module: "高转化主图",
    moduleId: "hero",
    options: { promotePoints: ["除菌率99.9%"], ratio: "4:5", count: 1, resolution: "1024 × 1365" },
  });
  assert.equal(marketing.gallery[1].label, "01 转化图");

  const assets = await postGeneration(baseUrl, "/api/generations/commerce-assets", {
    pageId: "pg-1v",
    module: "参数板块",
    moduleId: "params",
    options: { template: "fashion-new", layout: "grid", colorTheme: "cream-caramel", ratio: "4:5", count: 1 },
  });
  assert.equal(assets.gallery[1].label, "01 参数图");

  const history = await getJson(
    baseUrl,
    "/api/generations/history?pageId=pg-1s&module=%E5%95%86%E5%93%81%E5%A5%97%E5%9B%BE%E7%94%9F%E6%88%90",
  );
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].id, product.taskId);
  assert.match(history.items[0].preview, /^\/media\/generated\//);

  const isolatedHistory = await getJson(
    baseUrl,
    "/api/generations/history?pageId=pg-1s&module=%E4%B8%87%E7%89%A9%E4%B8%8A%E8%BA%AB",
  );
  assert.deepEqual(isolatedHistory.items, []);

  const missingFile = await rawMultipart(baseUrl, "/api/generations/product-suite", {
    pageId: "pg-1s",
    module: "商品套图生成",
    moduleId: "product-suite",
    options: { count: 1 },
    files: [],
  });
  assert.equal(missingFile.status, 400);

  const missingOptions = await rawMultipart(baseUrl, "/api/generations/product-suite", {
    pageId: "pg-1s",
    module: "商品套图生成",
    moduleId: "product-suite",
    files: [{ name: "product.png", data: PNG_BASE64 }],
  });
  assert.equal(missingOptions.status, 400);

  const invalidModule = await rawMultipart(baseUrl, "/api/generations/product-suite", {
    pageId: "pg-1s",
    module: "伪造模块",
    moduleId: "product-suite",
    options: { count: 1 },
    files: [{ name: "product.png", data: PNG_BASE64 }],
  });
  assert.equal(invalidModule.status, 400);

  const invalidReference = await rawMultipart(baseUrl, "/api/generations/try-on", {
    pageId: "pg-1t",
    module: "万物上身",
    moduleId: "try-on",
    options: {
      referenceModel: {
        id: "model-image-missing",
        label: "AI匹配模特",
        url: "/media/models/missing.png",
      },
      count: 1,
    },
    files: [{ name: "hoodie.png", data: PNG_BASE64 }],
  });
  assert.equal(invalidReference.status, 400);
  assert.equal(countRows(app.locals.db, "generation_tasks"), 4);

  const historyModule = await fetch(
    `${baseUrl}/api/generations/history?pageId=pg-1s&module=${encodeURIComponent("我的生成记录")}`,
  );
  assert.equal(historyModule.status, 400);
});

test("product generation retries transient upstream image 503", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingling-retry-ai-"));
  const upstream = await startTransientImage503OpenAI();
  const config = createRuntimeConfig({
    env: {
      HOST: "127.0.0.1",
      PORT: "0",
      SQLITE_PATH: path.join(tempDir, "app.sqlite"),
      MEDIA_ROOT: path.join(tempDir, "public"),
      SEED_MODE: "real",
      OPENAI_BASE_URL: upstream.baseUrl,
      OPENAI_API_KEY: "test-key",
      OPENAI_CHAT_MODEL: "test-chat",
      OPENAI_IMAGE_MODEL: "test-image",
    },
  });
  const app = createApp(config);
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    app.locals.db.close();
    server.close();
    upstream.server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const product = await postGeneration(baseUrl, "/api/generations/product-suite", {
    pageId: "pg-1s",
    module: "商品套图生成",
    moduleId: "product-suite",
    options: { description: "保温杯", ratio: "1:1", count: 1 },
  });
  assert.equal(product.status, "completed");
  assert.equal(product.gallery[1].label, "01 商拍图");
  assert.equal(upstream.getGenerationCalls(), 2);
});

test("assist copy falls back to an available upstream chat model", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingling-chat-fallback-"));
  const upstream = await startChatFallbackOpenAI();
  const config = createRuntimeConfig({
    env: {
      HOST: "127.0.0.1",
      PORT: "0",
      SQLITE_PATH: path.join(tempDir, "app.sqlite"),
      MEDIA_ROOT: path.join(tempDir, "public"),
      SEED_MODE: "real",
      OPENAI_BASE_URL: upstream.baseUrl,
      OPENAI_API_KEY: "test-key",
      OPENAI_CHAT_MODEL: "gpt-4o-mini",
      OPENAI_IMAGE_MODEL: "test-image",
    },
  });
  const app = createApp(config);
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    app.locals.db.close();
    server.close();
    upstream.server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const assist = await postMultipart(baseUrl, "/api/ai/assist-copy", {
    pageId: "pg-1s",
    field: "description",
    prompt: "保温杯",
    files: [],
  });
  assert.equal(assist.text, "可用模型文案：突出商品材质和使用场景。");
  assert.deepEqual(upstream.getChatModels(), ["gpt-4o-mini", "gpt-5.6-luna"]);
});

test("product generation requests result images in parallel", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingling-parallel-ai-"));
  const upstream = await startParallelImageOpenAI();
  const config = createRuntimeConfig({
    env: {
      HOST: "127.0.0.1",
      PORT: "0",
      SQLITE_PATH: path.join(tempDir, "app.sqlite"),
      MEDIA_ROOT: path.join(tempDir, "public"),
      SEED_MODE: "real",
      OPENAI_BASE_URL: upstream.baseUrl,
      OPENAI_API_KEY: "test-key",
      OPENAI_CHAT_MODEL: "test-chat",
      OPENAI_IMAGE_MODEL: "test-image",
    },
  });
  const app = createApp(config);
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    app.locals.db.close();
    server.close();
    upstream.server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const product = await postGeneration(baseUrl, "/api/generations/product-suite", {
    pageId: "pg-1s",
    module: "商品套图生成",
    moduleId: "product-suite",
    options: { description: "保温杯", ratio: "1:1", count: 3 },
  });
  assert.equal(product.gallery.length, 4);
  assert.ok(upstream.getMaxConcurrentGenerations() > 1);
});

test("AI endpoints return explicit 503 when OpenAI config is missing", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingling-no-ai-"));
  const config = createRuntimeConfig({
    env: {
      HOST: "127.0.0.1",
      PORT: "0",
      SQLITE_PATH: path.join(tempDir, "app.sqlite"),
      MEDIA_ROOT: path.join(tempDir, "public"),
      SEED_MODE: "real",
    },
  });
  const app = createApp(config);
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    app.locals.db.close();
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const response = await rawMultipart(baseUrl, "/api/ai/assist-copy", {
    pageId: "pg-1s",
    field: "description",
    prompt: "保温杯",
    files: [],
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error.code, "OPENAI_NOT_CONFIGURED");

  const assists = app.locals.db
    .prepare("SELECT COUNT(*) AS total FROM ai_assists")
    .get();
  assert.equal(assists.total, 0);
});

test("SEED_MODE controls only platform config persistence", () => {
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingling-real-seed-"));
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), "lingling-demo-seed-"));

  const realApp = createApp(
    createRuntimeConfig({
      env: {
        SQLITE_PATH: path.join(realDir, "app.sqlite"),
        MEDIA_ROOT: path.join(realDir, "public"),
        SEED_MODE: "real",
      },
    }),
  );
  const demoApp = createApp(
    createRuntimeConfig({
      env: {
        SQLITE_PATH: path.join(demoDir, "app.sqlite"),
        MEDIA_ROOT: path.join(demoDir, "public"),
        SEED_MODE: "demo",
      },
    }),
  );

  try {
    assert.equal(countRows(realApp.locals.db, "modules"), 0);
    assert.equal(countRows(realApp.locals.db, "templates"), 0);
    assert.equal(countRows(realApp.locals.db, "generation_tasks"), 0);
    assert.equal(countRows(realApp.locals.db, "uploaded_assets"), 0);
    assert.equal(countRows(realApp.locals.db, "generation_results"), 0);

    assert.equal(countRows(demoApp.locals.db, "modules"), 4);
    assert.equal(countRows(demoApp.locals.db, "templates"), 8);
    assert.equal(countRows(demoApp.locals.db, "generation_tasks"), 0);
    assert.equal(countRows(demoApp.locals.db, "uploaded_assets"), 0);
    assert.equal(countRows(demoApp.locals.db, "generation_results"), 0);
  } finally {
    realApp.locals.db.close();
    demoApp.locals.db.close();
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(demoDir, { recursive: true, force: true });
  }
});

async function postGeneration(baseUrl, route, fields) {
  return postMultipart(baseUrl, route, {
    ...fields,
    files: [{ name: "product.png", data: PNG_BASE64 }],
  });
}

async function getJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function postMultipart(baseUrl, route, fields) {
  const response = await rawMultipart(baseUrl, route, fields);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function rawMultipart(baseUrl, route, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (key === "files") continue;
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  for (const file of fields.files ?? []) {
    form.append(
      "files",
      new Blob([Buffer.from(file.data, "base64")], { type: "image/png" }),
      file.name,
    );
  }
  return fetch(`${baseUrl}${route}`, { method: "POST", body: form });
}

async function startMockOpenAI() {
  const server = http.createServer(async (req, res) => {
    await readRequest(req);
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("/v1/chat/completions")) {
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "测试AI文案：突出材质、场景与画面风格。" } }],
        }),
      );
      return;
    }
    if (req.url?.includes("/v1/images/")) {
      res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await listen(server);
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

async function startTransientImage503OpenAI() {
  let generationCalls = 0;
  const server = http.createServer(async (req, res) => {
    await readRequest(req);
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("/v1/chat/completions")) {
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "测试AI文案：突出材质、场景与画面风格。" } }],
        }),
      );
      return;
    }
    if (req.url?.includes("/v1/images/edits")) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "image edits unsupported in retry test" }));
      return;
    }
    if (req.url?.includes("/v1/images/generations")) {
      generationCalls += 1;
      if (generationCalls === 1) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "temporary image worker unavailable" }));
        return;
      }
      res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await listen(server);
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    getGenerationCalls: () => generationCalls,
  };
}

async function startChatFallbackOpenAI() {
  const chatModels = [];
  const server = http.createServer(async (req, res) => {
    const bodyText = await readRequest(req);
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(
        JSON.stringify({
          data: [
            { id: "gpt-image-1" },
            { id: "gpt-5.6-luna" },
            { id: "gpt-5.6-terra" },
          ],
        }),
      );
      return;
    }
    if (req.url?.includes("/v1/chat/completions")) {
      const body = JSON.parse(bodyText || "{}");
      chatModels.push(body.model);
      if (body.model === "gpt-4o-mini") {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "configured model unavailable" }));
        return;
      }
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "可用模型文案：突出商品材质和使用场景。" } }],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await listen(server);
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    getChatModels: () => chatModels,
  };
}

async function startParallelImageOpenAI() {
  let inFlightGenerations = 0;
  let maxConcurrentGenerations = 0;
  const server = http.createServer(async (req, res) => {
    await readRequest(req);
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("/v1/images/edits")) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "image edits unsupported in parallel test" }));
      return;
    }
    if (req.url?.includes("/v1/images/generations")) {
      inFlightGenerations += 1;
      maxConcurrentGenerations = Math.max(maxConcurrentGenerations, inFlightGenerations);
      await delay(80);
      inFlightGenerations -= 1;
      res.end(JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await listen(server);
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    getMaxConcurrentGenerations: () => maxConcurrentGenerations,
  };
}

function listen(serverOrApp) {
  return new Promise((resolve, reject) => {
    const server = serverOrApp.listen(0, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
