import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import {
  atomicWriteJson,
  buildFileManifest,
  commitImmutableDirectory,
  verifyFileManifest,
} from './suite-artifacts.mjs';
import { loadSuitePlan, normalizeSuitePlan } from './suite-config.mjs';
import { buildSuiteInputSnapshot, digestJSON } from './suite-digest.mjs';
import { buildSuiteGateResult } from './suite-gate.mjs';

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const APPROVAL_FIELDS = new Set([
  'schemaVersion',
  'suiteId',
  'runId',
  'suiteResultDigest',
  'inputSnapshotDigest',
  'evidenceManifestDigest',
  'gateDigest',
  'approver',
  'reason',
  'approvedAt',
  'partial',
  'excludedPages',
  'approvalDigest',
]);
const EXCLUDED_PAGE_FIELDS = new Set(['name', 'reasons', 'escalation']);

export function computeGateDigest(gate) {
  // The per-page adjudication (pages) and partial eligibility (partial) blocks
  // are derived from evidence that the digest already covers, and they are
  // excluded here so runs recorded before their introduction keep verifying.
  // Their bytes stay integrity-protected by the evidence manifest, and
  // verification separately cross-checks them against the recomputed gate.
  return digestWithout(gate, ['gateDigest', 'pages', 'partial'], 'suite gate');
}

export function computeSuiteResultDigest(suiteRun) {
  return digestWithout(suiteRun, ['suiteResultDigest', 'generatedAt'], 'suite run');
}

export function computeApprovalDigest(approval) {
  return digestWithout(approval, ['approvalDigest'], 'suite approval');
}

export function computeReleaseDigest(releaseManifest) {
  return digestWithout(releaseManifest, ['releaseDigest'], 'release manifest');
}

export function verifySuiteRun({
  root = process.cwd(),
  suiteId,
  runId,
  plan,
  currentSnapshot,
} = {}) {
  const projectRoot = resolve(root);
  const safeSuiteId = assertSafeId('suite', suiteId);
  const safeRunId = assertSafeId('run', runId);
  const normalizedPlan = resolvePlan(plan, safeSuiteId, projectRoot);
  const runDir = join(projectRoot, 'output', 'suites', safeSuiteId, 'runs', safeRunId);
  assertDirectory(runDir, projectRoot, 'suite run');

  const suiteRunPath = join(runDir, 'suite-run.json');
  const manifestPath = join(runDir, 'evidence-manifest.json');
  const payloadDir = join(runDir, 'payload');
  const suiteRun = readJsonRegular(suiteRunPath, runDir, 'suite-run.json');
  const evidenceManifest = readJsonRegular(manifestPath, runDir, 'evidence-manifest.json');

  if (suiteRun?.schemaVersion !== '1.0') throw new Error('suite run has an unsupported schema version');
  if (suiteRun.suiteId !== safeSuiteId || suiteRun.runId !== safeRunId) {
    throw new Error('suite run identity mismatch');
  }
  if (suiteRun.status !== 'complete') throw new Error(`suite run is not complete: ${suiteRun.status || 'missing status'}`);
  assertDigest('suiteResultDigest', suiteRun.suiteResultDigest);
  if (computeSuiteResultDigest(suiteRun) !== suiteRun.suiteResultDigest) {
    throw new Error('suite result digest mismatch');
  }
  if (suiteRun.exemplar !== normalizedPlan.exemplar) throw new Error('suite run exemplar does not match the suite plan');

  assertDigest('evidenceManifestDigest', suiteRun.evidenceManifestDigest);
  if (digestJSON(evidenceManifest) !== suiteRun.evidenceManifestDigest) {
    throw new Error('evidence manifest digest mismatch');
  }
  assertDirectory(payloadDir, runDir, 'suite evidence payload');
  const manifestVerification = verifyFileManifest(payloadDir, evidenceManifest);
  if (!manifestVerification.ok) {
    throw new Error(`evidence manifest verification failed: ${manifestVerification.errors.join('; ')}`);
  }

  const gate = readJsonRegular(join(payloadDir, 'suite-gate.json'), payloadDir, 'suite-gate.json');
  const inputSnapshot = readJsonRegular(join(payloadDir, 'input-snapshot.json'), payloadDir, 'input-snapshot.json');
  assertDigest('gateDigest', suiteRun.gateDigest);
  if (computeGateDigest(gate) !== suiteRun.gateDigest || gate.gateDigest !== suiteRun.gateDigest) {
    throw new Error('suite gate digest mismatch');
  }
  if (gate.suiteId !== undefined && gate.suiteId !== safeSuiteId) throw new Error('suite gate identity mismatch');
  if (gate.runId !== undefined && gate.runId !== safeRunId) throw new Error('suite gate run identity mismatch');

  verifySnapshotObject(inputSnapshot, safeSuiteId, 'recorded input snapshot');
  if (inputSnapshot.inputDigest !== suiteRun.inputSnapshotDigest) {
    throw new Error('recorded input snapshot digest mismatch');
  }
  const actualSnapshot = buildSuiteInputSnapshot(normalizedPlan, { root: projectRoot });
  verifySnapshotObject(actualSnapshot, safeSuiteId, 'current input snapshot');
  if (currentSnapshot !== undefined) {
    verifySnapshotObject(currentSnapshot, safeSuiteId, 'provided current input snapshot');
    if (currentSnapshot.inputDigest !== actualSnapshot.inputDigest) {
      throw new Error('provided current input snapshot does not match project files');
    }
  }
  if (actualSnapshot.inputDigest !== inputSnapshot.inputDigest) {
    throw new Error('input snapshot is stale: current project inputs changed');
  }

  const closedEvidence = verifyClosedSuiteEvidence({
    projectRoot,
    payloadDir,
    normalizedPlan,
    suiteRun,
    gate,
    inputSnapshot,
    currentSnapshot: actualSnapshot,
    suiteId: safeSuiteId,
    runId: safeRunId,
  });

  return {
    root: projectRoot,
    suiteId: safeSuiteId,
    runId: safeRunId,
    plan: normalizedPlan,
    runDir,
    payloadDir,
    suiteRun,
    evidenceManifest,
    gate,
    inputSnapshot,
    currentSnapshot: actualSnapshot,
    ...closedEvidence,
  };
}

export function approveSuiteRun(options = {}) {
  const verified = verifySuiteRun(options);
  const partial = options.partial === true;
  if (!partial && verified.gate.pass !== true) throw new Error('suite gate must pass before approval');
  let partialFields = {};
  if (partial) {
    if (verified.gate.pass === true) {
      throw new Error('suite gate passes; approve the run without --partial');
    }
    const eligibility = verified.recomputedGate?.partial;
    if (eligibility?.eligible !== true) {
      const details = Array.isArray(eligibility?.reasons) && eligibility.reasons.length
        ? `: ${eligibility.reasons.join('; ')}`
        : '';
      throw new Error(`suite run is not eligible for partial approval${details}`);
    }
    partialFields = { partial: true, excludedPages: partialExcludedPages(verified) };
  }

  const env = options.env ?? process.env;
  const approver = requiredText(
    options.approver ?? env?.SUITE_APPROVER ?? env?.USER,
    'approver',
    240,
  );
  const reason = requiredText(
    options.reason ?? env?.SUITE_APPROVAL_REASON,
    'reason',
    2000,
  );
  const approvedAt = timestampFromClock(options.clock, 'approvedAt');
  const approvalBase = {
    schemaVersion: '1.0',
    suiteId: verified.suiteId,
    runId: verified.runId,
    suiteResultDigest: verified.suiteRun.suiteResultDigest,
    inputSnapshotDigest: verified.suiteRun.inputSnapshotDigest,
    evidenceManifestDigest: verified.suiteRun.evidenceManifestDigest,
    gateDigest: verified.suiteRun.gateDigest,
    approver,
    reason,
    approvedAt,
    ...partialFields,
  };
  const approval = {
    ...approvalBase,
    approvalDigest: computeApprovalDigest(approvalBase),
  };
  const approvalPath = join(verified.runDir, 'approval.json');

  if (existsSync(approvalPath)) {
    const existing = readJsonRegular(approvalPath, verified.runDir, 'approval.json');
    verifyApprovalObject(existing, verified);
    if (sameApprovalRequest(existing, approval)) return existing;
    throw new Error('suite approval already exists with different content');
  }

  const candidate = join(verified.runDir, `.approval-${randomUUID()}.json`);
  atomicWriteJson(candidate, approval);
  try {
    linkSync(candidate, approvalPath);
    syncDirectory(verified.runDir);
    return approval;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readJsonRegular(approvalPath, verified.runDir, 'approval.json');
    verifyApprovalObject(existing, verified);
    if (sameApprovalRequest(existing, approval)) return existing;
    throw new Error('suite approval already exists with different content');
  } finally {
    if (existsSync(candidate)) unlinkSync(candidate);
    syncDirectory(verified.runDir);
  }
}

export function verifySuiteApproval(options = {}) {
  const verified = verifySuiteRun(options);
  const approvalPath = join(verified.runDir, 'approval.json');
  if (!existsSync(approvalPath) && verified.gate.pass !== true) {
    throw new Error('suite gate must pass for an approved run');
  }
  const approval = readJsonRegular(approvalPath, verified.runDir, 'approval.json');
  verifyApprovalObject(approval, verified);
  if (approval.partial !== true && verified.gate.pass !== true) {
    throw new Error('suite gate must pass for an approved run');
  }
  return { ...verified, approvalPath, approval };
}

export function publishSuiteRun(options = {}) {
  const verified = verifySuiteApproval(options);
  assertPublishMode(verified.approval, options);
  const publicationInclude = resolvePublicationInclude(verified);
  const releasesRoot = join(verified.root, 'releases', verified.suiteId);
  ensureSafeDirectoryChain(verified.root, ['releases', verified.suiteId]);
  const releaseDir = join(releasesRoot, verified.suiteRun.suiteResultDigest);

  if (existsSync(releaseDir)) {
    const existing = verifyPublishedRelease(options);
    return { ...existing, releaseDir, idempotent: true };
  }

  const staging = join(releasesRoot, `.tmp-${verified.suiteRun.suiteResultDigest}-${randomUUID()}`);
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  try {
    const releasePayload = join(staging, 'payload');
    const publicationRoot = join(releasePayload, 'publication');
    const evidenceRoot = join(releasePayload, 'evidence');
    mkdirSync(publicationRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(evidenceRoot, 'payload'), { recursive: true, mode: 0o700 });

    for (const path of publicationInclude) {
      copyRegularFile(
        join(verified.root, ...path.split('/')),
        join(publicationRoot, ...path.split('/')),
        verified.root,
        `publication input ${path}`,
      );
    }
    copyRegularFile(join(verified.runDir, 'suite-run.json'), join(evidenceRoot, 'suite-run.json'), verified.runDir, 'suite-run.json');
    copyRegularFile(join(verified.runDir, 'evidence-manifest.json'), join(evidenceRoot, 'evidence-manifest.json'), verified.runDir, 'evidence-manifest.json');
    for (const file of verified.evidenceManifest.files) {
      const path = normalizeRelativePath(file.path, 'evidence manifest path');
      copyRegularFile(
        join(verified.payloadDir, ...path.split('/')),
        join(evidenceRoot, 'payload', ...path.split('/')),
        verified.payloadDir,
        `suite evidence ${path}`,
      );
    }
    copyRegularFile(verified.approvalPath, join(releasePayload, 'approval.json'), verified.runDir, 'approval.json');

    const nestedEvidence = verifyFileManifest(join(evidenceRoot, 'payload'), verified.evidenceManifest);
    if (!nestedEvidence.ok) {
      throw new Error(`copied evidence manifest verification failed: ${nestedEvidence.errors.join('; ')}`);
    }
    verifyPublicationFiles(publicationRoot, publicationInclude, verified.currentSnapshot);

    const payloadManifest = buildFileManifest(releasePayload);
    const publishedAt = timestampFromClock(options.clock, 'publishedAt');
    const releaseBase = {
      schemaVersion: '1.0',
      suiteId: verified.suiteId,
      runId: verified.runId,
      suiteResultDigest: verified.suiteRun.suiteResultDigest,
      inputSnapshotDigest: verified.suiteRun.inputSnapshotDigest,
      evidenceManifestDigest: verified.suiteRun.evidenceManifestDigest,
      gateDigest: verified.suiteRun.gateDigest,
      approvalDigest: verified.approval.approvalDigest,
      ...(verified.approval.partial === true
        ? { partial: true, excludedPages: excludedPageNames(verified.approval) }
        : {}),
      payloadManifestDigest: digestJSON(payloadManifest),
      payloadManifest,
      publishedAt,
    };
    atomicWriteJson(join(staging, 'release-manifest.json'), {
      ...releaseBase,
      releaseDigest: computeReleaseDigest(releaseBase),
    });
    verifyReleaseDirectory(staging, verified);
    try {
      commitImmutableDirectory(staging, releaseDir);
    } catch (error) {
      if (!existsSync(releaseDir)) throw error;
      rmSync(staging, { recursive: true, force: true });
      const concurrent = verifyReleaseDirectory(releaseDir, verified);
      return { ...concurrent, releaseDir, idempotent: true };
    }
    const published = verifyReleaseDirectory(releaseDir, verified);
    return { ...published, releaseDir, idempotent: false };
  } catch (error) {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function verifyPublishedRelease(options = {}) {
  const verified = verifySuiteApproval(options);
  const releaseDir = join(
    verified.root,
    'releases',
    verified.suiteId,
    verified.suiteRun.suiteResultDigest,
  );
  const result = verifyReleaseDirectory(releaseDir, verified);
  return { ...result, releaseDir, idempotent: true };
}

function verifyReleaseDirectory(releaseDir, verified) {
  assertDirectory(releaseDir, verified.root, 'release');
  assertReleaseRootShape(releaseDir);
  const releaseManifest = readJsonRegular(
    join(releaseDir, 'release-manifest.json'),
    releaseDir,
    'release-manifest.json',
  );
  if (releaseManifest?.schemaVersion !== '1.0') throw new Error('release manifest has an unsupported schema version');
  const bindings = [
    ['suiteId', verified.suiteId],
    ['runId', verified.runId],
    ['suiteResultDigest', verified.suiteRun.suiteResultDigest],
    ['inputSnapshotDigest', verified.suiteRun.inputSnapshotDigest],
    ['evidenceManifestDigest', verified.suiteRun.evidenceManifestDigest],
    ['gateDigest', verified.suiteRun.gateDigest],
    ['approvalDigest', verified.approval.approvalDigest],
  ];
  for (const [field, expected] of bindings) {
    if (releaseManifest[field] !== expected) throw new Error(`release manifest ${field} mismatch`);
  }
  if (verified.approval.partial === true) {
    if (releaseManifest.partial !== true) throw new Error('release manifest partial flag mismatch');
    if (digestJSON(releaseManifest.excludedPages ?? null) !== digestJSON(excludedPageNames(verified.approval))) {
      throw new Error('release manifest excluded pages mismatch');
    }
  } else if (releaseManifest.partial !== undefined || releaseManifest.excludedPages !== undefined) {
    throw new Error('release manifest partial flag mismatch');
  }
  assertDigest('releaseDigest', releaseManifest.releaseDigest);
  if (computeReleaseDigest(releaseManifest) !== releaseManifest.releaseDigest) {
    throw new Error('release manifest digest mismatch');
  }
  if (digestJSON(releaseManifest.payloadManifest) !== releaseManifest.payloadManifestDigest) {
    throw new Error('release payload manifest digest mismatch');
  }
  const releasePayload = join(releaseDir, 'payload');
  const closure = verifyFileManifest(releasePayload, releaseManifest.payloadManifest);
  if (!closure.ok) throw new Error(`release payload is invalid: ${closure.errors.join('; ')}`);

  const releasedApproval = readJsonRegular(join(releasePayload, 'approval.json'), releasePayload, 'released approval');
  if (computeApprovalDigest(releasedApproval) !== releasedApproval.approvalDigest
      || releasedApproval.approvalDigest !== verified.approval.approvalDigest) {
    throw new Error('released approval digest mismatch');
  }
  const releasedRun = readJsonRegular(join(releasePayload, 'evidence', 'suite-run.json'), releasePayload, 'released suite run');
  if (computeSuiteResultDigest(releasedRun) !== releasedRun.suiteResultDigest
      || releasedRun.suiteResultDigest !== verified.suiteRun.suiteResultDigest) {
    throw new Error('released suite result digest mismatch');
  }
  const releasedEvidenceManifest = readJsonRegular(
    join(releasePayload, 'evidence', 'evidence-manifest.json'),
    releasePayload,
    'released evidence manifest',
  );
  if (digestJSON(releasedEvidenceManifest) !== verified.suiteRun.evidenceManifestDigest) {
    throw new Error('released evidence manifest digest mismatch');
  }
  const nestedEvidence = verifyFileManifest(
    join(releasePayload, 'evidence', 'payload'),
    releasedEvidenceManifest,
  );
  if (!nestedEvidence.ok) throw new Error(`released evidence is invalid: ${nestedEvidence.errors.join('; ')}`);
  verifyPublicationFiles(
    join(releasePayload, 'publication'),
    resolvePublicationInclude(verified),
    verified.currentSnapshot,
  );
  return { releaseManifest };
}

function assertPublishMode(approval, options) {
  const requestedPartial = options?.partial === true;
  const approvedPartial = approval?.partial === true;
  if (approvedPartial && !requestedPartial) {
    throw new Error('suite run has a partial approval; publish it with --partial');
  }
  if (!approvedPartial && requestedPartial) {
    throw new Error('suite run has a full approval; --partial can only publish a partial-approved run');
  }
}

function resolvePublicationInclude(verified) {
  if (verified.approval?.partial !== true) return verified.plan.publication.include;
  const excluded = new Set(verified.approval.excludedPages.map(({ name }) => name));
  const kept = new Set(verified.plan.shared.sources);
  const removed = new Set();
  for (const page of verified.plan.pages) {
    const capturePath = pageCapturePath(verified.root, page.name);
    if (!capturePath) continue;
    if (excluded.has(page.name)) removed.add(capturePath);
    else kept.add(capturePath);
  }
  return verified.plan.publication.include.filter((path) => {
    if (kept.has(path)) return true;
    if (removed.has(path)) return false;
    const segments = path.split('/');
    const owner = segments[0] === 'pages' && segments.length > 2 ? segments[1] : null;
    return !(owner && excluded.has(owner));
  });
}

function pageCapturePath(root, page) {
  const restorePlan = readJsonRegular(
    join(root, 'pages', page, 'restore-plan.json'),
    root,
    `restore plan for page ${page}`,
  );
  const capturePath = restorePlan?.capture?.path;
  return typeof capturePath === 'string' ? capturePath.trim() : '';
}

function partialExcludedPages(verified) {
  const eligibility = verified.recomputedGate?.partial;
  return (eligibility?.excludedPages || []).map(({ name, reasons }) => ({
    name,
    reasons,
    escalation: readPageEscalation(verified.payloadDir, name),
  }));
}

function readPageEscalation(payloadDir, page) {
  const ledgerPath = join(payloadDir, 'pages', page, 'audit-ledger.json');
  if (!existsSync(ledgerPath)) return null;
  const ledger = readJsonRegular(ledgerPath, payloadDir, `audit ledger for page ${page}`);
  return ledger?.convergence ?? null;
}

function excludedPageNames(approval) {
  return (approval?.excludedPages || []).map(({ name }) => name).sort(byteCompare);
}

function verifyApprovalObject(approval, verified) {
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) throw new Error('invalid suite approval');
  const unknown = Object.keys(approval).filter((field) => !APPROVAL_FIELDS.has(field));
  if (unknown.length) throw new Error(`suite approval has unknown fields: ${unknown.join(', ')}`);
  if (approval.schemaVersion !== '1.0') throw new Error('suite approval has an unsupported schema version');
  requiredText(approval.approver, 'approver', 240);
  requiredText(approval.reason, 'reason', 2000);
  validateTimestamp(approval.approvedAt, 'approvedAt');
  validateApprovalPartialShape(approval);
  assertDigest('approvalDigest', approval.approvalDigest);
  if (computeApprovalDigest(approval) !== approval.approvalDigest) throw new Error('suite approval digest mismatch');

  const bindings = [
    ['suiteId', verified.suiteId],
    ['runId', verified.runId],
    ['suiteResultDigest', verified.suiteRun.suiteResultDigest],
    ['inputSnapshotDigest', verified.suiteRun.inputSnapshotDigest],
    ['evidenceManifestDigest', verified.suiteRun.evidenceManifestDigest],
    ['gateDigest', verified.suiteRun.gateDigest],
  ];
  for (const [field, expected] of bindings) {
    if (approval[field] !== expected) throw new Error(`suite approval ${field} mismatch`);
  }

  if (approval.partial === true) {
    if (verified.gate.pass === true) {
      throw new Error('partial suite approval exists for a passing suite gate');
    }
    if (verified.recomputedGate?.partial?.eligible !== true) {
      throw new Error('suite run is not eligible for its recorded partial approval');
    }
    if (digestJSON(approval.excludedPages) !== digestJSON(partialExcludedPages(verified))) {
      throw new Error('suite approval excluded pages do not match the recomputed partial eligibility');
    }
  }
}

function validateApprovalPartialShape(approval) {
  if (approval.partial === undefined && approval.excludedPages === undefined) return;
  if (approval.partial !== true) throw new Error('suite approval partial flag must be true when present');
  if (!Array.isArray(approval.excludedPages) || approval.excludedPages.length === 0) {
    throw new Error('partial suite approval requires a non-empty excludedPages list');
  }
  for (const entry of approval.excludedPages) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('partial suite approval excluded pages must be objects');
    }
    const unknown = Object.keys(entry).filter((field) => !EXCLUDED_PAGE_FIELDS.has(field));
    if (unknown.length) {
      throw new Error(`partial suite approval excluded page has unknown fields: ${unknown.join(', ')}`);
    }
    requiredText(entry.name, 'excluded page name', 160);
    if (!Array.isArray(entry.reasons) || entry.reasons.some((reason) => typeof reason !== 'string')) {
      throw new Error('partial suite approval excluded page reasons must be a string array');
    }
    if (entry.escalation === undefined) {
      throw new Error('partial suite approval excluded page must record escalation (or null)');
    }
  }
}

function sameApprovalRequest(left, right) {
  return left.suiteId === right.suiteId
    && left.runId === right.runId
    && left.suiteResultDigest === right.suiteResultDigest
    && left.inputSnapshotDigest === right.inputSnapshotDigest
    && left.evidenceManifestDigest === right.evidenceManifestDigest
    && left.gateDigest === right.gateDigest
    && left.approver === right.approver
    && left.reason === right.reason
    && (left.partial === true) === (right.partial === true)
    && digestJSON(left.excludedPages ?? null) === digestJSON(right.excludedPages ?? null);
}

function resolvePlan(plan, suiteId, root) {
  if (plan === undefined) return loadSuitePlan(suiteId, { root });
  return normalizeSuitePlan(plan, { root, suiteId });
}

function verifyClosedSuiteEvidence({
  projectRoot,
  payloadDir,
  normalizedPlan,
  suiteRun,
  gate,
  inputSnapshot,
  currentSnapshot,
  suiteId,
  runId,
}) {
  const recordedPlanRaw = readJsonRegular(join(payloadDir, 'suite-plan.json'), payloadDir, 'suite-plan.json');
  const recordedPlan = normalizeSuitePlan(recordedPlanRaw, { root: projectRoot, suiteId });
  if (digestJSON(recordedPlan) !== digestJSON(normalizedPlan)) {
    throw new Error('recorded suite plan does not match the current suite plan');
  }
  if (inputSnapshot.planDigest !== digestJSON(normalizedPlan)) {
    throw new Error('input snapshot plan digest mismatch');
  }

  const pageResults = readObjectEvidence(join(payloadDir, 'page-results.json'), payloadDir, 'page-results.json');
  const consistency = readObjectEvidence(join(payloadDir, 'consistency.json'), payloadDir, 'consistency.json');
  const tokens = readObjectEvidence(join(payloadDir, 'tokens.json'), payloadDir, 'tokens.json');
  const findings = readObjectEvidence(join(payloadDir, 'findings.json'), payloadDir, 'findings.json');
  const expectedPageNames = normalizedPlan.pages.map((page) => page.name);
  const actualPageNames = Object.keys(pageResults).sort(byteCompare);
  if (JSON.stringify(actualPageNames) !== JSON.stringify([...expectedPageNames].sort(byteCompare))) {
    throw new Error('page results do not exactly cover the suite plan');
  }

  for (const page of normalizedPlan.pages) {
    const result = pageResults[page.name];
    if (!result || result.page !== page.name) throw new Error(`page result identity mismatch: ${page.name}`);
    if (result.inputDigest !== inputSnapshot.inputDigest) throw new Error(`page result input digest mismatch: ${page.name}`);
    if (typeof result.fresh !== 'boolean' || typeof result.ok !== 'boolean') {
      throw new Error(`page result status is invalid: ${page.name}`);
    }
    if (!result.gate || typeof result.gate !== 'object' || Array.isArray(result.gate)) {
      throw new Error(`page result gate is invalid: ${page.name}`);
    }
    const closedPageGate = readJsonRegular(
      join(payloadDir, 'pages', page.name, 'page-gate.json'),
      payloadDir,
      `page Gate evidence for ${page.name}`,
    );
    if (digestJSON(result.gate) !== digestJSON(closedPageGate)) {
      throw new Error(`page Gate evidence does not match page result gate: ${page.name}`);
    }
    const requiredMissing = Array.isArray(result.evidence?.requiredMissing)
      ? result.evidence.requiredMissing
      : [];
    const expectedOk = result.gate.pass === true
      && result.fresh === true
      && result.auditExitCode === 0
      && requiredMissing.length === 0;
    if (result.ok !== expectedOk) throw new Error(`page result ok flag is inconsistent: ${page.name}`);
  }

  const expectedRunPages = normalizedPlan.pages.map(({ name, required }) => ({
    name,
    required,
    ok: pageResults[name].ok,
    inputDigest: inputSnapshot.inputDigest,
  }));
  if (digestJSON(suiteRun.pages) !== digestJSON(expectedRunPages)) {
    throw new Error('suite run pages do not match closed page results');
  }
  if (suiteRun.strict !== undefined && typeof suiteRun.strict !== 'boolean') {
    throw new Error('suite run strict policy must be boolean');
  }

  const recomputedGate = buildSuiteGateResult({
    suiteId,
    runId,
    plan: normalizedPlan,
    inputSnapshot,
    currentSnapshot,
    pageResults,
    consistency,
    tokens,
    findings,
    strict: suiteRun.strict === true,
  });
  if (computeGateDigest(recomputedGate) !== gate.gateDigest) {
    throw new Error('recomputed Suite Gate does not match recorded gate evidence');
  }
  // pages/partial are excluded from the historical gate digest; when the
  // recorded gate carries them they must still agree with the recomputation.
  if (gate.pages !== undefined && digestJSON(gate.pages) !== digestJSON(recomputedGate.pages)) {
    throw new Error('recorded suite gate pages do not match the recomputed adjudication');
  }
  if (gate.partial !== undefined && digestJSON(gate.partial) !== digestJSON(recomputedGate.partial)) {
    throw new Error('recorded suite gate partial eligibility does not match the recomputation');
  }
  return { recordedPlan, pageResults, consistency, tokens, findings, recomputedGate };
}

function readObjectEvidence(path, root, label) {
  const value = readJsonRegular(path, root, label);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

function verifySnapshotObject(snapshot, suiteId, label) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error(`${label} is invalid`);
  if (snapshot.suiteId !== suiteId) throw new Error(`${label} suite identity mismatch`);
  assertDigest(`${label} inputDigest`, snapshot.inputDigest);
  const { inputDigest, ...base } = snapshot;
  if (digestJSON(base) !== inputDigest) throw new Error(`${label} digest mismatch`);
}

function verifyPublicationFiles(publicationRoot, include, snapshot) {
  const expectedPaths = [...include].sort(byteCompare);
  const actualManifest = buildFileManifest(publicationRoot);
  const actualPaths = actualManifest.files.map((entry) => entry.path).sort(byteCompare);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('release publication contains missing or undeclared files');
  }
  const snapshotFiles = new Map((snapshot.files || []).map((file) => [file.path, file]));
  const releaseFiles = new Map(actualManifest.files.map((file) => [file.path, file]));
  for (const path of expectedPaths) {
    const expected = snapshotFiles.get(path);
    const actual = releaseFiles.get(path);
    if (!expected || !actual || expected.sha256 !== actual.sha256 || expected.bytes !== actual.size) {
      throw new Error(`release publication does not match input snapshot: ${path}`);
    }
  }
}

function assertReleaseRootShape(releaseDir) {
  const entries = readdirSync(releaseDir, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort(byteCompare);
  if (JSON.stringify(names) !== JSON.stringify(['payload', 'release-manifest.json'])) {
    throw new Error(`release root contains undeclared entries: ${names.join(', ')}`);
  }
  for (const entry of entries) {
    const path = join(releaseDir, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in release: ${entry.name}`);
    if (entry.name === 'payload' ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`invalid release entry: ${entry.name}`);
    }
  }
}

function copyRegularFile(source, target, allowedRoot, label) {
  const bytes = readRegularBytes(source, allowedRoot, label);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
}

function readJsonRegular(path, allowedRoot, label) {
  const bytes = readRegularBytes(path, allowedRoot, label);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid JSON in ${label}: ${error.message}`);
  }
}

function readRegularBytes(path, allowedRoot, label) {
  const target = resolve(path);
  assertContained(target, resolve(allowedRoot), label);
  assertRegularPath(target, resolve(allowedRoot), label);
  let descriptor;
  try {
    descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    return readFileSync(descriptor);
  } catch (error) {
    throw new Error(`cannot read regular file ${label}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertRegularPath(target, allowedRoot, label) {
  const fromRoot = relative(allowedRoot, target);
  let current = allowedRoot;
  for (const segment of fromRoot.split(sep)) {
    if (!segment) continue;
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`${label} does not exist`);
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${label}`);
  }
  if (!lstatSync(target).isFile()) throw new Error(`${label} is not a regular file`);
}

function assertDirectory(path, allowedRoot, label) {
  const target = resolve(path);
  const root = resolve(allowedRoot);
  assertContained(target, root, label);
  const fromRoot = relative(root, target);
  let current = root;
  for (const segment of fromRoot.split(sep)) {
    if (!segment) continue;
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`${label} directory does not exist`);
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in ${label} path`);
    if (!stat.isDirectory()) throw new Error(`${label} path is not a directory`);
  }
}

function ensureSafeDirectoryChain(root, segments) {
  let current = resolve(root);
  for (const segment of segments) {
    current = join(current, segment);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in release path: ${segment}`);
      if (!stat.isDirectory()) throw new Error(`release path is not a directory: ${segment}`);
    } else {
      mkdirSync(current, { mode: 0o700 });
    }
  }
}

function assertContained(target, root, label) {
  const fromRoot = relative(root, target);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escapes its allowed root`);
  }
}

function normalizeRelativePath(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  if (posix.normalize(value) !== value) throw new Error(`${label} must be normalized`);
  return value;
}

function assertSafeId(kind, value) {
  const id = String(value ?? '');
  if (!SAFE_ID.test(id)) throw new Error(`invalid ${kind} id: ${value}`);
  return id;
}

function assertDigest(label, value) {
  if (!SHA256.test(String(value ?? ''))) throw new Error(`${label} must be a SHA-256 digest`);
}

function requiredText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must not be empty`);
  const text = value.trim();
  if (text.length > maxLength) throw new Error(`${label} is too long`);
  if (/[\0\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error(`${label} contains control characters`);
  return text;
}

function timestampFromClock(clock, label) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} clock returned an invalid timestamp`);
  return date.toISOString();
}

function validateTimestamp(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
}

function digestWithout(value, omitted, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const copy = { ...value };
  for (const field of omitted) delete copy[field];
  return digestJSON(copy);
}

function byteCompare(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function syncDirectory(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
