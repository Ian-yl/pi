import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import {
  atomicWriteJson,
  buildFileManifest,
  commitImmutableDirectory,
  createRunStaging,
  verifyFileManifest,
} from './suite-artifacts.mjs';
import { normalizeSuitePlan } from './suite-config.mjs';
import { buildSuiteInputSnapshot, computePageClosureDigest, digestJSON } from './suite-digest.mjs';
import { acquirePageOutputLocks } from './page-output-lock.mjs';
import { evaluateSuiteConsistency } from './suite-consistency.mjs';
import { fuseSuiteFindings } from './suite-fusion.mjs';
import { buildSuiteGateResult } from './suite-gate.mjs';
import { computeGateDigest, computeSuiteResultDigest } from './suite-release.mjs';
import { runExemplarFirst, runPagePool } from './suite-runner.mjs';
import {
  buildTokenAuditInputs,
  evaluateTokenConsistency,
} from '../suite-token-audit.mjs';

const { PNG } = pngjs;
const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;
const MAX_CHILD_OUTPUT = 20 * 1024 * 1024;

export function parseSuiteAuditArgs(argv) {
  const options = {
    suiteId: null,
    runId: null,
    concurrency: 2,
    skipAssets: false,
    strict: false,
    incremental: false,
    baselineRun: null,
  };
  for (const argument of argv) {
    if (argument === '--skip-assets') options.skipAssets = true;
    else if (argument === '--strict') options.strict = true;
    else if (argument === '--incremental') options.incremental = true;
    else if (argument.startsWith('--baseline-run=')) {
      options.baselineRun = argument.slice('--baseline-run='.length);
    } else if (argument.startsWith('--run-id=')) options.runId = argument.slice('--run-id='.length);
    else if (argument.startsWith('--concurrency=')) {
      options.concurrency = Number(argument.slice('--concurrency='.length));
    } else if (argument.startsWith('--')) throw new Error(`unknown option: ${argument}`);
    else if (!options.suiteId) options.suiteId = argument;
    else throw new Error(`unexpected argument: ${argument}`);
  }
  assertSafeId('suite', options.suiteId);
  if (options.runId !== null) assertSafeId('run', options.runId);
  if (options.baselineRun !== null) {
    if (!options.incremental) throw new Error('--baseline-run requires --incremental');
    assertSafeId('baseline run', options.baselineRun);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
    throw new Error('concurrency must be an integer between 1 and 16');
  }
  return options;
}

export async function executeSuiteAudit({
  root = process.cwd(),
  plan,
  snapshot = null,
  currentSnapshot = null,
  runId = createRunId(),
  concurrency = 2,
  skipAssets = false,
  strict = false,
  incremental = false,
  baselineRun = null,
  clock = () => new Date(),
  pageWorker = defaultPageWorker,
} = {}) {
  const projectRoot = resolve(root);
  const normalizedPlan = normalizeSuitePlan(plan, {
    root: projectRoot,
    suiteId: plan?.suiteId,
  });
  assertSafeId('suite', normalizedPlan.suiteId);
  assertSafeId('run', runId);
  if (typeof incremental !== 'boolean') throw new Error('incremental must be boolean');
  if (baselineRun !== null) {
    if (!incremental) throw new Error('baselineRun requires incremental mode');
    assertSafeId('baseline run', baselineRun);
  }
  const inputSnapshot = snapshot ?? buildSuiteInputSnapshot(normalizedPlan, { root: projectRoot });
  assertSnapshot(inputSnapshot, normalizedPlan.suiteId);
  const pageLocks = acquirePageOutputLocks({
    root: projectRoot,
    pages: normalizedPlan.pages,
    suiteId: normalizedPlan.suiteId,
    runId,
  });
  let staging = null;

  try {
    const reuse = incremental
      ? resolveIncrementalReuse({
        root: projectRoot,
        plan: normalizedPlan,
        requestedRunId: baselineRun,
        strict,
        skipAssets,
      })
      : null;
    staging = createRunStaging(projectRoot, normalizedPlan.suiteId, runId);
    const payload = join(staging, 'payload');
    mkdirSync(payload, { recursive: true });
    atomicWriteJson(join(payload, 'suite-plan.json'), normalizedPlan);
    atomicWriteJson(join(payload, 'input-snapshot.json'), inputSnapshot);

    const reusedResults = new Map();
    if (reuse?.baseline) {
      for (const page of normalizedPlan.pages) {
        if (!reuse.candidates.has(page.name)) continue;
        const restored = restoreBaselinePageEvidence({
          root: projectRoot,
          baseline: reuse.baseline,
          page: page.name,
          destination: join(payload, 'pages', page.name),
        });
        if (!restored.ok) {
          reuse.fallbacks.push({ page: page.name, reason: restored.reason });
          continue;
        }
        reusedResults.set(page.name, {
          ...restored.entry,
          inputDigest: inputSnapshot.inputDigest,
          reusedFrom: reuse.baseline.runId,
        });
      }
    }
    const executingPages = reuse
      ? normalizedPlan.pages.filter((page) => !reusedResults.has(page.name))
      : normalizedPlan.pages;
    const pageExecutions = await runSuitePages({
      pages: executingPages,
      exemplar: normalizedPlan.exemplar,
      concurrency,
      worker: async (page) => executePage({
        root: projectRoot,
        page: page.name,
        suiteId: normalizedPlan.suiteId,
        runId,
        destination: join(payload, 'pages', page.name),
        skipAssets,
        strictPages: normalizedPlan.gate.strictPages,
        lockToken: pageLocks.token,
        pageWorker,
      }),
    });

    const executedResults = Object.fromEntries(pageExecutions.map((execution) => {
      const gate = execution.pageGate || execution.gate || failedPageGate(execution.error);
      const effectiveGate = execution.ok !== false
          && execution.auditExitCode === 0
          && execution.evidence?.requiredMissing?.length === 0
        ? gate
        : forceFailedPageGate(gate, execution);
      return [execution.page, {
        page: execution.page,
        ok: execution.ok !== false && effectiveGate.pass === true,
        inputDigest: inputSnapshot.inputDigest,
        fresh: effectiveGate.fresh === true,
        auditExitCode: execution.auditExitCode ?? null,
        gate: effectiveGate,
        evidence: execution.evidence || { copied: [], requiredMissing: [], optionalMissing: [] },
        ...(execution.error ? { error: execution.error, errorCode: execution.errorCode } : {}),
      }];
    }));
    const pageResults = reuse
      ? Object.fromEntries(normalizedPlan.pages.map(({ name }) => [
        name,
        reusedResults.get(name) ?? executedResults[name],
      ]))
      : executedResults;
    for (const page of normalizedPlan.pages) {
      const pageDirectory = join(payload, 'pages', page.name);
      mkdirSync(pageDirectory, { recursive: true });
      atomicWriteJson(join(pageDirectory, 'page-gate.json'), pageResults[page.name].gate);
    }
    atomicWriteJson(join(payload, 'page-results.json'), pageResults);

    const consistency = readConsistencyEvidence(normalizedPlan, payload);
    atomicWriteJson(join(payload, 'consistency.json'), consistency);
    const tokens = evaluateTokens(normalizedPlan, projectRoot);
    atomicWriteJson(join(payload, 'tokens.json'), tokens);

    const pageFindings = Object.fromEntries(normalizedPlan.pages.map(({ name }) => [
      name,
      readPageFindings(join(payload, 'pages', name, 'findings.json')),
    ]));
    const findings = fuseSuiteFindings({
      plan: normalizedPlan,
      pageFindings,
      consistencyFindings: consistency.findings,
      tokenFindings: tokens.findings,
    });
    atomicWriteJson(join(payload, 'findings.json'), findings);

    const afterSnapshot = currentSnapshot
      ?? (snapshot ? inputSnapshot : buildSuiteInputSnapshot(normalizedPlan, { root: projectRoot }));
    const precursorManifest = buildFileManifest(payload);
    const precursorVerification = verifyFileManifest(payload, precursorManifest);
    if (!precursorVerification.ok) {
      throw new Error(`cannot verify suite evidence precursor: ${precursorVerification.errors.join('; ')}`);
    }
    const gateBase = buildSuiteGateResult({
      suiteId: normalizedPlan.suiteId,
      runId,
      plan: normalizedPlan,
      inputSnapshot,
      currentSnapshot: afterSnapshot,
      pageResults,
      consistency,
      tokens,
      findings,
      strict,
    });
    const gate = { ...gateBase, gateDigest: computeGateDigest(gateBase) };
    atomicWriteJson(join(payload, 'suite-gate.json'), gate);

    const evidenceManifest = buildFileManifest(payload);
    const verification = verifyFileManifest(payload, evidenceManifest);
    if (!verification.ok) {
      throw new Error(`cannot verify suite evidence: ${verification.errors.join('; ')}`);
    }
    const evidenceManifestDigest = digestJSON(evidenceManifest);
    const suiteRunBase = {
      schemaVersion: '1.0',
      suiteId: normalizedPlan.suiteId,
      runId,
      status: 'complete',
      inputSnapshotDigest: inputSnapshot.inputDigest,
      evidenceManifestDigest,
      gateDigest: gate.gateDigest,
      exemplar: normalizedPlan.exemplar,
      ...(strict ? { strict: true } : {}),
      ...(reuse ? {
        incremental: buildIncrementalRecord({
          plan: normalizedPlan,
          reuse,
          reusedResults,
          strict,
          skipAssets,
        }),
      } : {}),
      pages: normalizedPlan.pages.map(({ name, required }) => ({
        name,
        required,
        ok: pageResults[name]?.ok === true,
        inputDigest: inputSnapshot.inputDigest,
      })),
    };
    const suiteRun = {
      ...suiteRunBase,
      suiteResultDigest: computeSuiteResultDigest(suiteRunBase),
      generatedAt: clock().toISOString(),
    };
    atomicWriteJson(join(staging, 'evidence-manifest.json'), evidenceManifest);
    atomicWriteJson(join(staging, 'suite-run.json'), suiteRun);

    const finalDir = join(dirname(staging), runId);
    commitImmutableDirectory(staging, finalDir);
    return { runDir: finalDir, suiteRun, gate, pageResults, consistency, tokens, findings };
  } catch (error) {
    if (staging && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    pageLocks.release();
  }
}

async function runSuitePages({ pages, exemplar, concurrency, worker }) {
  if (pages.length === 0) return [];
  if (pages.some((page) => page.name === exemplar)) {
    return runExemplarFirst({ pages, exemplar, concurrency, worker });
  }
  return runPagePool({ pages, concurrency, worker });
}

function resolveIncrementalReuse({ root, plan, requestedRunId, strict, skipAssets }) {
  const closures = {};
  const fallbacks = [];
  for (const page of plan.pages) {
    try {
      closures[page.name] = computePageClosureDigest(plan, page.name, { root });
    } catch (error) {
      fallbacks.push({ page: page.name, reason: `page closure digest unavailable: ${error.message}` });
    }
  }
  const context = { baseline: null, note: null, closures, fallbacks, candidates: new Set() };
  const selected = selectBaselineRun({ root, suiteId: plan.suiteId, requestedRunId });
  if (!selected.runId) {
    context.note = selected.reason;
    return context;
  }
  const baseline = loadBaselineRun({ root, suiteId: plan.suiteId, runId: selected.runId });
  if (!baseline.ok) {
    context.note = `baseline run ${selected.runId} is not reusable: ${baseline.reason}`;
    return context;
  }
  const options = baseline.suiteRun.incremental?.options;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    context.note = `baseline run ${selected.runId} does not record audit options; executed all pages`;
    return context;
  }
  if (options.strict !== strict || options.skipAssets !== skipAssets) {
    context.note = `baseline run ${selected.runId} audit options differ; executed all pages`;
    return context;
  }
  const recordedClosures = baseline.suiteRun.incremental?.pageClosures;
  if (!recordedClosures || typeof recordedClosures !== 'object' || Array.isArray(recordedClosures)) {
    context.note = `baseline run ${selected.runId} does not record page closures; executed all pages`;
    return context;
  }
  context.baseline = baseline;
  for (const page of plan.pages) {
    const digest = closures[page.name];
    if (typeof digest !== 'string') continue;
    const recorded = recordedClosures[page.name];
    if (typeof recorded !== 'string' || !recorded) {
      fallbacks.push({ page: page.name, reason: 'baseline run has no page closure digest' });
      continue;
    }
    if (recorded === digest) context.candidates.add(page.name);
  }
  return context;
}

function selectBaselineRun({ root, suiteId, requestedRunId }) {
  const runsRoot = join(root, 'output', 'suites', suiteId, 'runs');
  if (requestedRunId) {
    if (!existsSync(join(runsRoot, requestedRunId, 'suite-run.json'))) {
      throw new Error(`baseline run not found: ${requestedRunId}`);
    }
    return { runId: requestedRunId };
  }
  if (!existsSync(runsRoot)) {
    return { runId: null, reason: 'no committed suite runs found; executed all pages' };
  }
  let best = null;
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
    let suiteRun;
    try {
      suiteRun = JSON.parse(readFileSync(join(runsRoot, entry.name, 'suite-run.json'), 'utf8'));
    } catch {
      continue;
    }
    if (suiteRun?.schemaVersion !== '1.0' || suiteRun.suiteId !== suiteId || suiteRun.runId !== entry.name) continue;
    if (suiteRun.status !== 'complete' || typeof suiteRun.generatedAt !== 'string') continue;
    const committedAt = Date.parse(suiteRun.generatedAt);
    if (!Number.isFinite(committedAt)) continue;
    if (!best
        || committedAt > best.committedAt
        || (committedAt === best.committedAt && byteCompare(entry.name, best.runId) > 0)) {
      best = { runId: entry.name, committedAt };
    }
  }
  if (!best) return { runId: null, reason: 'no reusable baseline run found; executed all pages' };
  return { runId: best.runId };
}

function loadBaselineRun({ root, suiteId, runId }) {
  const runDir = join(root, 'output', 'suites', suiteId, 'runs', runId);
  try {
    const suiteRun = readJsonRegular(root, join(runDir, 'suite-run.json'), `baseline suite run ${runId}`);
    if (suiteRun?.schemaVersion !== '1.0' || suiteRun.suiteId !== suiteId || suiteRun.runId !== runId) {
      throw new Error('baseline suite run identity mismatch');
    }
    if (suiteRun.status !== 'complete') {
      throw new Error(`baseline suite run is not complete: ${suiteRun.status || 'missing status'}`);
    }
    if (computeSuiteResultDigest(suiteRun) !== suiteRun.suiteResultDigest) {
      throw new Error('baseline suite result digest mismatch');
    }
    const manifest = readJsonRegular(root, join(runDir, 'evidence-manifest.json'), `baseline evidence manifest ${runId}`);
    if (digestJSON(manifest) !== suiteRun.evidenceManifestDigest) {
      throw new Error('baseline evidence manifest digest mismatch');
    }
    if (manifest.schemaVersion !== '1.0' || !Array.isArray(manifest.files)) {
      throw new Error('baseline evidence manifest is invalid');
    }
    const files = new Map();
    for (const file of manifest.files) {
      if (!file || typeof file.path !== 'string') throw new Error('baseline evidence manifest is invalid');
      files.set(file.path, file);
    }
    const payloadDir = join(runDir, 'payload');
    const pageResults = JSON.parse(readBaselinePayloadFile({
      root,
      payloadDir,
      files,
      path: 'page-results.json',
    }).toString('utf8'));
    if (!pageResults || typeof pageResults !== 'object' || Array.isArray(pageResults)) {
      throw new Error('baseline page results are invalid');
    }
    return { ok: true, runId, runDir, payloadDir, files, suiteRun, pageResults };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function restoreBaselinePageEvidence({ root, baseline, page, destination }) {
  const prefix = `pages/${page}/`;
  try {
    const entry = baseline.pageResults[page];
    if (!entry || entry.page !== page || typeof entry.ok !== 'boolean' || typeof entry.fresh !== 'boolean'
        || !entry.gate || typeof entry.gate !== 'object' || Array.isArray(entry.gate)) {
      throw new Error('baseline page result is missing or invalid');
    }
    const paths = [...baseline.files.keys()].filter((path) => path.startsWith(prefix)).sort(byteCompare);
    const expected = new Set([
      `${prefix}page-gate.json`,
      ...(Array.isArray(entry.evidence?.copied) ? entry.evidence.copied : [])
        .map((relativePath) => `${prefix}${relativePath}`),
    ]);
    if (paths.length !== expected.size || paths.some((path) => !expected.has(path))) {
      throw new Error('baseline page evidence is incomplete');
    }
    mkdirSync(destination, { recursive: true });
    for (const path of paths) {
      const bytes = readBaselinePayloadFile({
        root,
        payloadDir: baseline.payloadDir,
        files: baseline.files,
        path,
      });
      const target = join(destination, ...path.slice(prefix.length).split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    return { ok: true, entry };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    return { ok: false, reason: error.message };
  }
}

function readBaselinePayloadFile({ root, payloadDir, files, path }) {
  const declared = files.get(path);
  if (!declared) throw new Error(`baseline evidence is not declared: ${path}`);
  assertSafeEvidencePath(path);
  const source = join(payloadDir, ...path.split('/'));
  if (!existsSync(source)) throw new Error(`baseline evidence is missing: ${path}`);
  assertRegularNoSymlink(root, source, `baseline evidence ${path}`);
  const bytes = readRegularNoFollow(source, `baseline evidence ${path}`);
  if (bytes.length !== declared.size || sha256Hex(bytes) !== declared.sha256) {
    throw new Error(`baseline evidence hash mismatch: ${path}`);
  }
  return bytes;
}

function buildIncrementalRecord({ plan, reuse, reusedResults, strict, skipAssets }) {
  return {
    baselineRun: reuse.baseline ? reuse.baseline.runId : null,
    options: { strict, skipAssets },
    reusedPages: [...reusedResults.keys()].sort(byteCompare),
    executedPages: plan.pages
      .map(({ name }) => name)
      .filter((name) => !reusedResults.has(name))
      .sort(byteCompare),
    pageClosures: Object.fromEntries(
      Object.entries(reuse.closures).sort(([left], [right]) => byteCompare(left, right)),
    ),
    ...(reuse.note ? { note: reuse.note } : {}),
    ...(reuse.fallbacks.length ? {
      fallbacks: [...reuse.fallbacks].sort((left, right) => byteCompare(left.page, right.page)),
    } : {}),
  };
}

function assertSafeEvidencePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0')) {
    throw new Error(`invalid baseline evidence path: ${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`invalid baseline evidence path: ${path}`);
  }
}

function readRegularNoFollow(source, label) {
  let descriptor;
  try {
    descriptor = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(descriptor).isFile()) throw new Error('source is not a regular file');
    return readFileSync(descriptor);
  } catch (error) {
    throw new Error(`cannot read regular ${label}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function executePage({
  root,
  page,
  suiteId,
  runId,
  destination,
  skipAssets,
  strictPages,
  lockToken,
  pageWorker,
}) {
  const workerResult = await pageWorker({
    root,
    page,
    suiteId,
    runId,
    skipAssets,
    strict: strictPages,
    lockToken,
  });
  const evidence = collectPageEvidence({ root, page, destination });
  const pageGate = workerResult?.pageGate || workerResult?.gate || failedPageGate('page worker did not return a gate');
  return { ...workerResult, page, pageGate, evidence };
}

export function collectPageEvidence({ root, page, destination }) {
  assertSafePage(page);
  const projectRoot = resolve(root);
  const outputRoot = join(projectRoot, 'output', page);
  const ledgerPath = join(outputRoot, 'audit-ledger.json');
  const ledger = readJsonRegular(projectRoot, ledgerPath, 'audit ledger');
  const required = (ledger?.artifacts?.required || []).map((artifact) => artifact?.path).filter(Boolean);
  const optional = (ledger?.artifacts?.optional || []).map((artifact) => artifact?.path).filter(Boolean);
  const logs = (ledger?.commands || []).map((command) => command?.log).filter(Boolean);
  const core = [
    `output/${page}/audit-ledger.json`,
    ...(existsSync(join(outputRoot, 'remediation-queue.json'))
      ? [`output/${page}/remediation-queue.json`]
      : []),
  ];
  const requiredSet = new Set(required);
  const references = [...new Set([...core, ...required, ...optional, ...logs])].sort(byteCompare);
  const copied = [];
  const requiredMissing = [];
  const optionalMissing = [];
  const inputReferences = [];
  mkdirSync(destination, { recursive: true });

  for (const reference of references) {
    if (isBoundPageInput(page, reference)) {
      inputReferences.push(reference);
      continue;
    }
    const source = resolveEvidenceReference(projectRoot, outputRoot, page, reference);
    const relativePath = relative(outputRoot, source).split(sep).join('/');
    if (!existsSync(source)) {
      if (requiredSet.has(reference) || core.includes(reference)) requiredMissing.push(reference);
      else optionalMissing.push(reference);
      continue;
    }
    assertRegularNoSymlink(projectRoot, source, reference);
    const target = join(destination, ...relativePath.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    copyRegularNoFollow(source, target, reference);
    copied.push(relativePath);
  }
  return { copied, requiredMissing, optionalMissing, inputReferences };
}

export async function defaultPageWorker({ root, page, skipAssets = false, strict = true, lockToken = null }) {
  const auditArgs = [join(TOOL_DIR, 'audit-runner.mjs'), page];
  if (skipAssets) auditArgs.push('--skip-assets');
  const childEnv = lockToken ? { VISUAL_RESTORE_PAGE_LOCK_TOKEN: lockToken } : {};
  const audit = await runChild(process.execPath, auditArgs, root, childEnv);
  const gateArgs = [join(TOOL_DIR, 'coverage-gate.mjs'), page, '--json'];
  if (strict) gateArgs.push('--strict');
  const gateRun = await runChild(process.execPath, gateArgs, root, childEnv);
  let pageGate;
  try {
    pageGate = parseJsonOutput(gateRun.stdout);
  } catch (error) {
    pageGate = failedPageGate(`coverage gate did not return JSON: ${error.message}`);
  }
  return {
    auditExitCode: audit.exitCode,
    gateExitCode: gateRun.exitCode,
    pageGate,
    logs: {
      auditStdoutTail: tail(audit.stdout),
      auditStderrTail: tail(audit.stderr),
      gateStderrTail: tail(gateRun.stderr),
    },
  };
}

function readConsistencyEvidence(plan, payload) {
  const inventories = {};
  const pageImages = {};
  for (const { name } of plan.pages) {
    const inventoryPath = join(payload, 'pages', name, 'visual-inventory.json');
    const imagePath = join(payload, 'pages', name, 'actual.png');
    if (existsSync(inventoryPath)) inventories[name] = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    if (existsSync(imagePath)) pageImages[name] = PNG.sync.read(readFileSync(imagePath));
  }
  return evaluateSuiteConsistency({ plan, inventories, pageImages, PNG });
}

function evaluateTokens(plan, root) {
  return evaluateTokenConsistency({
    plan,
    ...buildTokenAuditInputs(plan, { root }),
  });
}

function readPageFindings(path) {
  if (!existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(value) ? value : Array.isArray(value?.findings) ? value.findings : [];
}

function forceFailedPageGate(gate, execution) {
  const errors = [...(Array.isArray(gate?.errors) ? gate.errors : [])];
  if (execution.ok === false) errors.push(execution.error || 'page worker reported failure');
  if (execution.auditExitCode !== 0) errors.push(`audit exited ${execution.auditExitCode ?? 'without a code'}`);
  for (const path of execution.evidence?.requiredMissing || []) errors.push(`missing required evidence: ${path}`);
  return { ...(gate || {}), pass: false, errors: [...new Set(errors)] };
}

function failedPageGate(reason) {
  return { pass: false, fresh: false, errors: [String(reason || 'page execution failed')] };
}

function resolveEvidenceReference(projectRoot, outputRoot, page, reference) {
  if (typeof reference !== 'string' || reference.includes('\\') || reference.includes('\0')) {
    throw new Error(`invalid page evidence path: ${reference}`);
  }
  const expectedPrefix = `output/${page}/`;
  if (!reference.startsWith(expectedPrefix)) {
    throw new Error(`page evidence is outside page output: ${reference}`);
  }
  const segments = reference.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`invalid page evidence path: ${reference}`);
  }
  const source = resolve(projectRoot, reference);
  const rel = relative(outputRoot, source);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`page evidence is outside page output: ${reference}`);
  }
  return source;
}

function isBoundPageInput(page, reference) {
  return reference === `pages/${page}/restore-plan.json`
    || reference === `pages/${page}/asset-plan.json`
    || reference === `pages/${page}/content-manifest.json`;
}

function assertRegularNoSymlink(projectRoot, path, label) {
  const rel = relative(projectRoot, path);
  let current = projectRoot;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed in page evidence: ${label}`);
  }
  if (!lstatSync(path).isFile()) throw new Error(`page evidence is not a regular file: ${label}`);
}

function copyRegularNoFollow(source, target, label) {
  let descriptor;
  try {
    descriptor = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(descriptor).isFile()) throw new Error('source is not a regular file');
    const bytes = readFileSync(descriptor);
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new Error(`cannot copy regular page evidence ${label}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJsonRegular(projectRoot, path, label) {
  if (!existsSync(path)) throw new Error(`missing ${label}: ${relative(projectRoot, path)}`);
  assertRegularNoSymlink(projectRoot, path, label);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`invalid ${label}: ${error.message}`);
  }
}

function readProjectFile(root, path) {
  const file = resolve(root, path);
  const rel = relative(resolve(root), file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`project source escapes root: ${path}`);
  assertRegularNoSymlink(resolve(root), file, path);
  return readFileSync(file, 'utf8');
}

function runChild(command, args, cwd, extraEnv = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, VISUAL_RESTORE_ROOT: cwd, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    const append = (kind, chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CHILD_OUTPUT) {
        child.kill('SIGTERM');
        return;
      }
      if (kind === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (bytes > MAX_CHILD_OUTPUT) {
        reject(new Error(`child output exceeded ${MAX_CHILD_OUTPUT} bytes`));
        return;
      }
      resolvePromise({ exitCode: code ?? 1, signal, stdout, stderr });
    });
  });
}

function parseJsonOutput(value) {
  const text = String(value || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object found');
  return JSON.parse(text.slice(start, end + 1));
}

function tail(value, count = 8) {
  return String(value || '').trim().split(/\r?\n/).slice(-count);
}

function createRunId() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').toLowerCase();
  return `run-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function assertSnapshot(snapshot, suiteId) {
  if (!snapshot || snapshot.suiteId !== suiteId || typeof snapshot.inputDigest !== 'string' || !snapshot.inputDigest) {
    throw new Error('suite input snapshot is invalid or belongs to a different suite');
  }
}

function assertSafeId(kind, value) {
  if (!SAFE_RUN_ID.test(String(value || ''))) throw new Error(`invalid ${kind} id: ${value}`);
}

function assertSafePage(value) {
  if (typeof value !== 'string' || !value || /[\\/\0\x00-\x1f\x7f]/.test(value) || value === '.' || value === '..') {
    throw new Error(`invalid page id: ${value}`);
  }
}

function byteCompare(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
