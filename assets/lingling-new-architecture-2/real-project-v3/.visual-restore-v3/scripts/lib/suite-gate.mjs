const ACTIVE_STATUSES = new Set(['', 'open', 'regressed', 'reopened', 'blocked', 'active']);
const DEFAULT_BLOCKING = ['P0', 'P1'];
const SUBSET_PASSING_STATUSES = new Set(['pass', 'allowed', 'advisory']);
const SEVERITY_ALIASES = new Map([
  ['CRITICAL', 'P0'],
  ['HIGH', 'P1'],
  ['MEDIUM', 'P2'],
  ['LOW', 'P3'],
]);

export function buildSuiteGateInput({
  plan,
  inputSnapshot,
  currentSnapshot = inputSnapshot,
  pageResults = {},
  consistency = {},
  tokens = {},
  findings = {},
  strict = false,
} = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.pages)) {
    throw new Error('suite plan is required to build gate input');
  }
  if (!inputSnapshot || typeof inputSnapshot.inputDigest !== 'string') {
    throw new Error('suite input snapshot is required to build gate input');
  }
  if (typeof strict !== 'boolean') throw new Error('suite strict policy must be boolean');
  const inputDigest = inputSnapshot.inputDigest;
  const exemplar = String(plan.exemplar?.page || plan.exemplar || '');
  return {
    plan,
    manifest: {
      status: 'verified',
      snapshotDigest: inputDigest,
      pages: plan.pages.map((page) => ({
        name: String(page?.name || page),
        required: typeof page === 'object' ? page.required !== false : true,
        inputDigest,
      })),
    },
    snapshot: {
      status: 'verified',
      digest: inputDigest,
      fresh: currentSnapshot?.inputDigest === inputDigest,
    },
    exemplar: {
      pageName: exemplar,
      inputDigest,
      fresh: pageResults?.[exemplar]?.fresh === true,
      gate: pageResults?.[exemplar]?.gate || pageResults?.[exemplar]?.pageGate,
    },
    pages: pageResults,
    consistency: {
      components: Object.fromEntries((consistency?.componentResults || []).map((result) => [result.componentId, result])),
      regions: Object.fromEntries((consistency?.regionResults || []).map((result) => [result.regionId, result])),
      tokens,
    },
    findings,
    strict,
  };
}

export function buildSuiteGateResult({ suiteId, runId, ...evidence } = {}) {
  const strict = evidence.strict === true;
  return {
    schemaVersion: '1.0',
    suiteId,
    runId,
    ...(strict ? { strict: true } : {}),
    ...evaluateSuiteGate(buildSuiteGateInput({ ...evidence, strict })),
  };
}

export function evaluateSuiteGate(input = {}) {
  const plan = input.plan || {};
  const manifest = input.manifest;
  const snapshot = input.snapshot;
  const pages = input.pages || {};
  const consistency = input.consistency || {};
  const checks = [];
  const errors = [];
  const warnings = [];

  addRequiredCheck({
    checks,
    errors,
    id: 'manifest',
    pass: evidenceVerified(manifest),
    failure: 'suite manifest is missing or not verified',
  });
  addRequiredCheck({
    checks,
    errors,
    id: 'snapshot',
    pass: evidenceVerified(snapshot),
    failure: 'suite snapshot is missing or not verified',
  });
  addRequiredCheck({
    checks,
    errors,
    id: 'snapshot:fresh',
    pass: snapshot?.fresh === true || snapshot?.freshness === 'fresh',
    failure: 'suite snapshot is stale',
  });
  addRequiredCheck({
    checks,
    errors,
    id: 'manifest:snapshot-digest',
    pass: Boolean(manifest?.snapshotDigest)
      && Boolean(snapshot?.digest || snapshot?.snapshotDigest)
      && manifest.snapshotDigest === (snapshot.digest || snapshot.snapshotDigest),
    failure: 'manifest snapshot digest mismatch',
  });

  const plannedPages = normalizePlannedPages(plan.pages);
  const manifestPages = normalizeManifestPages(manifest?.pages);
  const exemplarName = String(plan.exemplar?.page || plan.exemplar || '');
  const exemplarPage = plannedPages.find(({ name }) => name === exemplarName);
  const exemplarEvidence = input.exemplar;
  const exemplarPass = Boolean(exemplarName)
    && Boolean(exemplarPage)
    && Boolean(exemplarEvidence)
    && String(exemplarEvidence.pageName || exemplarEvidence.page || '') === exemplarName
    && evidenceFresh(exemplarEvidence)
    && gatePass(exemplarEvidence.gate || exemplarEvidence.pageGate)
    && exemplarDigestMatches(exemplarEvidence, manifestPages.get(exemplarName), pages[exemplarName]);
  addRequiredCheck({
    checks,
    errors,
    id: 'exemplar',
    pass: exemplarPass,
    failure: exemplarEvidence ? `exemplar ${exemplarName || '(unknown)'} is invalid or stale` : 'exemplar evidence is missing',
  });

  let passedRequiredPages = 0;
  const requiredPages = plannedPages.filter(({ required }) => required);
  const optionalPages = plannedPages.filter(({ required }) => !required);
  const adjudications = [...plannedPages]
    .sort(comparePage)
    .map((page) => adjudicatePage(page, manifestPages.get(page.name), pages[page.name]));
  const adjudicationByName = new Map(adjudications.map((verdict) => [verdict.name, verdict]));
  for (const page of [...requiredPages].sort(comparePage)) {
    const verdict = adjudicationByName.get(page.name);
    addRequiredCheck({
      checks,
      errors,
      id: `page:${page.name}:coverage`,
      pass: verdict.covered,
      failure: `required page ${page.name} is missing manifest or run evidence`,
    });
    if (!verdict.covered) continue;

    addRequiredCheck({
      checks,
      errors,
      id: `page:${page.name}:input-digest`,
      pass: verdict.digestMatches,
      failure: `required page ${page.name} input digest mismatch`,
    });
    addRequiredCheck({
      checks,
      errors,
      id: `page:${page.name}:fresh`,
      pass: verdict.fresh,
      failure: `required page ${page.name} is stale`,
    });
    addRequiredCheck({
      checks,
      errors,
      id: `page:${page.name}:gate`,
      pass: verdict.passed,
      failure: `required page ${page.name} page gate failed`,
    });
    if (verdict.pageGatePass) passedRequiredPages++;
  }

  for (const page of [...optionalPages].sort(comparePage)) {
    const verdict = adjudicationByName.get(page.name);
    addOptionalCheck({
      checks,
      warnings,
      id: `page:${page.name}:optional`,
      pass: verdict.pageGatePass,
      failure: `optional page ${page.name} is missing, stale, digest-mismatched, or failed its page gate`,
    });
  }

  for (const component of normalizeIdentifiers(plan?.shared?.components)) {
    const evidence = indexedEvidence(consistency.components, consistency.componentResults, 'componentId').get(component);
    addRequiredCheck({
      checks,
      errors,
      id: `component:${component}`,
      pass: evidence?.pass === true,
      failure: `shared component ${component} consistency failed or is missing`,
    });
  }
  for (const region of normalizeIdentifiers(plan?.consistency?.regions)) {
    const evidence = indexedEvidence(consistency.regions, consistency.regionResults, 'regionId').get(region);
    addRequiredCheck({
      checks,
      errors,
      id: `region:${region}`,
      pass: evidence?.pass === true,
      failure: `shared region ${region} consistency failed or is missing`,
    });
  }
  addRequiredCheck({
    checks,
    errors,
    id: 'tokens',
    pass: consistency.tokens?.pass === true || consistency.tokenResult?.pass === true,
    failure: 'shared tokens consistency failed or is missing',
  });

  const activeFindings = gateFindings(input.findings).filter(findingIsActive);
  const configuredBlocking = blockingSeverities(plan);
  const optionalPageNames = new Set(optionalPages.map((page) => page.name));
  const forcedAdvisoryFindings = activeFindings.filter((finding) => (
    finding.advisory === true || isOptionalPageLocalFinding(finding, optionalPageNames)
  ));
  const gateEligibleFindings = activeFindings.filter((finding) => !forcedAdvisoryFindings.includes(finding));
  const blockingFindings = gateEligibleFindings.filter((finding) => (
    input.strict === true || configuredBlocking.has(normalizeSeverity(finding.severity))
  )).sort(compareFinding);
  const advisoryFindings = activeFindings.filter((finding) => !blockingFindings.includes(finding)).sort(compareFinding);
  for (const finding of blockingFindings) {
    errors.push(`blocking finding ${findingIdentity(finding)} (${finding.severity || 'unknown'})`);
  }
  for (const finding of advisoryFindings) {
    warnings.push(`active non-blocking finding ${findingIdentity(finding)} (${finding.severity || 'unknown'})`);
  }
  checks.push({
    id: 'findings:blocking',
    required: true,
    status: blockingFindings.length === 0 ? 'pass' : 'fail',
  });

  const partial = evaluatePartialEligibility({
    plan,
    adjudications,
    sharedBlockingFindings: blockingFindings.filter(isSharedScopedFinding),
    consistency,
  });

  return {
    pass: errors.length === 0,
    checks,
    errors,
    warnings,
    blockingFindingIds: blockingFindings.map(findingIdentity).sort(byteCompare),
    summary: {
      requiredPages: requiredPages.length,
      passedRequiredPages,
      optionalPages: optionalPages.length,
      blockingFindings: blockingFindings.length,
      warnings: warnings.length,
    },
    pages: adjudications.map(pageAdjudicationView),
    partial,
  };
}

function adjudicatePage(page, expected, actual) {
  const label = `${page.required ? 'required' : 'optional'} page ${page.name}`;
  const covered = Boolean(expected) && Boolean(actual);
  const reasons = [];
  let digestMatches = false;
  let fresh = false;
  let passed = false;
  let gate;
  if (!covered) {
    reasons.push(`${label} is missing manifest or run evidence`);
  } else {
    digestMatches = Boolean(expected.inputDigest)
      && Boolean(actual.inputDigest)
      && expected.inputDigest === actual.inputDigest;
    if (!digestMatches) reasons.push(`${label} input digest mismatch`);
    fresh = evidenceFresh(actual);
    if (!fresh) reasons.push(`${label} is stale`);
    gate = actual.gate || actual.pageGate;
    passed = gatePass(gate);
    if (!passed) {
      reasons.push(`${label} page gate failed`);
      if (Array.isArray(gate?.errors)) {
        for (const error of gate.errors) reasons.push(String(error));
      }
    }
  }
  return {
    name: page.name,
    required: page.required,
    covered,
    digestMatches,
    fresh,
    passed,
    pageGatePass: covered && digestMatches && fresh && passed,
    reasons,
    // Page gates may carry a convergence stop-loss block; tolerate and relay it.
    ...(gate && gate.convergence !== undefined ? { convergence: gate.convergence } : {}),
  };
}

function pageAdjudicationView(verdict) {
  return {
    name: verdict.name,
    required: verdict.required,
    pageGatePass: verdict.pageGatePass,
    reasons: verdict.reasons,
    ...(Object.hasOwn(verdict, 'convergence') ? { convergence: verdict.convergence } : {}),
  };
}

function evaluatePartialEligibility({ plan, adjudications, sharedBlockingFindings, consistency }) {
  const requiredVerdicts = adjudications.filter((verdict) => verdict.required);
  const failedRequired = requiredVerdicts.filter((verdict) => !verdict.pageGatePass);
  const passedRequired = requiredVerdicts.filter((verdict) => verdict.pageGatePass);
  const excludedPages = failedRequired.map(({ name, reasons }) => ({ name, reasons }));
  const excludedNames = new Set(excludedPages.map(({ name }) => name));
  const publishablePages = adjudications
    .map(({ name }) => name)
    .filter((name) => !excludedNames.has(name));
  const publishable = new Set(publishablePages);

  const reasons = [];
  if (plan?.publication?.partialAllowed !== true) {
    reasons.push('publication.partialAllowed is not enabled in the suite plan');
  }
  if (failedRequired.length === 0) {
    reasons.push('no required page failed its page adjudication; partial release is unnecessary');
  }
  if (passedRequired.length === 0) {
    reasons.push('no required page passed its page adjudication');
  }
  for (const finding of sharedBlockingFindings) {
    reasons.push(`shared blocking finding ${findingIdentity(finding)} (${finding.severity || 'unknown'})`);
  }
  reasons.push(...subsetConsistencyFailures(plan, consistency, publishable));

  return {
    eligible: reasons.length === 0,
    publishablePages,
    excludedPages,
    reasons,
  };
}

function subsetConsistencyFailures(plan, consistency, publishable) {
  const failures = [];
  const components = indexedEvidence(consistency.components, consistency.componentResults, 'componentId');
  for (const component of normalizeIdentifiers(plan?.shared?.components)) {
    failures.push(...subsetEvidenceFailures(`shared component ${component}`, components.get(component), publishable));
  }
  const regions = indexedEvidence(consistency.regions, consistency.regionResults, 'regionId');
  for (const region of normalizeIdentifiers(plan?.consistency?.regions)) {
    failures.push(...subsetEvidenceFailures(`shared region ${region}`, regions.get(region), publishable));
  }
  failures.push(
    ...subsetEvidenceFailures('shared tokens', consistency.tokens ?? consistency.tokenResult, publishable),
  );
  return failures;
}

function subsetEvidenceFailures(label, evidence, publishable) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return [`${label} evidence is missing for the publishable subset`];
  }
  if (!Array.isArray(evidence.checks)) {
    // Without per-page checks the failure cannot be re-scoped; fail closed.
    return evidence.pass === true ? [] : [`${label} failed and has no per-page checks to re-scope`];
  }
  const failures = [];
  for (const check of evidence.checks) {
    if (!checkAppliesToPages(check, publishable)) continue;
    if (checkPassesForSubset(check)) continue;
    failures.push(`${label} check ${String(check?.id || check?.kind || 'unknown')} fails within the publishable subset`);
  }
  return failures;
}

function checkPassesForSubset(check) {
  return SUBSET_PASSING_STATUSES.has(String(check?.status || '').toLowerCase());
}

function checkAppliesToPages(check, publishable) {
  const page = pageReference(check?.page ?? check?.pageName);
  if (page && !publishable.has(page)) return false;
  const baseline = pageReference(check?.baselinePage);
  if (baseline && !publishable.has(baseline)) return false;
  if (Array.isArray(check?.affectedPages) && check.affectedPages.length > 0) {
    const names = check.affectedPages.map((name) => pageReference(name)).filter(Boolean);
    if (names.length > 0 && !names.some((name) => publishable.has(name))) return false;
  }
  return true;
}

function pageReference(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function isSharedScopedFinding(finding) {
  return finding?.suiteScope === 'shared'
    || finding?.repairScope === 'shared'
    || finding?.scope === 'shared';
}

function normalizePlannedPages(value) {
  if (!Array.isArray(value)) return [];
  return value.map((page) => typeof page === 'string'
    ? { name: page, required: true }
    : { name: String(page?.name || page?.pageName || page?.id || ''), required: page?.required !== false })
    .filter(({ name }) => Boolean(name));
}

function normalizeManifestPages(value) {
  const entries = value instanceof Map
    ? [...value]
    : Array.isArray(value)
      ? value.map((page) => [String(page?.name || page?.pageName || page?.id || ''), page])
      : Object.entries(value || {});
  return new Map(entries.filter(([name]) => Boolean(name)).map(([name, page]) => [String(name), page]));
}

function normalizeIdentifiers(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry?.id || entry?.componentId || entry?.regionId || entry || ''))
    .filter(Boolean)
    .sort(byteCompare);
}

function indexedEvidence(mapValue, arrayValue, idField) {
  if (mapValue instanceof Map) return new Map(mapValue);
  if (mapValue && !Array.isArray(mapValue) && typeof mapValue === 'object') {
    return new Map(Object.entries(mapValue));
  }
  const source = Array.isArray(mapValue) ? mapValue : Array.isArray(arrayValue) ? arrayValue : [];
  return new Map(source.map((entry) => [String(entry?.[idField] || entry?.id || ''), entry]).filter(([id]) => Boolean(id)));
}

function evidenceVerified(value) {
  return Boolean(value) && (
    value.verified === true
    || value.valid === true
    || value.pass === true
    || value.status === 'verified'
    || value.status === 'committed'
  );
}

function evidenceFresh(value) {
  return value?.fresh === true || value?.freshness === 'fresh';
}

function gatePass(value) {
  return value?.pass === true || value?.status === 'passed';
}

function exemplarDigestMatches(exemplar, expected, page) {
  if (!expected?.inputDigest || !exemplar?.inputDigest) return false;
  if (expected.inputDigest !== exemplar.inputDigest) return false;
  return !page?.inputDigest || page.inputDigest === exemplar.inputDigest;
}

function gateFindings(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const shared = Array.isArray(value.sharedFindings) ? value.sharedFindings : [];
  const pages = Array.isArray(value.pageFindings)
    ? value.pageFindings.filter((finding) => finding?.suiteScope !== 'shared')
    : [];
  return [...shared, ...pages];
}

function findingIsActive(finding) {
  return ACTIVE_STATUSES.has(String(finding?.status || '').toLowerCase());
}

function isOptionalPageLocalFinding(finding, optionalPageNames) {
  if (finding?.suiteScope === 'shared' || finding?.repairScope === 'shared' || finding?.scope === 'shared') {
    return false;
  }
  const occurrence = String(finding?.occurrence || '');
  const pageName = String(finding?.pageName || finding?.page || occurrence.split(':')[0] || '');
  return optionalPageNames.has(pageName);
}

function blockingSeverities(plan) {
  const configured = plan?.gate?.blockingSeverities;
  const values = Array.isArray(configured) && configured.length ? configured : DEFAULT_BLOCKING;
  return new Set(values.map(normalizeSeverity));
}

function normalizeSeverity(value) {
  const severity = String(value || '').toUpperCase();
  return SEVERITY_ALIASES.get(severity) || severity;
}

function addRequiredCheck({ checks, errors, id, pass, failure }) {
  checks.push({ id, required: true, status: pass ? 'pass' : 'fail' });
  if (!pass) errors.push(failure);
}

function addOptionalCheck({ checks, warnings, id, pass, failure }) {
  checks.push({ id, required: false, status: pass ? 'pass' : 'warning' });
  if (!pass) warnings.push(failure);
}

function comparePage(left, right) {
  return byteCompare(left.name, right.name);
}

function compareFinding(left, right) {
  return byteCompare(findingIdentity(left), findingIdentity(right))
    || byteCompare(left.severity, right.severity)
    || byteCompare(left.occurrence, right.occurrence);
}

function findingIdentity(finding) {
  return String(finding?.occurrence || finding?.id || 'unknown');
}

function byteCompare(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}
