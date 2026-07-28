#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { dirname, relative, resolve } from 'node:path';
import { collectionAtResponsePath, concurrencyFindings, independentItemsCampaignFindings, invocationBindingEvidence, operationResourceProofs, operationScopedCalls, providerOperationSetFindings } from './lib/campaign-independence.mjs';
import { observedRequestEvidence } from './lib/request-observation.mjs';

const args = parseArgs(process.argv.slice(2));
for (const key of ['functional', 'candidate', 'output']) if (!args[key]) usage();
const handoffArg = args.handoff;
if (!handoffArg) usage();
const count = Number(args.count || 1);
if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive integer');
const level = args.level || 'simulated';
if (!['simulated', 'integrated'].includes(level)) throw new Error('--level must be simulated or integrated');
const root = resolve(import.meta.dirname, '..');
const functional = resolve(args.functional);
const handoff = resolve(handoffArg);
const candidate = resolve(args.candidate);
if (!existsSync(`${candidate}/campaign-contract.json`)) throw new Error('generic validation campaign requires candidate campaign-contract.json — declare install, build, runtime, and E2E commands in the candidate contract');
const candidateContract = readJSON(`${candidate}/campaign-contract.json`);
if (level === 'integrated' && !candidateContract.runtime?.integratedE2e) throw new Error('integrated validation requires runtime.integratedE2e in campaign-contract.json — add the application-level external integration journey command');
const output = resolve(args.output);
mkdirSync(output, { recursive: true });
const campaign = [];

for (let index = 1; index <= count; index += 1) {
  const runId = `run-${String(index).padStart(2, '0')}`;
  const runDir = `${output}/${runId}`;
  const implementation = `${runDir}/implementation`;
  if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
  mkdirSync(`${runDir}/logs`, { recursive: true });
  const started = Date.now();
  const steps = [];
  try {
    command('implementation-prepare', 'node', [`${root}/scripts/prepare-implementation.mjs`, '--functional', functional, '--handoff', handoff, '--output', implementation]);
    const preparedState = protectedState(implementation);
    copyCandidate(implementation);
    assertProtectedState(implementation, preparedState, 'candidate copy');
    for (const [installIndex, install] of (candidateContract.install || []).entries()) { command(`install-${installIndex + 1}`, install.command, install.args || [], install.env || {}, resolve(implementation, install.cwd || '.')); assertProtectedState(implementation, preparedState, `install-${installIndex + 1}`); }
    if (level === 'integrated') await runtimeE2E(implementation);
    command('implementation-finalize', 'node', [`${root}/scripts/finalize-implementation.mjs`, '--dir', implementation]);
    assertProtectedState(implementation, preparedState, 'finalize');
    command('implementation-verify', 'node', [`${root}/scripts/verify-implementation.mjs`, implementation, '--require-level', level]);
    const summary = finish('passed');
    campaign.push(summary);
    writeRunDocs(summary);
    console.log(`${runId}: passed (${summary.durationMs}ms)`);
  } catch (error) {
    const summary = finish('failed', error.message);
    campaign.push(summary);
    writeRunDocs(summary);
    writeCampaign();
    throw error;
  }

  function command(id, executable, values, env = {}, cwd = root) {
    const before = Date.now();
    const result = spawnSync(executable, values, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    const log = `$ ${executable} ${values.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`;
    writeFileSync(`${runDir}/logs/${id}.log`, log);
    const step = { id, status: result.status === 0 ? 'passed' : 'failed', durationMs: Date.now() - before, command: `${executable} ${values.join(' ')}`, log: `logs/${id}.log` };
    steps.push(step);
    if (result.status !== 0) throw new Error(`${runId}/${id} failed`);
  }

  function copyCandidate(destination) {
    for (const item of candidateContract.copy || []) {
      const source = resolve(candidate, item);
      if (source !== candidate && !source.startsWith(`${candidate}/`)) throw new Error(`candidate copy path escapes root: ${item}`);
      const target = resolve(destination, item);
      const normalized = relative(destination, target).replaceAll('\\', '/');
      if (!normalized || normalized === '..' || normalized.startsWith('../')) throw new Error(`candidate copy target escapes implementation workspace: ${item}`);
      if (['input-lock.json', 'implementation-plan.json', 'bmad-traceability.json', 'inputs', '_bmad-output'].some((protectedPath) => normalized === protectedPath || normalized.startsWith(`${protectedPath}/`))) throw new Error(`candidate copy targets protected implementation input: ${item}`);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
    }
  }

  async function runtimeE2E(destination) {
    const providerPort = await freePort();
    const appPort = await freePort();
    const observerPort = await freePort();
    const externalObserverPort = await freePort();
    const challengeId = randomUUID();
    const apiContract = readJSON(`${destination}/inputs/handoff-api-contract.json`);
    const operationTokens = Object.fromEntries((apiContract.operations || []).filter((item) => item.providerContract).map((item) => [item.id, randomUUID()]));
    const variables = { ...process.env, PROVIDER_PORT: String(providerPort), APP_PORT: String(appPort), OBSERVER_PORT: String(observerPort), OBSERVED_BASE_URL: `http://127.0.0.1:${observerPort}`, RUN_ID: runId };
    const applicationVariables = { ...variables, EXTERNAL_OBSERVER_URL: `http://127.0.0.1:${externalObserverPort}`, VALIDATION_CHALLENGE_ID: challengeId };
    const runtime = candidateContract.runtime;
    const providerLog = `${runDir}/logs/runtime-provider.log`;
    const appLog = `${runDir}/logs/runtime-app.log`;
    const provider = level === 'simulated' ? start(runtime.provider, destination, variables) : null;
    const appSpec = level === 'integrated' ? { ...runtime.app, env: { ...(runtime.app.env || {}), ...(runtime.integratedAppEnv || {}), VALIDATION_OPERATION_TOKENS: JSON.stringify(operationTokens) } } : runtime.app;
    const app = start(appSpec, destination, applicationVariables);
    const observations = [];
    const externalObservations = [];
    const observer = level === 'integrated' ? await startObserver(observerPort, appPort, observations, challengeId, apiContract.operations || []) : null;
    const concurrencyState = { inFlight: 0, maxInFlight: 0 };
    const externalObserver = level === 'integrated' ? await startExternalObserver(externalObserverPort, externalObservations, challengeId, operationTokens, concurrencyState, 200) : null;
    const providerChunks = [];
    const appChunks = [];
    provider?.stdout.on('data', (chunk) => providerChunks.push(chunk)); provider?.stderr.on('data', (chunk) => providerChunks.push(chunk));
    app.stdout.on('data', (chunk) => appChunks.push(chunk)); app.stderr.on('data', (chunk) => appChunks.push(chunk));
    const before = Date.now();
    try {
      await waitFor(expand(runtime.healthUrl, variables), Number(runtime.startupTimeoutMs || 15000));
      const e2e = level === 'integrated' ? runtime.integratedE2e : runtime.e2e;
      if (level === 'integrated' && !Object.values(e2e.env || {}).some((value) => String(value).includes('${OBSERVED_BASE_URL}'))) throw new Error('integratedE2e must route application requests through ${OBSERVED_BASE_URL}');
      if (level === 'integrated' && !Object.values(runtime.integratedAppEnv || {}).some((value) => String(value).includes('${EXTERNAL_OBSERVER_URL}'))) throw new Error('integratedAppEnv must route application external calls through ${EXTERNAL_OBSERVER_URL}');
      if (level === 'integrated' && [...(e2e.args || []), ...Object.values(e2e.env || {})].some((value) => /EXTERNAL_OBSERVER_URL|VALIDATION_CHALLENGE_ID|VALIDATION_OPERATION_TOKENS/.test(String(value)))) throw new Error('integrated E2E must not receive application-only external observer credentials');
      const e2eArgs = (e2e.args || []).map((value) => expand(value, variables));
      // Must be async: the ingress and external observers run in this process, so a synchronous child
      // would block the event loop and the observers could never answer the application's traffic.
      const result = await spawnCollect(e2e.command, e2eArgs, { cwd: resolve(destination, e2e.cwd || '.'), env: expandedEnv(e2e.env, variables), timeoutMs: Number(e2e.timeoutMs || 120000) });
      const e2eCommand = `${e2e.command} ${e2eArgs.join(' ')}`;
      writeFileSync(`${runDir}/logs/browser-e2e.log`, `$ ${e2eCommand}\n${result.stdout || ''}${result.stderr || ''}`);
      steps.push({ id: 'runtime-browser-e2e', status: result.status === 0 ? 'passed' : 'failed', durationMs: Date.now() - before, command: e2eCommand, log: 'logs/browser-e2e.log' });
      if (result.status !== 0) throw new Error(`${runId}/runtime-browser-e2e failed`);
      if (level === 'integrated' && !existsSync(`${destination}/integration-evidence.json`)) throw new Error(`${runId}/integrated-e2e did not write integration-evidence.json`);
      if (level === 'integrated') {
        const integrationEvidence = readJSON(`${destination}/integration-evidence.json`);
        const api = readJSON(`${destination}/inputs/handoff-api-contract.json`);
        const functionalSpec = readJSON(`${destination}/inputs/functional-functional-spec.json`);
        const uiPlan = readJSON(`${destination}/inputs/handoff-ui-implementation-plan.json`);
        const requiredOperations = (api.operations || []).filter((item) => item.providerContract);
        const evidenceRecords = Array.isArray(integrationEvidence.operations) ? integrationEvidence.operations : [];
        const operationSetFindings = providerOperationSetFindings(api.operations, evidenceRecords);
        if (operationSetFindings.length) throw new Error(`${runId}/${operationSetFindings[0]}`);
        const operationReceipts = [];
        for (const operation of requiredOperations) {
          const record = evidenceRecords.find((item) => item.operationId === operation.id);
          const operationId = operation.id;
          const ingress = observations.find((item) => item.challengeId === challengeId && String(item.method).toUpperCase() === String(operation.method).toUpperCase() && routeMatches(operation.path, item.path) && item.status >= 200 && item.status < 300);
          const resultPath = operationResultPath(uiPlan, operation);
          const resultItems = ingress ? collectionAtResponsePath(Buffer.from(JSON.stringify(ingress.responseBody)), resultPath) : null;
          if (operation.providerContract?.outputMode === 'independent-items' && !resultPath) throw new Error(`${runId}/${operationId} has no declared resultContract responsePath`);
          if (ingress) { ingress.responseCollectionLength = Array.isArray(resultItems) ? resultItems.length : null; ingress.responseValues = scalarValues(ingress.responseBody); }
          const externalCalls = operationScopedCalls(externalObservations, challengeId, operation.id, ingress);
          const egressPassed = externalCalls.some((item) => ingress?.responseValues?.includes(item.externalResultId));
          const integrationBindingEvidence = invocationBindingEvidence(operation, ingress, externalCalls, challengeId, operationResourceProofs(functionalSpec, operation, api.operations, observations, ingress));
          const independentItemsFindings = independentItemsCampaignFindings(operation, ingress, externalCalls, challengeId);
          const quantity = Array.isArray(resultItems) ? resultItems.length : externalCalls.length;
          const maxInFlight = maximumOverlap(externalCalls);
          const concurrencyResults = concurrencyFindings(operation.providerContract, quantity, maxInFlight);
          const controlledScenarios = {};
          for (const scenario of operation.integrationVerification?.requiredScenarios || []) {
          const candidateArtifact = record.scenarios?.[scenario]?.evidence?.[0];
          const candidatePath = candidateArtifact ? resolve(destination, candidateArtifact) : null;
          if (!candidatePath || !candidatePath.startsWith(`${destination}/`) || !existsSync(candidatePath)) throw new Error(`${runId}/integrated scenario ${scenario} has no candidate observation to correlate`);
          const candidate = readJSON(candidatePath);
          const observed = observations.find((item) => item.challengeId === challengeId && String(item.method).toUpperCase() === String(operation.method).toUpperCase() && routeMatches(operation.path, item.path) && item.requestDigest === candidate.requestDigest && item.responseDigest === candidate.responseDigest && item.status === candidate.responseStatus);
          if (!observed) throw new Error(`${runId}/integrated scenario ${scenario} is not correlated with a campaign-observed application request and response`);
          const artifact = `evidence/integration/campaign-scenario-${scenario}.json`;
          writeFileSync(`${destination}/${artifact}`, `${JSON.stringify({ schemaVersion: '1.0', generatedBy: 'project-implementation/validation-campaign-observer', challengeId, operationId, scenario, observed: true, requestDigest: observed.requestDigest, responseDigest: observed.responseDigest, responseStatus: observed.status }, null, 2)}\n`);
          controlledScenarios[scenario] = { status: 'observed', evidence: [artifact] };
          }
          record.scenarios = controlledScenarios;
          const bindingsPassed = integrationBindingEvidence.every((item) => !item.required || item.observed) && (operation.integrationBindings || []).every((binding) => externalCalls.length > 0 && integrationBindingEvidence.filter((item) => item.source === binding.source && item.target === (binding.target || binding.providerField)).length === externalCalls.length);
          const passed = Boolean(ingress) && egressPassed && bindingsPassed && !independentItemsFindings.length && !concurrencyResults.length;
          operationReceipts.push({ operationId, status: passed ? 'passed' : 'failed', resultPath, maxInFlight, integrationBindingEvidence, independentItemsFindings, concurrencyFindings: concurrencyResults });
          if (!ingress) throw new Error(`${runId}/observer did not capture integrated operation ${operationId}`);
          if (!egressPassed) throw new Error(`${runId}/external observer did not capture an application-originated call for ${operationId}`);
          if (!bindingsPassed) throw new Error(`${runId}/not every provider invocation preserved all required bindings for ${operationId}`);
          if (independentItemsFindings.length) throw new Error(`${runId}/${independentItemsFindings[0]}`);
          if (concurrencyResults.length) throw new Error(`${runId}/${concurrencyResults[0]}`);
        }
        writeFileSync(`${destination}/integration-evidence.json`, `${JSON.stringify(integrationEvidence, null, 2)}\n`);
        writeFileSync(`${destination}/operation-observation-receipt.json`, `${JSON.stringify({ schemaVersion: '1.5', generatedBy: 'project-implementation/validation-campaign-observer', challengeId, status: operationReceipts.every((item) => item.status === 'passed') ? 'passed' : 'failed', observations, externalObservations, operationReceipts }, null, 2)}\n`);
      }
    } finally {
      app.kill('SIGTERM'); provider?.kill('SIGTERM'); observer?.close(); externalObserver?.close();
      writeFileSync(providerLog, Buffer.concat(providerChunks).toString());
      writeFileSync(appLog, Buffer.concat(appChunks).toString());
    }
  }

  function finish(status, error = null) {
    const manifest = existsSync(`${implementation}/implementation-manifest.json`) ? readJSON(`${implementation}/implementation-manifest.json`) : null;
    const completion = existsSync(`${implementation}/capability-completion-report.json`) ? readJSON(`${implementation}/capability-completion-report.json`) : null;
    return { runId, status, deliveryStatus: completion?.productStatus || manifest?.deliveryStatus || null, capabilityCounts: completion?.counts || null, error, durationMs: Date.now() - started, functionalPackage: functional, implementation: `${runId}/implementation`, implementationUnits: manifest?.units?.length || 0, steps };
  }

  function writeRunDocs(summary) {
    writeFileSync(`${runDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
    const rows = summary.steps.map((step) => `| ${step.id} | ${step.status} | ${step.durationMs}ms | [log](${step.log}) |`).join('\n');
    writeFileSync(`${runDir}/README.md`, `# ${summary.runId}\n\n- Status: **${summary.status}**\n- Delivery: **${summary.deliveryStatus || 'unverified'}**\n- Duration: ${summary.durationMs}ms\n- Functional package: \`${summary.functionalPackage}\`\n- Generated project: \`implementation/\`\n- Implementation units: ${summary.implementationUnits}\n\n| Step | Status | Duration | Evidence |\n|---|---:|---:|---|\n${rows}\n\n${summary.error ? `Failure: ${summary.error}\n` : 'All required complete-capability and planned-state gates passed.\n'}`);
  }
}

writeCampaign();
console.log(`Validation campaign passed: ${campaign.length}/${count}`);

function writeCampaign() {
  const deliveryStatuses = [...new Set(campaign.map((run) => run.deliveryStatus).filter(Boolean))];
  writeFileSync(`${output}/campaign-summary.json`, `${JSON.stringify({ schemaVersion: '1.1', verificationLevel: level, requestedRuns: count, completedRuns: campaign.length, passedRuns: campaign.filter((run) => run.status === 'passed').length, deliveryStatuses, runs: campaign }, null, 2)}\n`);
  const rows = campaign.map((run) => `| [${run.runId}](${run.runId}/README.md) | ${run.status} | ${run.deliveryStatus || 'unverified'} | ${run.durationMs}ms | ${run.implementationUnits} |`).join('\n');
  writeFileSync(`${output}/README.md`, `# Implementation Validation Campaign\n\nThis campaign verified required implementation and declared planned states ${campaign.length} time(s).\n\n| Run | Status | Delivery | Duration | Units |\n|---|---:|---:|---:|---:|\n${rows}\n`);
}
async function waitFor(url, timeoutMs) { const start = Date.now(); while (Date.now() - start < timeoutMs) { try { const response = await fetch(url); if (response.ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`runtime did not become ready: ${url}`); }
function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function protectedState(dir) { return { inputLock: fileDigest(`${dir}/input-lock.json`), plan: fileDigest(`${dir}/implementation-plan.json`), traceability: fileDigest(`${dir}/bmad-traceability.json`), inputs: treeDigest(`${dir}/inputs`), bmadContracts: readJSON(`${dir}/input-lock.json`).bmad?.contracts || {} }; }
function assertProtectedState(dir, expected, stage) { if (JSON.stringify(protectedState(dir)) !== JSON.stringify(expected)) throw new Error(`${stage} changed protected prepared inputs`); }
function fileDigest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function treeDigest(dir) { const hash = createHash('sha256'); for (const file of walk(dir)) hash.update(file.slice(dir.length + 1)).update('\0').update(readFileSync(file)).update('\0'); return hash.digest('hex'); }
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => { const path = `${dir}/${entry.name}`; return entry.isDirectory() ? walk(path) : statSync(path).isFile() ? [path] : []; }).sort(); }
function start(spec, destination, variables) { return spawn(spec.command, (spec.args || []).map((value) => expand(value, variables)), { cwd: resolve(destination, spec.cwd || '.'), env: expandedEnv(spec.env, variables), stdio: ['ignore', 'pipe', 'pipe'] }); }
function spawnCollect(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk)); child.stderr.on('data', (chunk) => err.push(chunk));
    const timer = setTimeout(() => { err.push(Buffer.from(`\nintegrated E2E exceeded ${timeoutMs}ms`)); child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); resolveResult({ status: null, stdout: Buffer.concat(out).toString(), stderr: `${Buffer.concat(err).toString()}${error.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolveResult({ status: code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }); });
  });
}
function expandedEnv(values = {}, variables) { return { ...process.env, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expand(String(value), variables)])) }; }
function expand(value, variables) { return String(value).replace(/\$\{([A-Z_]+)\}/g, (_, key) => variables[key] ?? `\${${key}}`); }
function freePort() { return new Promise((resolvePort, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolvePort(address.port)); }); }); }
function startObserver(port, targetPort, observations, challengeId, operations) { return new Promise((resolveServer, reject) => { const server = createHttpServer((incoming, outgoing) => { const chunks = []; const startedAt = Date.now(); incoming.on('data', (chunk) => chunks.push(chunk)); incoming.on('end', () => { const requestBody = Buffer.concat(chunks); const requestEvidence = observedRequestEvidence(incoming, requestBody, operations); const upstream = httpRequest({ hostname: '127.0.0.1', port: targetPort, path: incoming.url, method: incoming.method, headers: { ...incoming.headers, 'x-validation-challenge': challengeId } }, (response) => { const responseChunks = []; outgoing.writeHead(response.statusCode || 502, response.headers); response.on('data', (chunk) => { responseChunks.push(chunk); outgoing.write(chunk); }); response.on('end', () => { outgoing.end(); const body = Buffer.concat(responseChunks); observations.push({ challengeId, method: incoming.method, path: new URL(incoming.url, 'http://observer').pathname, status: response.statusCode, startedAt, observedAt: Date.now(), requestDigest: createHash('sha256').update(requestBody).digest('hex'), requestValueDigests: requestEvidence.valueDigests, requestContentDigests: requestEvidence.contentDigests, responseDigest: createHash('sha256').update(body).digest('hex'), responseBody: parseJson(body) }); }); }); upstream.on('error', () => { outgoing.writeHead(502); outgoing.end(); }); upstream.end(requestBody); }); }); server.once('error', reject); server.listen(port, '127.0.0.1', () => resolveServer(server)); }); }
// The external observer injects a fixed delay so concurrent outbound calls deterministically overlap, and
// records the maximum in-flight count. It never inspects business content — only counts overlap and returns
// one distinct result id per call.
function startExternalObserver(port, observations, challengeId, operationTokens, concurrency = { inFlight: 0, maxInFlight: 0 }, delayMs = 0) { const operationsByToken = new Map(Object.entries(operationTokens || {}).map(([operationId, token]) => [token, operationId])); return new Promise((resolveServer, reject) => { const server = createHttpServer((request, response) => { const chunks = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => { const requestBody = Buffer.concat(chunks); const requestEvidence = observedRequestEvidence(request, requestBody, [], 'provider'); const received = request.headers['x-validation-challenge']; const operationToken = request.headers['x-validation-operation-token']; const operationId = operationsByToken.get(operationToken) || null; const matched = received === challengeId && Boolean(operationId); const externalResultId = matched ? randomUUID() : null; const body = Buffer.from(JSON.stringify(matched ? { externalResultId, status: 'accepted' } : { error: 'challenge-mismatch' })); concurrency.inFlight += 1; concurrency.maxInFlight = Math.max(concurrency.maxInFlight, concurrency.inFlight); const observation = { id: randomUUID(), challengeId: received || null, operationId, method: request.method, path: new URL(request.url, 'http://external-observer').pathname, status: matched ? 200 : 403, startedAt: Date.now(), observedAt: null, externalResultId, requestDigest: createHash('sha256').update(requestBody).digest('hex'), requestValueDigests: requestEvidence.valueDigests, requestContentDigests: requestEvidence.contentDigests, responseDigest: createHash('sha256').update(body).digest('hex') }; observations.push(observation); setTimeout(() => { concurrency.inFlight -= 1; observation.observedAt = Date.now(); response.writeHead(matched ? 200 : 403, { 'content-type': 'application/json' }); response.end(body); }, delayMs); }); }); server.once('error', reject); server.listen(port, '127.0.0.1', () => resolveServer(server)); }); }

function operationResultPath(uiPlan, operation) { const contract = (uiPlan.capabilities || []).find((item) => item.capabilityId === operation.capabilityId)?.presentation?.surface?.contentContract?.resultContract; return operation.integrationVerification?.resultCollectionPath || (contract?.bindings || []).find((item) => !item.operationId || item.operationId === operation.id)?.responsePath || null; }
function maximumOverlap(calls) { const events = calls.flatMap((item) => [[item.startedAt, 1], [item.observedAt, -1]]).filter(([time]) => Number.isFinite(time)).sort((a, b) => a[0] - b[0] || b[1] - a[1]); let active = 0; let maximum = 0; for (const [, delta] of events) { active += delta; maximum = Math.max(maximum, active); } return maximum; }
function parseJson(buffer) { try { return JSON.parse(buffer.toString('utf8')); } catch { return null; } }
function scalarValues(value) { if (Array.isArray(value)) return value.flatMap(scalarValues); if (value && typeof value === 'object') return Object.values(value).flatMap(scalarValues); return value === null || value === undefined ? [] : [String(value)]; }
function jsonScalarValues(buffer) { try { const values = []; collectScalars(JSON.parse(buffer.toString('utf8')), values); return values; } catch { return []; } }
function collectScalars(value, values) { if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) values.push(value); else if (Array.isArray(value)) for (const item of value) collectScalars(item, values); else if (value && typeof value === 'object') for (const item of Object.values(value)) collectScalars(item, values); }
function routeMatches(contractPath, observedPath) { const pattern = String(contractPath).split(/(\{[^}]+\})/).map((part) => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''); return new RegExp(`^${pattern}$`).test(observedPath); }
function parseArgs(values) { const result = {}; for (let i = 0; i < values.length; i++) if (values[i].startsWith('--')) { result[values[i].slice(2)] = values[i + 1]; i++; } return result; }
function usage() { console.error('Usage: run-validation-campaign.mjs --functional <approved-package> --handoff <approved-handoff> --candidate <dir-with-campaign-contract> --output <dir> [--count <positive-integer>] [--level simulated|integrated]'); process.exit(2); }
