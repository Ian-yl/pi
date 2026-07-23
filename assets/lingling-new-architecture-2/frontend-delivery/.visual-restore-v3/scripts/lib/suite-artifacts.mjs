import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;

function assertSafeId(kind, value) {
  if (!SAFE_ID.test(String(value || ''))) {
    throw new Error(`Invalid ${kind} id: ${value}`);
  }
}

function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicWriteJson(path, value) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temp = join(parent, `.tmp-${randomUUID()}`);
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (error) {
    throw new Error(`Value is not valid JSON: ${error.message}`);
  }
  if (typeof serialized !== 'string') throw new Error('Value is not valid JSON');
  const body = `${serialized}\n`;
  try {
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const fd = openSync(temp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    syncDirectory(parent);
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

export function createRunStaging(root, suiteId, runId) {
  assertSafeId('suite', suiteId);
  assertSafeId('run', runId);
  const projectRoot = resolve(root);
  const runsRoot = ensureSafeDirectoryChain(projectRoot, ['output', 'suites', suiteId, 'runs']);
  const staging = join(runsRoot, `.tmp-${runId}`);
  if (existsSync(staging)) throw new Error(`Run staging already exists: ${runId}`);
  mkdirSync(staging, { mode: 0o700 });
  return staging;
}

function ensureSafeDirectoryChain(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed in suite run path: ${current}`);
      if (!stat.isDirectory()) throw new Error(`Suite run path is not a directory: ${current}`);
    } else {
      mkdirSync(current, { mode: 0o700 });
    }
  }
  return current;
}

function slashPath(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Artifact path escapes root: ${path}`);
  }
  return rel.split(sep).join('/');
}

function walkRegularFiles(root) {
  const base = resolve(root);
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => byteCompare(a.name, b.name))) {
      const path = join(dir, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed in artifact closure: ${slashPath(base, path)}`);
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Special file is not allowed in artifact closure: ${slashPath(base, path)}`);
      files.push({ path, relativePath: slashPath(base, path), size: stat.size });
    }
  };
  visit(base);
  return files.sort((a, b) => byteCompare(a.relativePath, b.relativePath));
}

function byteCompare(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) throw new Error(`Artifact is not a regular file: ${path}`);
    return createHash('sha256').update(readFileSync(fd)).digest('hex');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function buildFileManifest(root) {
  return {
    schemaVersion: '1.0',
    files: walkRegularFiles(root).map((file) => ({
      path: file.relativePath,
      size: file.size,
      sha256: sha256(file.path),
    })),
  };
}

export function verifyFileManifest(root, manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== '1.0' || !Array.isArray(manifest?.files)) {
    return { ok: false, errors: ['invalid artifact manifest'] };
  }

  const declared = new Map();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || file.path.startsWith('/') || file.path.split('/').includes('..')) {
      errors.push(`invalid declared path: ${file?.path}`);
      continue;
    }
    if (declared.has(file.path)) errors.push(`duplicate declared path: ${file.path}`);
    declared.set(file.path, file);
  }

  let actualFiles = [];
  try {
    actualFiles = walkRegularFiles(root);
  } catch (error) {
    errors.push(error.message);
  }
  const actual = new Map(actualFiles.map((file) => [file.relativePath, file]));

  for (const [path, expected] of declared) {
    const found = actual.get(path);
    if (!found) {
      errors.push(`missing declared file: ${path}`);
      continue;
    }
    if (found.size !== expected.size) errors.push(`size mismatch: ${path}`);
    if (sha256(found.path) !== expected.sha256) errors.push(`sha256 mismatch: ${path}`);
  }
  for (const path of actual.keys()) {
    if (!declared.has(path)) errors.push(`undeclared file: ${path}`);
  }
  return { ok: errors.length === 0, errors };
}

export function commitImmutableDirectory(staging, finalDir) {
  const source = resolve(staging);
  const target = resolve(finalDir);
  if (!existsSync(source) || !lstatSync(source).isDirectory()) {
    throw new Error(`Staging directory is missing: ${staging}`);
  }
  if (dirname(source) !== dirname(target)) {
    throw new Error('Staging and final directories must share a parent');
  }
  if (existsSync(target)) throw new Error(`Immutable directory already exists: ${finalDir}`);
  renameSync(source, target);
  syncDirectory(dirname(target));
  return target;
}
