import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function runtimeConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 5050),
    dbPath: resolvePath(env.SQLITE_PATH || 'data/app.sqlite'),
    mediaRoot: resolvePath(env.MEDIA_ROOT || 'data/public'),
    provider: {
      baseUrl: String(env.OPENAI_BASE_URL || '').replace(/\/+$/, '').replace(/\/v1$/, ''),
      apiKey: env.OPENAI_API_KEY || '',
      chatModel: env.OPENAI_CHAT_MODEL || '',
      imageModel: env.OPENAI_IMAGE_MODEL || '',
    },
  };
}
function resolvePath(value) { return path.isAbsolute(value) ? value : path.join(root, value); }
