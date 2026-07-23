import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BACKEND_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(BACKEND_DIR, "..");

dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

function resolveProjectPath(value, fallback) {
  const next = value || fallback;
  return path.isAbsolute(next) ? next : path.join(PROJECT_ROOT, next);
}

function normalizeBaseUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

export function createRuntimeConfig(overrides = {}) {
  const env = overrides.env ?? process.env;
  return {
    projectRoot: PROJECT_ROOT,
    host: overrides.host ?? env.HOST ?? "127.0.0.1",
    port: Number(overrides.port ?? env.PORT ?? 4183),
    dbPath: resolveProjectPath(env.SQLITE_PATH, "data/app.sqlite"),
    mediaRoot: resolveProjectPath(env.MEDIA_ROOT, "data/public"),
    seedMode: env.SEED_MODE === "demo" ? "demo" : "real",
    openaiBaseUrl: normalizeBaseUrl(env.OPENAI_BASE_URL),
    openaiApiKey: String(env.OPENAI_API_KEY ?? "").trim(),
    openaiChatModel: env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    openaiImageModel: env.OPENAI_IMAGE_MODEL || "gpt-image-1",
  };
}

export const runtimeConfig = createRuntimeConfig();
