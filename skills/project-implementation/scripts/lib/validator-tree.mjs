import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export function treeDigest(root) { const base = resolve(root); const hash = createHash('sha256'); for (const file of walk(base)) hash.update(relative(base, file).replaceAll('\\', '/')).update('\0').update(readFileSync(file)).update('\0'); return hash.digest('hex'); }
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]).sort(); }
