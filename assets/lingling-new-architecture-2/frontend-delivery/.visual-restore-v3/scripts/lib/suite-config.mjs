import { readFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';

const TOP_LEVEL_FIELDS = [
  'schemaVersion',
  'suiteId',
  'title',
  'exemplar',
  'pages',
  'shared',
  'consistency',
  'gate',
  'publication',
];
const PAGE_FIELDS = ['name', 'required', 'route', 'type', 'relationships'];
const RELATIONSHIP_FIELDS = ['to', 'kind'];
const SHARED_FIELDS = ['sources', 'components'];
const COMPONENT_FIELDS = [
  'id',
  'auditId',
  'baselinePage',
  'requiredPages',
  'styleProperties',
  'geometryTolerance',
  'allowedVariants',
];
const VARIANT_FIELDS = ['page', 'properties', 'geometry', 'text'];
const CONSISTENCY_FIELDS = ['regions'];
const REGION_FIELDS = [
  'id',
  'baselinePage',
  'pages',
  'rect',
  'maxMeanAbsoluteDiff',
  'masks',
];
const RECT_FIELDS = ['x', 'y', 'width', 'height'];
const GATE_FIELDS = ['strictPages', 'blockingSeverities'];
const PUBLICATION_FIELDS = ['include', 'partialAllowed'];
const RELATIONSHIP_KINDS = new Set(['navigation', 'parent', 'workflow']);
const SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3']);

export function normalizeSuitePlan(raw, { root = process.cwd(), suiteId = null } = {}) {
  const projectRoot = resolve(root);
  const input = strictObject(raw, 'suite plan', TOP_LEVEL_FIELDS);
  const schemaVersion = requiredString(input.schemaVersion, 'schemaVersion');
  if (schemaVersion !== '1.0') throw new Error(`unsupported schemaVersion: ${schemaVersion}`);

  const requestedSuiteId = suiteId === null ? null : safeSuiteIdentifier(suiteId, 'suite identifier');
  const normalizedSuiteId = safeSuiteIdentifier(input.suiteId ?? requestedSuiteId, 'suiteId');
  if (requestedSuiteId && normalizedSuiteId !== requestedSuiteId) {
    throw new Error(`suiteId ${normalizedSuiteId} does not match requested suite ${requestedSuiteId}`);
  }

  if (!Array.isArray(input.pages) || input.pages.length === 0) {
    throw new Error('pages must be a non-empty array');
  }
  const pageNames = new Set();
  const pages = input.pages.map((rawPage, index) => {
    const page = strictObject(rawPage, `pages[${index}]`, PAGE_FIELDS);
    const name = safeIdentifier(page.name, `pages[${index}].name`);
    addUnique(pageNames, name, 'duplicate page');
    if (typeof page.required !== 'boolean') {
      throw new Error(`pages[${index}].required must be boolean`);
    }
    return {
      name,
      required: page.required,
      ...(page.route === undefined ? {} : { route: normalizeRoute(page.route, `pages[${index}].route`) }),
      ...(page.type === undefined ? {} : { type: safeIdentifier(page.type, `pages[${index}].type`) }),
      relationships: normalizeRelationships(page.relationships, `pages[${index}].relationships`),
    };
  });

  const exemplar = safeIdentifier(input.exemplar, 'exemplar');
  assertKnownPage(exemplar, pageNames, 'exemplar');
  for (const page of pages) {
    for (const relationship of page.relationships) {
      assertKnownPage(relationship.to, pageNames, `relationships for ${page.name}`);
    }
  }

  const shared = normalizeShared(input.shared, { projectRoot, pageNames });
  const consistency = normalizeConsistency(input.consistency, {
    exemplar,
    pageNames,
    pages,
  });
  const gate = normalizeGate(input.gate);
  const publication = normalizePublication(input.publication, projectRoot);

  return {
    schemaVersion,
    suiteId: normalizedSuiteId,
    title: input.title === undefined
      ? normalizedSuiteId
      : requiredString(input.title, 'title', { maxLength: 240 }),
    exemplar,
    pages,
    shared,
    consistency,
    gate,
    publication,
  };
}

export function loadSuitePlan(name, { root = process.cwd() } = {}) {
  const suiteId = safeSuiteIdentifier(name, 'suite identifier');
  const projectRoot = resolve(root);
  const path = safeProjectPath(projectRoot, `suites/${suiteId}/suite-plan.json`, 'suite plan path');
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read suite plan ${path}: ${error.message}`);
  }
  return normalizeSuitePlan(raw, { root: projectRoot, suiteId });
}

function normalizeRelationships(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  return value.map((raw, index) => {
    const relationship = typeof raw === 'string'
      ? { to: raw, kind: 'navigation' }
      : strictObject(raw, `${label}[${index}]`, RELATIONSHIP_FIELDS);
    const to = safeIdentifier(relationship.to, `${label}[${index}].to`);
    const kind = relationship.kind === undefined
      ? 'navigation'
      : requiredString(relationship.kind, `${label}[${index}].kind`);
    if (!RELATIONSHIP_KINDS.has(kind)) {
      throw new Error(`${label}[${index}].kind must be navigation, parent, or workflow`);
    }
    addUnique(seen, `${to}\0${kind}`, `duplicate relationship for ${to}`);
    return { to, kind };
  });
}

function normalizeShared(value, { projectRoot, pageNames }) {
  const shared = strictObject(value ?? {}, 'shared', SHARED_FIELDS);
  const sources = normalizePathList(shared.sources ?? [], projectRoot, 'shared.sources');
  if (shared.components !== undefined && !Array.isArray(shared.components)) {
    throw new Error('shared.components must be an array');
  }
  const seen = new Set();
  const components = (shared.components ?? []).map((raw, index) => {
    const label = `shared.components[${index}]`;
    const component = strictObject(raw, label, COMPONENT_FIELDS);
    const id = safeIdentifier(component.id, `${label}.id`);
    addUnique(seen, id, 'duplicate component');
    const requiredPages = uniqueStringList(
      component.requiredPages ?? [],
      `${label}.requiredPages`,
      (item, itemLabel) => safeIdentifier(item, itemLabel),
    );
    for (const page of requiredPages) {
      assertKnownPage(page, pageNames, `${label}.requiredPages`);
    }
    const baselinePage = component.baselinePage === undefined
      ? undefined
      : safeIdentifier(component.baselinePage, `${label}.baselinePage`);
    if (baselinePage !== undefined) {
      assertKnownPage(baselinePage, pageNames, `${label}.baselinePage`);
      if (requiredPages.length > 0 && !requiredPages.includes(baselinePage)) {
        throw new Error(`${label}.baselinePage must be included in requiredPages`);
      }
    }
    const styleProperties = component.styleProperties === undefined
      ? undefined
      : uniqueStringList(
        component.styleProperties,
        `${label}.styleProperties`,
        (item, itemLabel) => safeIdentifier(item, itemLabel),
      );
    const geometryTolerance = component.geometryTolerance === undefined
      ? undefined
      : finiteNumber(
        component.geometryTolerance,
        `${label}.geometryTolerance`,
        { min: 0 },
      );
    const allowedVariants = normalizeVariants(component.allowedVariants, label, pageNames);
    return {
      id,
      auditId: safeIdentifier(component.auditId, `${label}.auditId`),
      ...(baselinePage === undefined ? {} : { baselinePage }),
      requiredPages,
      ...(styleProperties === undefined ? {} : { styleProperties }),
      ...(geometryTolerance === undefined ? {} : { geometryTolerance }),
      allowedVariants,
    };
  });
  return { sources, components };
}

function normalizeVariants(value, componentLabel, pageNames) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${componentLabel}.allowedVariants must be an array`);
  const seen = new Set();
  return value.map((raw, index) => {
    const label = `${componentLabel}.allowedVariants[${index}]`;
    const variant = strictObject(raw, label, VARIANT_FIELDS);
    const page = safeIdentifier(variant.page, `${label}.page`);
    assertKnownPage(page, pageNames, `${label}.page`);
    addUnique(seen, page, `duplicate allowed variant page in ${componentLabel}`);
    return {
      page,
      properties: uniqueStringList(
        variant.properties ?? [],
        `${label}.properties`,
        (item, itemLabel) => safeIdentifier(item, itemLabel),
      ),
      geometry: booleanDefault(variant.geometry, false, `${label}.geometry`),
      text: booleanDefault(variant.text, false, `${label}.text`),
    };
  });
}

function normalizeConsistency(value, { exemplar, pageNames, pages }) {
  const consistency = strictObject(value ?? {}, 'consistency', CONSISTENCY_FIELDS);
  if (consistency.regions !== undefined && !Array.isArray(consistency.regions)) {
    throw new Error('consistency.regions must be an array');
  }
  const seen = new Set();
  const defaultPages = pages.filter((page) => page.required).map((page) => page.name);
  const regions = (consistency.regions ?? []).map((raw, index) => {
    const label = `consistency.regions[${index}]`;
    const region = strictObject(raw, label, REGION_FIELDS);
    const id = safeIdentifier(region.id, `${label}.id`);
    addUnique(seen, id, 'duplicate consistency region');
    const baselinePage = safeIdentifier(region.baselinePage ?? exemplar, `${label}.baselinePage`);
    assertKnownPage(baselinePage, pageNames, `${label}.baselinePage`);
    const regionPages = uniqueStringList(
      region.pages ?? defaultPages,
      `${label}.pages`,
      (item, itemLabel) => safeIdentifier(item, itemLabel),
    );
    if (regionPages.length === 0) throw new Error(`${label}.pages must not be empty`);
    for (const page of regionPages) assertKnownPage(page, pageNames, `${label}.pages`);
    if (!regionPages.includes(baselinePage)) {
      throw new Error(`${label}.baselinePage must be included in pages`);
    }
    const rect = normalizeRect(region.rect, `${label}.rect`);
    const masks = normalizeMasks(region.masks, rect, label);
    return {
      id,
      baselinePage,
      pages: regionPages,
      rect,
      maxMeanAbsoluteDiff: finiteNumber(
        region.maxMeanAbsoluteDiff,
        `${label}.maxMeanAbsoluteDiff`,
        { min: 0, max: 255 },
      ),
      masks,
    };
  });
  return { regions };
}

function normalizeMasks(value, rect, regionLabel) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${regionLabel}.masks must be an array`);
  return value.map((raw, index) => {
    const mask = normalizeRect(raw, `${regionLabel}.masks[${index}]`);
    if (mask.x + mask.width > rect.width || mask.y + mask.height > rect.height) {
      throw new Error(`${regionLabel} mask is outside the consistency region`);
    }
    return mask;
  });
}

function normalizeRect(value, label) {
  const rect = strictObject(value, label, RECT_FIELDS);
  return {
    x: integerNumber(rect.x, `${label}.x`, { min: 0 }),
    y: integerNumber(rect.y, `${label}.y`, { min: 0 }),
    width: integerNumber(rect.width, `${label}.width`, { min: 1 }),
    height: integerNumber(rect.height, `${label}.height`, { min: 1 }),
  };
}

function normalizeGate(value) {
  const gate = strictObject(value ?? {}, 'gate', GATE_FIELDS);
  const blockingSeverities = uniqueStringList(
    gate.blockingSeverities ?? ['P0', 'P1'],
    'gate.blockingSeverities',
    (item, label) => requiredString(item, label),
  );
  if (blockingSeverities.length === 0) throw new Error('gate.blockingSeverities must not be empty');
  for (const severity of blockingSeverities) {
    if (!SEVERITIES.has(severity)) throw new Error(`unknown blocking severity: ${severity}`);
  }
  return {
    strictPages: booleanDefault(gate.strictPages, true, 'gate.strictPages'),
    blockingSeverities,
  };
}

function normalizePublication(value, projectRoot) {
  const publication = strictObject(value ?? {}, 'publication', PUBLICATION_FIELDS);
  const include = normalizePathList(publication.include ?? [], projectRoot, 'publication.include');
  if (include.length === 0) throw new Error('publication.include must not be empty');
  const partialAllowed = booleanDefault(publication.partialAllowed, false, 'publication.partialAllowed');
  // partialAllowed defaults to false and is omitted from the canonical plan when
  // false, so legacy plans keep their historical plan digests and recorded runs
  // remain verifiable.
  return { include, ...(partialAllowed ? { partialAllowed: true } : {}) };
}

function normalizePathList(value, projectRoot, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  return value.map((item, index) => {
    const normalized = normalizeRelativePath(item, `${label}[${index}]`);
    safeProjectPath(projectRoot, normalized, `${label}[${index}]`);
    addUnique(seen, normalized, `duplicate path in ${label}`);
    return normalized;
  });
}

function normalizeRelativePath(value, label) {
  const path = requiredString(value, label, { maxLength: 2048 });
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

function safeProjectPath(projectRoot, path, label) {
  const target = resolve(projectRoot, path);
  const fromRoot = relative(projectRoot, target);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${posix.sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes the project root`);
  }
  return target;
}

function strictObject(value, label, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown field: ${key}`);
  }
  return value;
}

function safeIdentifier(value, label) {
  const id = requiredString(value, label, { maxLength: 160 });
  if (
    id === '.'
    || id === '..'
    || /[\\/\0\x00-\x1f\x7f]/.test(id)
    || /^[a-zA-Z]:/.test(id)
  ) {
    throw new Error(`${label} must be a safe identifier`);
  }
  return id;
}

function safeSuiteIdentifier(value, label) {
  const id = safeIdentifier(value, label);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,63})$/.test(id)) {
    throw new Error(`${label} must be a lowercase kebab identifier of at most 64 characters`);
  }
  return id;
}

function requiredString(value, label, { maxLength = 512 } = {}) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${label} must not be empty`);
  if (text.length > maxLength) throw new Error(`${label} is too long`);
  if (/\0|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw new Error(`${label} contains control characters`);
  }
  return text;
}

function normalizeRoute(value, label) {
  const route = requiredString(value, label, { maxLength: 2048 });
  if (route.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(route) || route.startsWith('//')) {
    throw new Error(`${label} must be an application-relative route`);
  }
  return route;
}

function uniqueStringList(value, label, normalize) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  return value.map((item, index) => {
    const normalized = normalize(item, `${label}[${index}]`);
    addUnique(seen, normalized, `duplicate value in ${label}`);
    return normalized;
  });
}

function finiteNumber(value, label, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return value;
}

function integerNumber(value, label, bounds) {
  const number = finiteNumber(value, label, bounds);
  if (!Number.isInteger(number)) throw new Error(`${label} must be an integer`);
  return number;
}

function booleanDefault(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function assertKnownPage(page, pageNames, label) {
  if (!pageNames.has(page)) throw new Error(`${label} references unknown page: ${page}`);
}

function addUnique(set, value, label) {
  if (set.has(value)) throw new Error(`${label}: ${String(value).replace('\0', ':')}`);
  set.add(value);
}
