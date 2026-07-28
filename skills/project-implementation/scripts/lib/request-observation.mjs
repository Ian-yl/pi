import { createHash } from 'node:crypto';

export function observedRequestValueDigests(request, body, operations = [], prefix = 'request') {
  return observedRequestEvidence(request, body, operations, prefix).valueDigests;
}

export function observedRequestEvidence(request, body, operations = [], prefix = 'request') {
  const values = {};
  const contentDigests = {};
  const url = new URL(request.url || '/', 'http://observer');
  const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value)]));
  for (const key of new Set(url.searchParams.keys())) setValue(values, `${prefix}.query.${key}`, url.searchParams.getAll(key));
  for (const [key, value] of Object.entries(headers)) addValue(values, `${prefix}.header.${key}`, value);
  const operation = operations.find((item) => String(item.method).toUpperCase() === String(request.method).toUpperCase() && pathMatches(item.path, url.pathname));
  if (operation) for (const [key, value] of Object.entries(pathParameters(operation.path, url.pathname))) addValue(values, `${prefix}.path.${key}`, value);
  if (operation) for (const key of Object.keys(operation.request?.headerSchema?.properties || {})) if (headers[key.toLowerCase()] !== undefined) addValue(values, `${prefix}.header.${key}`, headers[key.toLowerCase()]);
  const contentType = headers['content-type'] || '';
  if (/multipart\/form-data/i.test(contentType)) collectMultipart(body, contentType, values, contentDigests, prefix);
  else try { const parsed = JSON.parse(body.toString('utf8')); collectValueDigests(parsed, prefix, values); collectContentDigests(parsed, prefix, contentDigests); } catch {}
  return { valueDigests: values, contentDigests };
}

export function collectValueDigests(value, path, values) {
  values[path] = digestValue(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, item] of Object.entries(value)) collectValueDigests(item, `${path}.${key}`, values);
}

function collectMultipart(body, contentType, values, contentDigests, prefix) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary) return;
  const marker = Buffer.from(`--${boundary}`);
  const fields = {};
  for (const part of splitBuffer(body, marker)) {
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    if (separator < 0) continue;
    const headerText = part.subarray(0, separator).toString('utf8');
    const name = /content-disposition:[^\r\n]*\bname="([^"]+)"/i.exec(headerText)?.[1];
    if (!name) continue;
    let payload = part.subarray(separator + 4);
    if (payload.subarray(payload.length - 2).toString() === '\r\n') payload = payload.subarray(0, payload.length - 2);
    const filename = /content-disposition:[^\r\n]*\bfilename="([^"]*)"/i.exec(headerText)?.[1];
    const value = filename === undefined ? payload.toString('utf8') : { filename, size: payload.length, contentDigest: sha(payload) };
    if (filename !== undefined) addContentDigest(contentDigests, `${prefix}.${name}`, 'raw-content', sha(payload));
    (fields[name] ||= []).push(value);
  }
  for (const [name, items] of Object.entries(fields)) setValue(values, `${prefix}.${name}`, items);
}

function collectContentDigests(value, path, contentDigests) {
  if (Array.isArray(value)) { for (const item of value) collectContentDigests(item, path, contentDigests); return; }
  if (value && typeof value === 'object') { for (const [key, item] of Object.entries(value)) collectContentDigests(item, `${path}.${key}`, contentDigests); return; }
  if (typeof value !== 'string') return;
  addContentDigest(contentDigests, path, 'raw-content', sha(Buffer.from(value, 'utf8')));
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0) try { addContentDigest(contentDigests, path, 'base64-content', sha(Buffer.from(value, 'base64'))); } catch {}
}

function addContentDigest(contentDigests, path, mode, digest) { const modes = (contentDigests[path] ||= {}); modes[mode] = [...new Set([...(modes[mode] || []), digest])]; }

function addValue(values, path, value) {
  if (!(path in values)) values[path] = digestValue(value);
  else values[path] = digestValue([values[path], value]);
}
function setValue(values, path, items) { values[path] = digestValue(items.length === 1 ? items[0] : items); }

function pathParameters(contractPath, observedPath) {
  const names = [...String(contractPath).matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  const pattern = String(contractPath).split(/(\{[^}]+\})/).map((part) => part.startsWith('{') ? '([^/]+)' : escapeRegExp(part)).join('');
  const match = new RegExp(`^${pattern}$`).exec(observedPath);
  return match ? Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])])) : {};
}

function pathMatches(contractPath, observedPath) { return Object.keys(pathParameters(contractPath, observedPath)).length > 0 || contractPath === observedPath; }
function splitBuffer(buffer, separator) { const parts = []; let start = 0; let index; while ((index = buffer.indexOf(separator, start)) >= 0) { parts.push(buffer.subarray(start, index)); start = index + separator.length; } parts.push(buffer.subarray(start)); return parts; }
function digestValue(value) { return sha(Buffer.from(JSON.stringify(value))); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
