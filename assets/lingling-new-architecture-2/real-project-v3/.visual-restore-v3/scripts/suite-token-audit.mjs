import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function selectSharedTokenSources(planOrSources = {}) {
  const sources = Array.isArray(planOrSources)
    ? planOrSources
    : planOrSources?.shared?.sources || [];
  return unique(sources
    .filter((source) => typeof source === 'string')
    .map(normalizeProjectPath)
    .filter((source) => source && extname(source).toLowerCase() === '.css')
    .filter((source) => /(?:^|[._-])tokens?(?:[._-]|$)/i.test(posix.basename(source, '.css'))))
    .sort(byteCompare);
}

export function extractPageDependencies({
  page = '',
  entryPath = '',
  files = {},
  sharedTokenSources = [],
} = {}) {
  const fileMap = normalizeSourceFileMap(files);
  const normalizedEntryPath = normalizeProjectPath(entryPath);
  const tokenSources = unique(sharedTokenSources.map(normalizeProjectPath).filter(Boolean)).sort(byteCompare);
  const tokenSourceSet = new Set(tokenSources);
  const pending = normalizedEntryPath ? [normalizedEntryPath] : [];
  const visited = new Set();
  const referenceKeys = new Set();
  const references = [];

  while (pending.length) {
    const from = pending.shift();
    if (visited.has(from)) continue;
    visited.add(from);
    const text = fileMap.get(from);
    if (typeof text !== 'string') continue;

    const discovered = extractSourceReferences(text, from, fileMap, tokenSourceSet);
    for (const reference of discovered) {
      const key = `${reference.from}\0${reference.resolved}\0${reference.kind}`;
      if (referenceKeys.has(key)) continue;
      referenceKeys.add(key);
      references.push(reference);
      if (fileMap.has(reference.resolved) && !visited.has(reference.resolved)) {
        pending.push(reference.resolved);
      }
    }
  }

  references.sort((left, right) => (
    byteCompare(left.from, right.from) ||
    byteCompare(left.resolved, right.resolved) ||
    byteCompare(left.kind, right.kind)
  ));
  const consumed = tokenSources.filter((source) => (
    source === normalizedEntryPath || references.some((reference) => reference.resolved === source)
  ));
  return {
    page: String(page),
    entryPath: normalizedEntryPath,
    references,
    consumedSharedTokenSources: consumed,
  };
}

function normalizeSourceFileMap(files) {
  const entries = files instanceof Map ? [...files] : Object.entries(files || {});
  return new Map(entries
    .map(([path, text]) => [normalizeProjectPath(path), String(text ?? '')])
    .filter(([path]) => Boolean(path)));
}

function extractSourceReferences(text, from, fileMap, tokenSourceSet) {
  const candidates = [];
  const extension = posix.extname(from).toLowerCase();
  if (extension === '.html' || extension === '.htm') {
    const html = String(text).replace(/<!--[\s\S]*?-->/g, ' ');
    for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
      const rel = htmlAttribute(tag, 'rel').toLowerCase().split(/\s+/).filter(Boolean);
      const href = htmlAttribute(tag, 'href');
      if (href && rel.includes('stylesheet')) {
        candidates.push({ specifier: href, kind: 'html-link' });
      }
    }
    for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
      candidates.push(...extractCssImportCandidates(match[1]));
    }
  } else if (extension === '.css') {
    candidates.push(...extractCssImportCandidates(text));
  }

  const resolved = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const path = resolveSourceReference(candidate.specifier, from, fileMap, tokenSourceSet);
    if (!path) continue;
    const key = `${path}\0${candidate.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({
      from,
      specifier: String(candidate.specifier),
      resolved: path,
      kind: candidate.kind,
    });
  }
  return resolved;
}

function extractCssImportCandidates(text) {
  const candidates = [];
  const source = stripCssComments(String(text || ''));
  const importPattern = /@import\s+(?:url\(\s*)?(?:(["'])(.*?)\1|([^'"\)\s;]+))\s*\)?/gi;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[2] || match[3];
    if (specifier) candidates.push({ specifier, kind: 'css-import' });
  }
  return candidates;
}

function htmlAttribute(tag, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\b${escapedName}\\s*=\\s*(?:(["'])(.*?)\\1|([^\\s>]+))`, 'i'));
  return match?.[2] || match?.[3] || '';
}

function resolveSourceReference(specifier, from, fileMap, tokenSourceSet) {
  const raw = String(specifier || '').trim().replace(/[?#].*$/, '');
  if (!raw || raw.startsWith('#') || raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return '';
  }
  const normalizedRaw = normalizeProjectPath(raw.replace(/^\//, ''));
  if (normalizedRaw && (tokenSourceSet.has(normalizedRaw) || fileMap.has(normalizedRaw))) {
    return normalizedRaw;
  }
  const relative = normalizeProjectPath(posix.join(posix.dirname(from), raw));
  if (!relative) return '';
  return relative;
}

function normalizeProjectPath(value) {
  const normalized = posix.normalize(String(value || '').replaceAll('\\', '/').replace(/^\.\//, ''));
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return '';
  return normalized.replace(/^\//, '');
}

function byteCompare(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

export function extractCSSCustomProperties(css) {
  const source = stripCssComments(String(css || ''));
  const properties = {};
  let blockDepth = 0;
  let declarationStart = 0;
  let quote = '';
  let escaped = false;
  let parentheses = 0;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') {
      parentheses++;
      continue;
    }
    if (character === ')') {
      parentheses = Math.max(0, parentheses - 1);
      continue;
    }
    if (parentheses > 0) continue;

    if (character === '{') {
      blockDepth++;
      declarationStart = index + 1;
    } else if (character === ';' && blockDepth > 0) {
      recordCustomProperty(source.slice(declarationStart, index), properties);
      declarationStart = index + 1;
    } else if (character === '}' && blockDepth > 0) {
      recordCustomProperty(source.slice(declarationStart, index), properties);
      blockDepth--;
      declarationStart = index + 1;
    }
  }
  return properties;
}

export function buildTokenAuditInputs(plan, {
  root = process.cwd(),
  runDir = null,
} = {}) {
  const projectRoot = resolve(root);
  const sharedTokenSources = selectSharedTokenSources(plan);
  const sharedSourceSet = new Set((plan?.shared?.sources || []).map(normalizeProjectPath).filter(Boolean));
  const sourcePaths = new Set([
    ...(plan?.shared?.sources || []),
    ...(plan?.publication?.include || []),
  ].map(normalizeProjectPath).filter(Boolean));
  const entries = new Map();

  for (const entry of plan?.pages || []) {
    const page = String(entry?.name || entry?.id || entry);
    const restorePlanPath = join(projectRoot, 'pages', page, 'restore-plan.json');
    let entryPath = `pages/${page}/index.html`;
    if (existsSync(restorePlanPath)) {
      const restorePlan = JSON.parse(readFileSync(restorePlanPath, 'utf8'));
      entryPath = normalizeProjectPath(restorePlan.capture?.path || entryPath);
      sourcePaths.add(entryPath);
      for (const path of restorePlan.capture?.watch || []) {
        const normalized = normalizeProjectPath(path);
        if (normalized) sourcePaths.add(normalized);
      }
    }
    entries.set(page, entryPath);
  }

  const files = {};
  for (const path of [...sourcePaths].sort(byteCompare)) {
    if (!['.css', '.html', '.htm'].includes(extname(path).toLowerCase())) continue;
    const physicalPath = join(projectRoot, ...path.split('/'));
    if (existsSync(physicalPath)) files[path] = readFileSync(physicalPath, 'utf8');
  }
  if (runDir) {
    for (const page of entries.keys()) {
      const sourceDir = [join(runDir, page), join(runDir, 'pages', page)]
        .find((directory) => existsSync(directory));
      if (sourceDir) collectPageSourceFiles(sourceDir, `pages/${page}`, files);
    }
  }

  const sharedTokenText = sharedTokenSources.map((source) => {
    if (files[source] !== undefined) return files[source];
    const physicalPath = join(projectRoot, ...source.split('/'));
    if (!existsSync(physicalPath)) throw new Error(`shared CSS source not found: ${source}`);
    return readFileSync(physicalPath, 'utf8');
  }).join('\n');
  const pageDependencies = {};
  const pageTokenMaps = {};
  for (const [page, entryPath] of entries) {
    const dependency = extractPageDependencies({
      page,
      entryPath,
      files,
      sharedTokenSources,
    });
    pageDependencies[page] = dependency;
    const localPaths = new Set([
      entryPath,
      ...dependency.references.map((reference) => reference.resolved),
    ]);
    const localText = [...localPaths]
      .filter((path) => files[path] !== undefined && !sharedSourceSet.has(path))
      .map((path) => files[path])
      .join('\n');
    pageTokenMaps[page] = extractCSSCustomProperties(localText);
  }
  return {
    sharedTokenSources,
    sharedTokenText,
    pageTokenMaps,
    pageDependencies,
  };
}

export function evaluateTokenConsistency({
  plan,
  sharedTokenText,
  pageTokenMaps,
  pageDependencies,
} = {}) {
  const sharedTokens = typeof sharedTokenText === 'string'
    ? extractCSSCustomProperties(sharedTokenText)
    : normalizeTokenMap(sharedTokenText);
  const pages = normalizePageTokenMaps(pageTokenMaps);
  const plannedPages = (plan?.pages || []).map((page) => String(page?.name || page?.id || page)).filter(Boolean);
  const pageNames = unique([...plannedPages, ...pages.keys()]);
  const requiredByPage = pageRequirementMap(plan, pageNames);
  const declaredTokens = declaredTokenNames(plan);
  const declaredTokenSet = new Set(declaredTokens);
  const sharedTokenSources = selectSharedTokenSources(plan);
  const dependencies = normalizePageDependencies(pageDependencies);
  const tokenNames = unique([
    ...Object.keys(sharedTokens),
    ...declaredTokens,
    ...[...pages.values()].flatMap((tokens) => Object.keys(tokens)),
  ]).sort();
  const checks = [];
  const findings = [];

  if (sharedTokenSources.length) {
    for (const page of plannedPages) {
      const consumed = dependencies.get(page) || [];
      const selected = consumed.filter((source) => sharedTokenSources.includes(source));
      const required = requiredByPage.get(page) !== false;
      if (selected.length) {
        checks.push(tokenDependencyCheck(page, 'pass', {
          selectedSharedTokenSources: sharedTokenSources,
          consumedSharedTokenSources: selected,
        }));
      } else {
        const advisory = !required;
        checks.push(tokenDependencyCheck(page, advisory ? 'advisory' : 'fail', {
          selectedSharedTokenSources: sharedTokenSources,
          consumedSharedTokenSources: [],
        }));
        findings.push(tokenDependencyFinding(page, {
          severity: advisory ? 'P2' : 'P1',
          advisory,
          selectedSharedTokenSources: sharedTokenSources,
          consumedSharedTokenSources: [],
        }));
      }
    }
  }

  for (const token of tokenNames) {
    if (!Object.hasOwn(sharedTokens, token)) {
      const affectedPages = pageNames.filter((page) => Object.hasOwn(pages.get(page) || {}, token));
      const advisory = !declaredTokenSet.has(token) && affectedPages.length > 0 &&
        affectedPages.every((page) => requiredByPage.get(page) === false);
      checks.push(tokenCheck(null, token, 'shared', advisory ? 'advisory' : 'fail', {
        expected: 'shared token declaration',
        actual: 'missing',
        affectedPages,
      }));
      findings.push(tokenFinding(null, token, 'shared-token-missing', {
        expected: 'shared token declaration',
        actual: 'missing',
        affectedPages,
        severity: advisory ? 'P2' : 'P1',
        advisory,
      }));
      continue;
    }
    checks.push(tokenCheck(null, token, 'shared', 'pass', { actual: sharedTokens[token] }));

    for (const page of pageNames) {
      const pageTokens = pages.get(page) || {};
      if (!Object.hasOwn(pageTokens, token)) {
        checks.push(tokenCheck(page, token, 'inheritance', 'pass', {
          expected: sharedTokens[token],
          actual: 'inherited',
        }));
        continue;
      }
      const actual = normalizeTokenValue(pageTokens[token]);
      const expected = normalizeTokenValue(sharedTokens[token]);
      if (actual === expected) {
        checks.push(tokenCheck(page, token, 'override', 'pass', { expected, actual }));
      } else if (tokenVariantAllowed(plan, page, token)) {
        checks.push(tokenCheck(page, token, 'override', 'allowed', { expected, actual }));
      } else {
        const advisory = requiredByPage.get(page) === false;
        checks.push(tokenCheck(page, token, 'override', advisory ? 'advisory' : 'fail', {
          expected,
          actual,
        }));
        findings.push(tokenFinding(page, token, 'page-token-drift', {
          expected,
          actual,
          severity: advisory ? 'P2' : 'P1',
          advisory,
        }));
      }
    }
  }

  const warnings = findings.filter((finding) => finding.advisory === true);

  return {
    pass: findings.every((finding) => finding.advisory === true),
    sharedTokens,
    sharedTokenSources,
    pageTokenMaps: Object.fromEntries(pages),
    pageDependencies: Object.fromEntries(dependencies),
    checks,
    findings,
    warnings,
    summary: {
      tokens: tokenNames.length,
      pages: pageNames.length,
      checks: checks.length,
      passed: checks.filter((check) => check.status === 'pass').length,
      allowed: checks.filter((check) => check.status === 'allowed').length,
      failed: checks.filter((check) => check.status === 'fail').length,
      advisory: checks.filter((check) => check.status === 'advisory').length,
      findings: findings.length,
      warnings: warnings.length,
    },
  };
}

export async function runSuiteTokenAuditCli(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const planPath = resolveRequiredPath(options.plan, '--plan');
  const runDir = resolveRequiredPath(options['run-dir'], '--run-dir');
  const outPath = resolveRequiredPath(options.out, '--out');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const inputs = buildTokenAuditInputs(plan, {
    root: inferProjectRoot(planPath),
    runDir,
  });
  const result = evaluateTokenConsistency({
    plan,
    ...inputs,
  });
  writeJsonAtomic(outPath, result);
  process.stdout.write(`suite tokens: ${result.pass ? 'PASS' : 'FAIL'} (${result.findings.length} findings) -> ${outPath}\n`);
  return result.pass ? 0 : 2;
}

function stripCssComments(source) {
  let output = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++;
      index++;
      output += ' ';
      continue;
    }
    output += character;
  }
  return output;
}

function recordCustomProperty(declaration, target) {
  const trimmed = declaration.trim();
  if (!trimmed.startsWith('--')) return;
  const colon = declarationColon(trimmed);
  if (colon < 0) return;
  const name = trimmed.slice(0, colon).trim();
  if (!/^--[-_a-zA-Z0-9]+$/.test(name)) return;
  const value = trimmed.slice(colon + 1).trim();
  if (value) target[name] = value;
}

function declarationColon(value) {
  let quote = '';
  let escaped = false;
  let parentheses = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') parentheses++;
    else if (character === ')') parentheses = Math.max(0, parentheses - 1);
    else if (character === ':' && parentheses === 0) return index;
  }
  return -1;
}

function declaredTokenNames(plan) {
  const declarations = [
    ...(plan?.tokens?.required || []),
    ...(plan?.shared?.tokens?.required || []),
    ...(plan?.tokenContract?.required || []),
  ];
  return unique(declarations.map((entry) => String(entry?.name || entry)).filter((name) => name.startsWith('--')));
}

function tokenVariantAllowed(plan, page, token) {
  const variants = [
    ...(plan?.tokens?.allowedVariants || []),
    ...(plan?.shared?.tokens?.allowedVariants || []),
    ...(plan?.tokenContract?.allowedVariants || []),
    ...(plan?.shared?.components || []).flatMap((component) => component?.allowedVariants || []),
  ];
  return variants.some((variant) => {
    const pageMatches = String(variant?.page || '') === page || variant?.pages?.map(String).includes(page);
    const tokenMatches = (variant?.tokens || variant?.properties || []).map(String).includes(token) ||
      variant?.token === token;
    return pageMatches && tokenMatches;
  });
}

function normalizePageTokenMaps(value) {
  const entries = value instanceof Map ? [...value] : Object.entries(value || {});
  return new Map(entries.map(([page, tokens]) => [String(page), typeof tokens === 'string'
    ? extractCSSCustomProperties(tokens)
    : normalizeTokenMap(tokens)]));
}

function pageRequirementMap(plan, pageNames) {
  const result = new Map(pageNames.map((page) => [String(page), true]));
  for (const entry of plan?.pages || []) {
    const page = String(entry?.name || entry?.id || entry);
    result.set(page, typeof entry === 'object' ? entry?.required !== false : true);
  }
  return result;
}

function normalizePageDependencies(value) {
  const entries = value instanceof Map ? [...value] : Object.entries(value || {});
  return new Map(entries.map(([page, evidence]) => {
    const sources = Array.isArray(evidence)
      ? evidence
      : evidence?.consumedSharedTokenSources || [];
    return [
      String(page),
      unique(sources.map(normalizeProjectPath).filter(Boolean)).sort(byteCompare),
    ];
  }));
}

function normalizeTokenMap(value) {
  return Object.fromEntries(Object.entries(value || {})
    .filter(([name]) => String(name).startsWith('--'))
    .map(([name, tokenValue]) => [String(name), normalizeTokenValue(tokenValue)]));
}

function normalizeTokenValue(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function unique(values) {
  return [...new Set(values)];
}

function tokenCheck(page, token, kind, status, extra = {}) {
  return {
    id: `token:${page || 'shared'}:${token}:${kind}`,
    scope: 'token',
    page,
    token,
    kind,
    status,
    ...extra,
  };
}

function tokenDependencyCheck(page, status, extra = {}) {
  return {
    id: `token:${page}:shared-source-consumption`,
    scope: 'token',
    page,
    token: null,
    kind: 'shared-source-consumption',
    status,
    ...extra,
  };
}

function tokenFinding(page, token, code, extra = {}) {
  return {
    id: `suite-token:${code}:${page || 'shared'}:${token}`,
    detector: 'suite-token-audit',
    scope: 'token',
    page,
    token,
    code,
    severity: 'P1',
    advisory: false,
    status: 'open',
    ...extra,
  };
}

function tokenDependencyFinding(page, extra = {}) {
  return {
    id: `suite-token:shared-token-source-not-consumed:${page}`,
    detector: 'suite-token-audit',
    scope: 'token',
    page,
    token: null,
    code: 'shared-token-source-not-consumed',
    severity: 'P1',
    advisory: false,
    status: 'open',
    ...extra,
  };
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    const equal = argument.indexOf('=');
    if (equal >= 0) options[argument.slice(2, equal)] = argument.slice(equal + 1);
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
      options[argument.slice(2)] = value;
    }
  }
  return options;
}

function resolveRequiredPath(value, option) {
  if (!value) throw new Error(`${option} is required`);
  return resolve(value);
}

function collectPageSourceFiles(directory, logicalDirectory, files) {
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => byteCompare(left.name, right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const physicalPath = join(directory, entry.name);
    const logicalPath = posix.join(logicalDirectory, entry.name);
    if (entry.isDirectory()) {
      collectPageSourceFiles(physicalPath, logicalPath, files);
    } else if (entry.isFile() && ['.css', '.html'].includes(extname(entry.name).toLowerCase())) {
      files[logicalPath] = readFileSync(physicalPath, 'utf8');
    }
  }
}

function inferProjectRoot(planPath) {
  const suiteDirectory = dirname(planPath);
  const suitesDirectory = dirname(suiteDirectory);
  return basename(suitesDirectory) === 'suites' ? dirname(suitesDirectory) : suiteDirectory;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${path.split('/').pop()}.${process.pid}.${Date.now()}.tmp`);
  let descriptor = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

const isDirectMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectMain) {
  runSuiteTokenAuditCli()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      process.stderr.write(`suite token audit failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
