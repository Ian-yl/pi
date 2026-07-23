import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export function acquirePageOutputLock({
  root = process.cwd(),
  page,
  suiteId = null,
  runId = null,
  token = null,
} = {}) {
  const projectRoot = resolve(root);
  const pageName = safePage(page);
  const requestedToken = token === null ? null : safeToken(token);
  const locksRoot = ensureSafeDirectoryChain(projectRoot, ['output', '.locks', 'pages']);
  const lockId = createHash('sha256').update(pageName, 'utf8').digest('hex');
  const lockDir = join(locksRoot, lockId);

  try {
    mkdirSync(lockDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const owner = readOwner(lockDir);
    if (requestedToken && owner?.token === requestedToken && owner?.page === pageName) {
      return lease({ lockDir, page: pageName, token: requestedToken, borrowed: true });
    }
    const locked = new Error(`page output is already locked: ${pageName}`);
    locked.code = 'PAGE_OUTPUT_LOCKED';
    locked.owner = owner;
    throw locked;
  }

  const leaseToken = requestedToken ?? randomUUID();
  const owner = {
    schemaVersion: '1.0',
    page: pageName,
    token: leaseToken,
    pid: process.pid,
    suiteId,
    runId,
    acquiredAt: new Date().toISOString(),
  };
  try {
    writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }
  return lease({ lockDir, page: pageName, token: leaseToken, borrowed: false });
}

export function acquirePageOutputLocks({
  root = process.cwd(),
  pages,
  suiteId = null,
  runId = null,
  token = randomUUID(),
} = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('pages are required for output locking');
  const pageNames = [...new Set(pages.map((page) => safePage(page?.name || page)))].sort(byteCompare);
  const leases = [];
  try {
    for (const page of pageNames) {
      leases.push(acquirePageOutputLock({ root, page, suiteId, runId, token }));
    }
  } catch (error) {
    for (const held of [...leases].reverse()) held.release();
    throw error;
  }
  let released = false;
  return {
    token,
    pages: pageNames,
    release() {
      if (released) return;
      released = true;
      for (const held of [...leases].reverse()) held.release();
    },
  };
}

function lease({ lockDir, page, token, borrowed }) {
  let released = false;
  return {
    page,
    token,
    borrowed,
    release() {
      if (released) return;
      released = true;
      if (borrowed || !existsSync(lockDir)) return;
      const stat = lstatSync(lockDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`page output lock was replaced: ${page}`);
      }
      const owner = readOwner(lockDir);
      if (owner?.token !== token || owner?.page !== page) {
        throw new Error(`page output lock ownership changed: ${page}`);
      }
      rmSync(lockDir, { recursive: true, force: false });
    },
  };
}

function readOwner(lockDir) {
  const ownerPath = join(lockDir, 'owner.json');
  try {
    const stat = lstatSync(ownerPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return JSON.parse(readFileSync(ownerPath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureSafeDirectoryChain(root, segments) {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('project root for page output locks must be a real directory');
  }
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in page output lock path: ${segment}`);
      if (!stat.isDirectory()) throw new Error(`page output lock path is not a directory: ${segment}`);
    } else {
      mkdirSync(current, { mode: 0o700 });
    }
  }
  return current;
}

function safePage(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..'
      || /[\\/\0\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`invalid page id for output lock: ${value}`);
  }
  return value;
}

function safeToken(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{8,160}$/.test(value)) {
    throw new Error('invalid page output lock token');
  }
  return value;
}

function byteCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
