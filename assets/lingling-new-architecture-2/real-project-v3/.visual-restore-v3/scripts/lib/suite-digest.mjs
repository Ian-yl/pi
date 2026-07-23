import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import { resolveCaptureTargetMode } from './capture-target-mode.mjs';
import { normalizeSuitePlan } from './suite-config.mjs';

export function canonicalJSONStringify(value) {
  return canonicalize(value, new Set(), '$');
}

export function digestJSON(value) {
  return sha256(Buffer.from(canonicalJSONStringify(value), 'utf8'));
}

export function hashFiles(root, paths) {
  const projectRoot = resolve(root);
  if (!Array.isArray(paths)) throw new Error('paths must be an array');
  const normalized = paths.map((path, index) => normalizeProjectPath(path, `paths[${index}]`));
  const seen = new Set();
  for (const path of normalized) {
    if (seen.has(path)) throw new Error(`duplicate file path: ${path}`);
    seen.add(path);
  }

  return normalized.sort().map((path) => {
    const file = resolveRegularFile(projectRoot, path);
    const fd = openNoFollow(file, path);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
      const bytes = readFileSync(fd);
      return {
        path,
        sha256: sha256(bytes),
        bytes: bytes.length,
      };
    } finally {
      closeSync(fd);
    }
  });
}

export function buildSuiteInputSnapshot(plan, { root = process.cwd() } = {}) {
  const projectRoot = resolve(root);
  const normalizedPlan = normalizeSuitePlan(plan, {
    root: projectRoot,
    suiteId: plan?.suiteId,
  });
  const inputs = new Set([
    ...normalizedPlan.shared.sources,
    ...normalizedPlan.publication.include,
  ]);
  const publicationPaths = new Set(normalizedPlan.publication.include);
  const captureIdentities = new Map();
  const requiredCaptureOwners = new Map();
  const requiredAssetOwners = new Map();

  for (const page of normalizedPlan.pages) {
    const restorePlanPath = `pages/${page.name}/restore-plan.json`;
    inputs.add(restorePlanPath);
    const restorePlan = readJSONRegularFile(projectRoot, restorePlanPath);
    if (!restorePlan || typeof restorePlan !== 'object' || Array.isArray(restorePlan)) {
      throw new Error(`${restorePlanPath} must contain a JSON object`);
    }
    if (restorePlan.name !== undefined && restorePlan.name !== page.name) {
      throw new Error(`${restorePlanPath} name does not match suite page ${page.name}`);
    }
    inputs.add(normalizeProjectPath(restorePlan.source, `${restorePlanPath}.source`));
    const capturePath = normalizeProjectPath(
      restorePlan.capture?.path,
      `${restorePlanPath}.capture.path`,
    );
    const captureAdapter = normalizeCaptureMode(
      restorePlan.capture?.adapter,
      restorePlan.capture?.url,
      `${restorePlanPath}.capture.adapter`,
    );
    const captureTarget = normalizeCaptureTarget(
      restorePlan.capture?.url ?? `/pages/${page.name}/index.html`,
      `${restorePlanPath}.capture.url`,
    );
    const captureIdentity = `${captureAdapter}\0${capturePath}\0${captureTarget}`;
    const existingPage = captureIdentities.get(captureIdentity);
    if (existingPage) {
      throw new Error(
        `duplicate capture identity: pages ${existingPage} and ${page.name} resolve to `
        + `(${captureAdapter}, ${capturePath}, ${captureTarget || '<no route>'})`,
      );
    }
    captureIdentities.set(captureIdentity, page.name);
    inputs.add(capturePath);
    if (page.required) {
      const owners = requiredCaptureOwners.get(capturePath) ?? [];
      owners.push(page.name);
      requiredCaptureOwners.set(capturePath, owners);
    }
    if (restorePlan.capture?.watch !== undefined) {
      if (!Array.isArray(restorePlan.capture.watch)) {
        throw new Error(`${restorePlanPath}.capture.watch must be an array`);
      }
      for (const [index, path] of restorePlan.capture.watch.entries()) {
        inputs.add(normalizeProjectPath(path, `${restorePlanPath}.capture.watch[${index}]`));
      }
    }

    const contentManifestPath = `pages/${page.name}/content-manifest.json`;
    if (pathEntryExists(projectRoot, contentManifestPath)) inputs.add(contentManifestPath);

    const assetPlanPath = `pages/${page.name}/asset-plan.json`;
    if (pathEntryExists(projectRoot, assetPlanPath)) {
      inputs.add(assetPlanPath);
      if (page.required) {
        const assetPlan = readJSONRegularFile(projectRoot, assetPlanPath);
        const assets = assetPlan?.assets ?? [];
        if (!Array.isArray(assets)) throw new Error(`${assetPlanPath}.assets must be an array`);
        for (const [index, asset] of assets.entries()) {
          if (asset?.output === undefined) continue;
          const output = normalizeProjectPath(
            asset.output,
            `${assetPlanPath}.assets[${index}].output`,
          );
          const owners = requiredAssetOwners.get(output) ?? [];
          owners.push(page.name);
          requiredAssetOwners.set(output, owners);
          inputs.add(output);
        }
      }
    }
  }

  for (const [path, pages] of requiredCaptureOwners) {
    if (!publicationPaths.has(path)) {
      throw new Error(
        `publication.include must contain required page ${pages.join(', ')} capture.path: ${path}`,
      );
    }
  }
  for (const path of normalizedPlan.shared.sources) {
    if (path.toLowerCase().endsWith('.css') && !publicationPaths.has(path)) {
      throw new Error(`publication.include must contain shared CSS runtime source: ${path}`);
    }
  }
  for (const [path, pages] of requiredAssetOwners) {
    if (!publicationPaths.has(path)) {
      throw new Error(
        `publication.include must contain required page ${pages.join(', ')} declared asset: ${path}`,
      );
    }
  }

  const files = hashFiles(projectRoot, [...inputs]);
  const hashedPaths = new Set(files.map((entry) => entry.path));
  for (const path of requiredCaptureOwners.keys()) {
    if (!hashedPaths.has(path)) {
      throw new Error(`required page capture.path was not hashed: ${path}`);
    }
  }
  for (const path of requiredAssetOwners.keys()) {
    if (!hashedPaths.has(path)) throw new Error(`required page declared asset was not hashed: ${path}`);
  }
  const snapshot = {
    schemaVersion: '1.0',
    suiteId: normalizedPlan.suiteId,
    planDigest: digestJSON(normalizedPlan),
    files,
  };
  return {
    ...snapshot,
    inputDigest: digestJSON(snapshot),
  };
}

export function computePageClosureDigest(plan, pageName, { root = process.cwd() } = {}) {
  const projectRoot = resolve(root);
  const normalizedPlan = normalizeSuitePlan(plan, {
    root: projectRoot,
    suiteId: plan?.suiteId,
  });
  const page = normalizedPlan.pages.find((entry) => entry.name === pageName);
  if (!page) throw new Error(`suite plan does not contain page: ${pageName}`);

  const pageDirectory = `pages/${page.name}`;
  const inputs = new Set(normalizedPlan.shared.sources);
  for (const path of listPageClosureFiles(projectRoot, pageDirectory)) inputs.add(path);

  const restorePlanPath = `${pageDirectory}/restore-plan.json`;
  const restorePlan = readJSONRegularFile(projectRoot, restorePlanPath);
  inputs.add(restorePlanPath);
  inputs.add(normalizeProjectPath(restorePlan?.source, `${restorePlanPath}.source`));
  inputs.add(normalizeProjectPath(restorePlan?.capture?.path, `${restorePlanPath}.capture.path`));
  if (restorePlan?.capture?.watch !== undefined) {
    if (!Array.isArray(restorePlan.capture.watch)) {
      throw new Error(`${restorePlanPath}.capture.watch must be an array`);
    }
    for (const [index, path] of restorePlan.capture.watch.entries()) {
      inputs.add(normalizeProjectPath(path, `${restorePlanPath}.capture.watch[${index}]`));
    }
  }

  const missing = new Set();
  const assetPlanPath = `${pageDirectory}/asset-plan.json`;
  if (pathEntryExists(projectRoot, assetPlanPath)) {
    const assetPlan = readJSONRegularFile(projectRoot, assetPlanPath);
    const assets = assetPlan?.assets ?? [];
    if (!Array.isArray(assets)) throw new Error(`${assetPlanPath}.assets must be an array`);
    for (const [index, asset] of assets.entries()) {
      if (asset?.output === undefined) continue;
      const output = normalizeProjectPath(asset.output, `${assetPlanPath}.assets[${index}].output`);
      if (pathEntryExists(projectRoot, output)) inputs.add(output);
      else missing.add(output);
    }
  }

  return digestJSON({
    schemaVersion: '1.0',
    suiteId: normalizedPlan.suiteId,
    page: page.name,
    planDigest: digestJSON(normalizedPlan),
    files: hashFiles(projectRoot, [...inputs]),
    missing: [...missing].sort(),
  });
}

function listPageClosureFiles(projectRoot, directory) {
  const base = resolve(projectRoot, directory);
  let stat;
  try {
    stat = lstatSync(base);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`page directory does not exist: ${directory}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${directory}`);
  if (!stat.isDirectory()) throw new Error(`page directory is not a directory: ${directory}`);
  const files = [];
  const visit = (physicalDirectory, relativeDirectory) => {
    const entries = readdirSync(physicalDirectory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = resolve(physicalDirectory, entry.name);
      const relativePath = `${relativeDirectory}/${entry.name}`;
      const entryStat = lstatSync(path);
      if (entryStat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${relativePath}`);
      if (entryStat.isDirectory()) visit(path, relativePath);
      else if (entryStat.isFile()) files.push(relativePath);
      else throw new Error(`not a regular file: ${relativePath}`);
    }
  };
  visit(base, directory);
  return files;
}

function normalizeCaptureMode(value, url, label) {
  const adapter = value === undefined ? 'static' : value;
  if (typeof adapter !== 'string' || !adapter.trim()) throw new Error(`${label} must be a non-empty string`);
  return resolveCaptureTargetMode({ adapter, url });
}

function normalizeCaptureTarget(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const target = value.trim();
  if (!target) return '';
  if (/^https?:\/\//i.test(target)) {
    try {
      return new URL(target).href;
    } catch (error) {
      throw new Error(`${label} must be a valid URL: ${error.message}`);
    }
  }
  return target;
}

function canonicalize(value, ancestors, path) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} is not a JSON value`);
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error(`${path} is not a JSON value`);
  if (ancestors.has(value)) throw new Error(`${path} contains a JSON cycle`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error(`${path}[${index}] is not a JSON value`);
        entries.push(canonicalize(value[index], ancestors, `${path}[${index}]`));
      }
      return `[${entries.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} is not a JSON value`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`${path} is not a JSON value`);
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors, `${path}.${key}`)}`);
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function readJSONRegularFile(projectRoot, path) {
  const file = resolveRegularFile(projectRoot, path);
  const fd = openNoFollow(file, path);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
    try {
      return JSON.parse(readFileSync(fd, 'utf8'));
    } catch (error) {
      throw new Error(`invalid JSON in ${path}: ${error.message}`);
    }
  } finally {
    closeSync(fd);
  }
}

function pathEntryExists(projectRoot, path) {
  const file = resolveWithinRoot(projectRoot, normalizeProjectPath(path, 'optional input'));
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function resolveRegularFile(projectRoot, path) {
  const normalized = normalizeProjectPath(path, 'file path');
  const file = resolveWithinRoot(projectRoot, normalized);
  let current = projectRoot;
  for (const segment of normalized.split('/')) {
    current = resolve(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`file does not exist: ${normalized}`);
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${normalized}`);
  }
  const finalStat = lstatSync(file);
  if (!finalStat.isFile()) throw new Error(`not a regular file: ${normalized}`);
  return file;
}

function openNoFollow(file, path) {
  try {
    return openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new Error(`cannot open regular file ${path}: ${error.message}`);
  }
}

function normalizeProjectPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a relative path`);
  const path = value.trim();
  if (
    isAbsolute(path)
    || /^[a-zA-Z]:[\\/]/.test(path)
    || path.startsWith('\\\\')
    || path.includes('\\')
    || path.includes('\0')
  ) {
    throw new Error(`${label} must be a safe project-relative path`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  const normalized = posix.normalize(path);
  if (normalized !== path) throw new Error(`${label} must be a normalized relative path`);
  return normalized;
}

function resolveWithinRoot(projectRoot, path) {
  const target = resolve(projectRoot, path);
  const fromRoot = relative(projectRoot, target);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${posix.sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`file path escapes the project root: ${path}`);
  }
  return target;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
