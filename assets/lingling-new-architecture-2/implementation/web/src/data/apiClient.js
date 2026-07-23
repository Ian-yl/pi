import { makeImage } from "./imageFactory.js";
import { mockPages, mockSearchItems } from "./mockData.js";

const API_MODE = import.meta.env.VITE_API_MODE ?? "real";
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
const isMock =
  API_MODE === "mock" || API_MODE === "mock-ready" || API_MODE === "auto";

function wait(ms = 280) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, options);
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true, data: await response.json() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "请求失败",
    };
  }
}

export async function loadPage(pageId) {
  if (isMock) {
    await wait(120);
    return { ok: true, data: mockPages[pageId] };
  }
  return request(`/api/pages/${pageId}/bootstrap`);
}

export async function searchTemplates(q) {
  if (isMock) {
    await wait(160);
    const query = q.toLowerCase();
    return {
      ok: true,
      data: {
        items: mockSearchItems.filter(
          (item) =>
            item.title.toLowerCase().includes(query) ||
            item.category.toLowerCase().includes(query),
        ),
      },
    };
  }
  return request(`/api/search/templates?q=${encodeURIComponent(q)}`);
}

function appendFormPayload(formData, payload) {
  Object.entries(payload).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (key === "files") {
      value.forEach((file) => formData.append("files", file));
    } else if (Array.isArray(value) || typeof value === "object") {
      formData.append(key, JSON.stringify(value));
    } else {
      formData.append(key, String(value));
    }
  });
}

export async function aiAssistCopy({ pageId, field, prompt, files = [] }) {
  if (isMock) {
    await wait(420);
    const fileHint = files.length ? `结合已上传的 ${files.length} 张图，` : "";
    const copyMap = {
      "pg-1s":
        "适合雾感保温杯、奶茶色系场景；突出杯身磨砂质感、便携提手与防漏能力，画面偏高级静物棚拍。",
      "pg-1t":
        "秋季针织连帽卫衣，要求保留灰蓝色系、版型微宽松，突出面料纹理，搭配通勤风半身裙效果更自然。",
      "pg-1u": "除菌率99.9%、持久留香72h、植物萃取配方、低泡易漂洗、柔顺护衣",
      "pg-1v":
        "主标题：自在生活 轻盈出行；促销角标：限时直降 立省60元；卖点短句：柔软透气 不易变形",
    };
    return {
      ok: true,
      data: { text: `${fileHint}${copyMap[pageId] ?? prompt}` },
    };
  }
  const formData = new FormData();
  appendFormPayload(formData, { pageId, field, prompt, files });
  return request("/api/ai/assist-copy", { method: "POST", body: formData });
}

export async function generateMatchedModel({ pageId, files = [] }) {
  if (isMock) {
    await wait(500);
    return {
      ok: true,
      data: {
        modelImage: {
          id: `model-${Date.now()}`,
          label: "AI匹配模特",
          url: makeImage("tryon", "AI匹配模特", "thumb"),
        },
      },
    };
  }
  const formData = new FormData();
  appendFormPayload(formData, { pageId, files });
  return request("/api/models/matched-reference", {
    method: "POST",
    body: formData,
  });
}

export async function generateImages(config, payload) {
  if (isMock) {
    await wait(760);
    const count = Number(payload.count ?? 4);
    const origin = payload.uploads?.[0]
      ? { id: "origin-upload", label: "原图", url: payload.uploads[0].url }
      : {
          id: "origin",
          label: "原图",
          url: makeImage(config.imageKind, "原图", "thumb"),
        };
    const gallery = [origin];
    for (let index = 1; index <= count; index += 1) {
      const padded = String(index).padStart(2, "0");
      gallery.push({
        id: `${config.pageId}-${Date.now()}-${index}`,
        label: `${padded} ${config.resultName}`,
        url: makeImage(config.imageKind, `${padded} ${config.resultName}`),
      });
    }
    return {
      ok: true,
      data: {
        taskId: `task-${config.pageId}-${Date.now()}`,
        status: "completed",
        gallery,
      },
    };
  }
  const {
    files,
    uploads,
    module = config.activeTool,
    moduleId,
    ...options
  } = payload;
  const formData = new FormData();
  appendFormPayload(formData, {
    pageId: config.pageId,
    module,
    moduleId,
    files,
    options,
  });
  return request(config.generatePath, { method: "POST", body: formData });
}

export async function loadHistory({ pageId, module }) {
  if (isMock) {
    await wait(220);
    return {
      ok: true,
      data: {
        items: [
          {
            id: "h-1",
            title: "今日生成任务",
            createdAt: "2026-07-22 15:10",
            preview: makeImage("product", "历史记录", "thumb"),
          },
          {
            id: "h-2",
            title: "上次活动图",
            createdAt: "2026-07-21 18:40",
            preview: makeImage("marketing", "历史记录", "thumb"),
          },
        ],
      },
    };
  }
  return request(
    `/api/generations/history?pageId=${encodeURIComponent(pageId)}&module=${encodeURIComponent(module)}`,
  );
}
