import { createHash } from 'node:crypto';

const ACTIVE_STATUSES = new Set(['', 'open', 'regressed', 'reopened', 'blocked', 'active']);
const SEVERITY_ORDER = new Map([
  ['P0', 0],
  ['CRITICAL', 0],
  ['P1', 1],
  ['HIGH', 1],
  ['P2', 2],
  ['MEDIUM', 2],
  ['P3', 3],
  ['LOW', 3],
]);

export function fuseSuiteFindings({
  plan = {},
  pageFindings = {},
  consistencyFindings = [],
  tokenFindings = [],
} = {}) {
  const context = buildSharedContext(plan);
  const records = [
    ...normalizePageFindings(pageFindings),
    ...normalizeSourceFindings(consistencyFindings, 'suite-consistency'),
    ...normalizeSourceFindings(tokenFindings, 'suite-token-audit'),
  ].map(({ pageName, finding }) => annotateOccurrence(pageName, finding, context));

  records.sort(comparePageFinding);
  const clusters = new Map();
  for (const finding of records) {
    if (finding.suiteScope !== 'shared') continue;
    const key = findingExactKey(finding);
    const cluster = clusters.get(key) ?? createCluster(key, finding);
    cluster.occurrences.push({
      occurrence: finding.occurrence,
      pageName: finding.pageName,
      findingId: finding.id,
      severity: finding.severity,
      status: finding.status,
    });
    cluster.affectedPages.push(finding.pageName);
    cluster.severity = worseSeverity(cluster.severity, finding.severity);
    if (findingIsActive(finding)) cluster.status = 'open';
    clusters.set(key, cluster);
  }

  const sharedFindings = [...clusters.values()].map((cluster) => {
    const activeOccurrences = cluster.occurrences.filter(findingIsActive);
    return {
      ...cluster,
      severity: worstOccurrenceSeverity(activeOccurrences.length ? activeOccurrences : cluster.occurrences),
      status: activeOccurrences.length ? 'open' : 'fixed',
      affectedPages: uniqueSorted(cluster.affectedPages),
      occurrences: cluster.occurrences.sort(compareOccurrence),
    };
  }).sort((a, b) => byteCompare(a.exactKey, b.exactKey) || byteCompare(a.id, b.id));

  return { pageFindings: records, sharedFindings };
}

export function assertRepairScope(finding, request = {}) {
  const input = typeof request === 'string' ? { scope: request } : request;
  const shared = finding?.repairScope === 'shared'
    || finding?.suiteScope === 'shared'
    || finding?.scope === 'shared';
  const scope = String(input?.scope || (shared ? 'shared' : 'page')).toLowerCase();
  if (scope !== 'page' && scope !== 'shared') {
    throw new Error(`Unknown repair scope: ${scope}`);
  }
  if (shared && scope === 'page') {
    throw new Error('Shared finding requires a shared repair; page-local repair is forbidden');
  }
  const pageName = scope === 'page'
    ? String(input?.pageName || finding?.pageName || finding?.page || '')
    : null;
  if (scope === 'page' && !pageName) throw new Error('Page repair requires pageName');
  return { scope, pageName };
}

function buildSharedContext(plan) {
  const components = new Set((plan?.shared?.components || [])
    .map((component) => String(component?.id || ''))
    .filter(Boolean));
  const sources = (plan?.shared?.sources || []).map(String).filter(Boolean).sort(byteCompare);
  return { components, sources };
}

function normalizePageFindings(value) {
  if (Array.isArray(value)) {
    return value.flatMap((finding) => expandFindingPages(finding));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([pageName, findings]) => (
    Array.isArray(findings)
      ? findings.map((finding) => ({ pageName: String(pageName), finding }))
      : []
  ));
}

function normalizeSourceFindings(value, source) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((finding) => expandFindingPages({ ...finding, source: finding?.source || source }));
}

function expandFindingPages(finding) {
  const pages = Array.isArray(finding?.affectedPages) && finding.affectedPages.length
    ? finding.affectedPages
    : [finding?.pageName ?? finding?.page ?? finding?.target?.page ?? 'suite'];
  return pages.map((pageName) => ({ pageName: String(pageName || 'suite'), finding }));
}

function annotateOccurrence(pageName, rawFinding, context) {
  if (!rawFinding || typeof rawFinding !== 'object' || Array.isArray(rawFinding)) {
    throw new Error(`Invalid finding for page ${pageName}`);
  }
  const id = String(rawFinding.id || rawFinding.findingId || '');
  if (!id) throw new Error(`Finding for page ${pageName} is missing id`);
  const componentId = findingComponentId(rawFinding);
  const detector = String(rawFinding.detector || rawFinding.source || 'unknown');
  const code = String(rawFinding.code || rawFinding.kind || 'unknown');
  const dimension = String(rawFinding.dimension || rawFinding.kind || 'unknown');
  const ownerPath = findingOwnerPath(rawFinding, context, detector);
  const shared = isSharedFinding(rawFinding, {
    componentId,
    detector,
    ownerPath,
    context,
  });

  return {
    ...rawFinding,
    id,
    detector,
    code,
    dimension,
    componentId,
    ownerPath,
    pageName,
    occurrence: `${pageName}:${id}`,
    suiteScope: shared ? 'shared' : 'page',
    repairScope: shared ? 'shared' : 'page',
  };
}

function findingComponentId(finding) {
  const direct = finding.componentId
    || finding.target?.componentId
    || finding.evidence?.componentId
    || finding.consistencyGroup;
  if (direct) return String(direct);
  if (finding.token) return `token:${finding.token}`;
  if (finding.regionId) return `region:${finding.regionId}`;
  return '';
}

function findingOwnerPath(finding, context, detector) {
  const direct = finding.ownerPath
    || finding.ownerPaths?.[0]
    || finding.target?.ownerPath
    || finding.evidence?.ownerPath;
  if (direct) return String(direct);
  const tokenSource = context.sources.find((source) => /token/i.test(source));
  const componentSource = context.sources.find((source) => /component/i.test(source));
  if (finding.code === 'shared-token-missing') return tokenSource || context.sources[0] || '';
  if (/consistency/i.test(detector)) return componentSource || context.sources[0] || '';
  return '';
}

function isSharedFinding(finding, { componentId, detector, ownerPath, context }) {
  const explicitlyShared = finding.scope === 'shared'
    || (ownerPath && context.sources.includes(ownerPath));
  if (explicitlyShared) return true;
  if (finding.code === 'shared-token-missing') return true;
  if (finding.code === 'page-token-drift' || finding.code === 'shared-token-source-not-consumed') {
    return false;
  }
  return context.components.has(componentId)
    || finding.regionId
    || /consistency/i.test(String(detector || ''));
}

function findingExactKey(finding) {
  return JSON.stringify([
    finding.componentId,
    finding.detector,
    finding.code,
    finding.dimension,
    finding.ownerPath,
  ].map((value) => String(value || '')));
}

function createCluster(exactKey, finding) {
  return {
    id: `suite:${finding.componentId || 'shared'}:${shortHash(exactKey)}`,
    scope: 'shared',
    suiteScope: 'shared',
    repairScope: 'shared',
    exactKey,
    componentId: finding.componentId,
    detector: finding.detector,
    code: finding.code,
    dimension: finding.dimension,
    ownerPath: finding.ownerPath,
    ownerPaths: finding.ownerPath ? [finding.ownerPath] : [],
    severity: finding.severity || 'P2',
    status: findingIsActive(finding) ? 'open' : 'fixed',
    affectedPages: [],
    occurrences: [],
  };
}

function findingIsActive(finding) {
  return ACTIVE_STATUSES.has(String(finding?.status || '').toLowerCase());
}

function worseSeverity(left, right) {
  const leftRank = severityRank(left);
  const rightRank = severityRank(right);
  return rightRank < leftRank ? right : left;
}

function severityRank(value) {
  return SEVERITY_ORDER.get(String(value || 'P2').toUpperCase()) ?? 2;
}

function worstOccurrenceSeverity(occurrences) {
  return occurrences.reduce(
    (severity, occurrence) => worseSeverity(severity, occurrence.severity),
    'P3',
  );
}

function comparePageFinding(a, b) {
  return byteCompare(a.pageName, b.pageName)
    || byteCompare(a.id, b.id)
    || byteCompare(findingExactKey(a), findingExactKey(b));
}

function compareOccurrence(a, b) {
  return byteCompare(a.occurrence, b.occurrence)
    || byteCompare(a.severity, b.severity)
    || byteCompare(a.status, b.status);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(byteCompare);
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function byteCompare(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}
