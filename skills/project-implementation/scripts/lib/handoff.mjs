import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export function digestJSON(value) { return sha(Buffer.from(canonical(value), 'utf8')); }
export function sha(value) { return createHash('sha256').update(value).digest('hex'); }
export function hashDirectory(root) { const base = resolve(root); return digestJSON(walk(base).map((file) => ({ path: file.slice(base.length + 1), size: statSync(file).size, sha256: sha(readFileSync(file)) }))); }
export function releaseDigest(manifest) { const copy = { ...manifest }; delete copy.releaseDigest; return digestJSON(copy); }
function canonical(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; }
function walk(root) { return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${root}/${entry.name}`) : [`${root}/${entry.name}`]).sort(); }
