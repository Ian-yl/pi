import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export function treeDigest(root) {
  const base = resolve(root); const hash = createHash('sha256');
  for (const file of walk(base)) hash.update(relative(base, file).replaceAll('\\', '/')).update('\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}

export function localImportClosure(entry, sourceRoot) {
  const root = resolve(sourceRoot); const pending = [resolve(entry)]; const found = new Set();
  while (pending.length) {
    const file = pending.pop(); if (found.has(file)) continue;
    if (!file.startsWith(`${root}/`) || !existsSync(file)) throw new Error(`validator import escapes or is missing: ${file}`);
    found.add(file); const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      const imported = resolve(file, '..', match[1]); const target = existsSync(imported) ? imported : existsSync(`${imported}.mjs`) ? `${imported}.mjs` : null;
      if (!target) throw new Error(`validator local import is missing: ${match[1]} from ${file}`);
      pending.push(target);
    }
  }
  return [...found].sort();
}

function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]).sort(); }
