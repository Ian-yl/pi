import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCaptureTargetMode } from './capture-target-mode.mjs';

const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function buildRunManifest(name, config, { root = config?.root || ROOT } = {}) {
  const paths = new Set();
  addIfExists(paths, config?.sourcePath);
  addIfExists(paths, config?.planPath);
  collectFiles(join(root, 'pages', name), paths);
  collectPath(resolve(root, config?.capture?.path || ''), paths);
  const watched = config?.capture?.watch?.length
    ? config.capture.watch
    : defaultWatchPaths(config, root);
  for (const path of watched) collectPath(resolve(root, path), paths);
  collectFiles(TOOL_ROOT, paths);
  for (const file of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) {
    addIfExists(paths, join(root, file));
  }

  const files = [...paths]
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .map((path) => fileRecord(path, root))
    .sort((a, b) => a.path.localeCompare(b.path));
  const digest = createHash('sha256')
    .update(files.map((file) => `${file.path}:${file.sha256}`).join('\n'))
    .digest('hex');

  return {
    version: 1,
    name,
    generatedAt: new Date().toISOString(),
    digest,
    files,
  };
}

export function compareRunManifest(recorded, current) {
  if (!recorded?.files || !recorded?.digest) {
    return { fresh: false, errors: ['missing or invalid run-manifest.json'], changed: [] };
  }
  const before = new Map(recorded.files.map((file) => [file.path, file]));
  const after = new Map(current.files.map((file) => [file.path, file]));
  const changed = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    if (!oldFile) changed.push({ path, kind: 'added' });
    else if (!newFile) changed.push({ path, kind: 'removed' });
    else if (oldFile.sha256 !== newFile.sha256) changed.push({ path, kind: 'changed' });
  }
  return {
    fresh: changed.length === 0 && recorded.digest === current.digest,
    errors: changed.length ? [`audit artifacts are stale: ${changed.length} input file(s) changed`] : [],
    changed,
  };
}

function fileRecord(path, root) {
  const data = readFileSync(path);
  const stat = statSync(path);
  return {
    path: relative(root, path),
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

function collectFiles(dir, target) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(path, target);
    else target.add(path);
  }
}

function collectPath(path, target) {
  if (!path || !existsSync(path)) return;
  if (statSync(path).isDirectory()) collectFiles(path, target);
  else target.add(path);
}

function defaultWatchPaths(config, root) {
  if (resolveCaptureTargetMode(config?.capture) !== 'external') return [];
  return ['src', 'app', 'public']
    .filter((path) => existsSync(join(root, path)));
}

function addIfExists(target, path) {
  if (path && existsSync(path)) target.add(path);
}
