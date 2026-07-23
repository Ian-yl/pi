import { hash, saveBuffer } from './media.js';

export class ProviderError extends Error {
  constructor(code, message, status = 503) { super(message); this.code = code; this.status = status; }
}

export async function assistCopy(config, input) {
  assertConfigured(config, 'chat');
  const content = [{ type: 'text', text: `页面:${input.pageId}\n字段:${input.field}\n现有描述:${input.prompt || '空'}\n请输出适合电商图片生成的具体中文描述。` }];
  for (const file of input.files.slice(0, 4)) content.push({ type: 'image_url', image_url: { url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}` } });
  const body = { model: config.chatModel, messages: [{ role: 'system', content: '你是电商视觉业务助手，只返回可直接使用的文案。' }, { role: 'user', content }], temperature: 0.5 };
  const response = await providerJson(config, '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = response.body?.choices?.[0]?.message?.content;
  if (!text) throw new ProviderError('PROVIDER_RESPONSE_INVALID', '供应商没有返回文案');
  return { text: String(text).trim(), requestSha: hash(JSON.stringify(body)), responseSha: response.sha };
}

export async function generateImage(config, input) {
  assertConfigured(config, 'image');
  const request = { model: config.imageModel, prompt: input.prompt, n: 1, size: sizeFor(input.ratio) };
  let response;
  if (input.files.length) {
    const form = new FormData();
    for (const [key, value] of Object.entries(request)) form.append(key, String(value));
    for (const file of input.files) form.append('image', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
    try { response = await providerJson(config, '/v1/images/edits', { method: 'POST', body: form }); }
    catch (error) { if (!(error instanceof ProviderError) || ![400, 404, 405, 422].includes(error.status)) throw error; }
  }
  if (!response) response = await providerJson(config, '/v1/images/generations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
  const item = response.body?.data?.[0];
  let bytes;
  if (item?.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
  else if (item?.url) {
    const downloaded = await fetch(item.url, { signal: AbortSignal.timeout(180000) });
    if (!downloaded.ok) throw new ProviderError('PROVIDER_IMAGE_DOWNLOAD_FAILED', `图片下载失败:${downloaded.status}`);
    bytes = Buffer.from(await downloaded.arrayBuffer());
  } else throw new ProviderError('PROVIDER_RESPONSE_INVALID', '供应商没有返回图片');
  if (bytes.length < 1024) throw new ProviderError('PROVIDER_OUTPUT_INVALID', '供应商返回的图片文件过小');
  const saved = saveBuffer(input.mediaRoot, 'generated', bytes);
  return { ...saved, requestSha: hash(JSON.stringify(request)), responseSha: response.sha };
}

async function providerJson(config, pathname, init) {
  let response;
  try { response = await fetch(`${config.baseUrl}${pathname}`, { ...init, headers: { authorization: `Bearer ${config.apiKey}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(180000) }); }
  catch (error) { throw new ProviderError('PROVIDER_NETWORK_ERROR', error.message); }
  const text = await response.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new ProviderError('PROVIDER_UPSTREAM_ERROR', `供应商返回 ${response.status}`, response.status);
  return { body, sha: hash(text) };
}
function assertConfigured(config, type) {
  if (!config.baseUrl || !config.apiKey || !(type === 'chat' ? config.chatModel : config.imageModel)) throw new ProviderError('PROVIDER_NOT_CONFIGURED', '真实供应商未配置');
}
function sizeFor(ratio = '1:1') { const [w, h] = String(ratio).split(':').map(Number); if (!w || !h) return '1024x1024'; if (w / h > 1.2) return '1536x1024'; if (w / h < 0.83) return '1024x1536'; return '1024x1024'; }
