import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function assetReferenceFindings(files, runtime, asset) {
  const findings = []; const needles = [asset.path, asset.url, asset.sourceUrl, ...(asset.references || [])].filter(Boolean).map(normalize);
  for (const file of files) {
    const bytes = readFileSync(file); if (sha(bytes) === asset.digest) findings.push({ kind: 'file-digest', file });
    const text = printable(bytes); if (!text) continue;
    if (needles.some((needle) => normalize(text).includes(needle))) findings.push({ kind: 'literal-or-dynamic-reference', file });
    for (const match of text.matchAll(/data:[^;,]+;base64,([A-Za-z0-9+/=]+)/g)) if (safeDigest(match[1]) === asset.digest) findings.push({ kind: 'data-uri', file });
    for (const match of text.matchAll(/["'`]([A-Za-z0-9+/]{16,}={0,2})["'`]/g)) if (safeDigest(match[1]) === asset.digest) findings.push({ kind: 'base64', file });
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) if (needles.some((needle) => normalize(match[1]).includes(needle))) findings.push({ kind: 'css-url', file });
  }
  const runtimeText = JSON.stringify(runtime); if (runtimeText.includes(asset.digest) || needles.some((needle) => normalize(runtimeText).includes(needle))) findings.push({ kind: 'runtime', file: 'frontend-runtime-report.json' });
  return findings;
}
function normalize(value) { return String(value).replace(/\\/g, '/').replace(/[\s'"`+()]/g, '').toLowerCase(); }
function printable(bytes) { const text = bytes.toString('utf8'); return text.includes('\0') ? '' : text; }
function safeDigest(value) { try { return sha(Buffer.from(value, 'base64')); } catch { return ''; } }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
