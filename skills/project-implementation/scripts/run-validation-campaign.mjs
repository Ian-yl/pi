#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { dirname, relative, resolve } from 'node:path';

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
    const variables = { ...process.env, PROVIDER_PORT: String(providerPort), APP_PORT: String(appPort), OBSERVER_PORT: String(observerPort), OBSERVED_BASE_URL: `http://127.0.0.1:${observerPort}`, RUN_ID: runId };
    const applicationVariables = { ...variables, EXTERNAL_OBSERVER_URL: `http://127.0.0.1:${externalObserverPort}`, VALIDATION_CHALLENGE_ID: challengeId };
    const runtime = candidateContract.runtime;
    const providerLog = `${runDir}/logs/runtime-provider.log`;
    const appLog = `${runDir}/logs/runtime-app.log`;
    const provider = level === 'simulated' ? start(runtime.provider, destination, variables) : null;
    const appSpec = level === 'integrated' ? { ...runtime.app, env: { ...(runtime.app.env || {}), ...(runtime.integratedAppEnv || {}) } } : runtime.app;
    const app = start(appSpec, destination, applicationVariables);
    const observations = [];
    const externalObservations = [];
    const observer = level === 'integrated' ? await startObserver(observerPort, appPort, observations, challengeId) : null;
    const externalObserver = level === 'integrated' ? await startExternalObserver(externalObserverPort, externalObservations, challengeId) : null;
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
      if (level === 'integrated' && [...(e2e.args || []), ...Object.values(e2e.env || {})].some((value) => /EXTERNAL_OBSERVER_URL|VALIDATION_CHALLENGE_ID/.test(String(value)))) throw new Error('integrated E2E must not receive application-only external observer credentials');
      const e2eArgs = (e2e.args || []).map((value) => expand(value, variables));
      const result = spawnSync(e2e.command, e2eArgs, { cwd: resolve(destination, e2e.cwd || '.'), encoding: 'utf8', env: expandedEnv(e2e.env, variables), timeout: Number(e2e.timeoutMs || 120000) });
      const e2eCommand = `${e2e.command} ${e2eArgs.join(' ')}`;
      writeFileSync(`${runDir}/logs/browser-e2e.log`, `$ ${e2eCommand}\n${result.stdout || ''}${result.stderr || ''}`);
      steps.push({ id: 'runtime-browser-e2e', status: result.status === 0 ? 'passed' : 'failed', durationMs: Date.now() - before, command: e2eCommand, log: 'logs/browser-e2e.log' });
      if (result.status !== 0) throw new Error(`${runId}/runtime-browser-e2e failed`);
      if (level === 'integrated' && !existsSync(`${destination}/integration-evidence.json`)) throw new Error(`${runId}/integrated-e2e did not write integration-evidence.json`);
      if (level === 'integrated') {
        const operationId = readJSON(`${destination}/integration-evidence.json`).operationId;
        const api = readJSON(`${destination}/inputs/handoff-api-contract.json`); const operation = (api.operations || []).find((item) => item.id === operationId);
        const ingress = observations.find((item) => operation && item.challengeId === challengeId && String(item.method).toUpperCase() === String(operation.method).toUpperCase() && routeMatches(operation.path, item.path) && item.status >= 200 && item.status < 300);
        const egress = externalObservations.find((item) => item.challengeId === challengeId && item.status >= 200 && item.status < 300 && ingress && item.observedAt >= ingress.startedAt && item.observedAt <= ingress.observedAt && ingress.responseValues.includes(item.externalResultId));
        const integrationBindingEvidence = (operation?.integrationBindings || []).map((binding) => {
          const sourceDigest = ingress?.requestValueDigests?.[binding.source];
          const target = binding.target || binding.providerField;
          const targetDigest = egress?.requestValueDigests?.[target];
          return { operationId, source: binding.source, target, required: binding.required !== false, sourceValueDigest: sourceDigest || null, targetValueDigest: targetDigest || null, observed: Boolean(sourceDigest && sourceDigest === targetDigest) };
        });
        const ingressPassed = Boolean(ingress);
        const egressPassed = Boolean(egress);
        const bindingsPassed = integrationBindingEvidence.every((item) => !item.required || item.observed);
        const passed = ingressPassed && egressPassed && bindingsPassed;
        writeFileSync(`${destination}/operation-observation-receipt.json`, `${JSON.stringify({ schemaVersion: '1.2', generatedBy: 'project-implementation/validation-campaign-observer', operationId, challengeId, status: passed ? 'passed' : 'failed', observations, externalObservations, integrationBindingEvidence }, null, 2)}\n`);
        if (!ingressPassed) throw new Error(`${runId}/observer did not capture the integrated application operation`);
        if (!egressPassed) throw new Error(`${runId}/external observer did not capture an application-originated integration call with the campaign challenge`);
        if (!bindingsPassed) throw new Error(`${runId}/external observer did not prove all required operation integration bindings`);
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
function expandedEnv(values = {}, variables) { return { ...process.env, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expand(String(value), variables)])) }; }
function expand(value, variables) { return String(value).replace(/\$\{([A-Z_]+)\}/g, (_, key) => variables[key] ?? `\${${key}}`); }
function freePort() { return new Promise((resolvePort, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolvePort(address.port)); }); }); }
function startObserver(port, targetPort, observations, challengeId) { return new Promise((resolveServer, reject) => { const server = createHttpServer((incoming, outgoing) => { const chunks = []; const startedAt = Date.now(); incoming.on('data', (chunk) => chunks.push(chunk)); incoming.on('end', () => { const requestBody = Buffer.concat(chunks); const upstream = httpRequest({ hostname: '127.0.0.1', port: targetPort, path: incoming.url, method: incoming.method, headers: { ...incoming.headers, 'x-validation-challenge': challengeId } }, (response) => { const responseChunks = []; outgoing.writeHead(response.statusCode || 502, response.headers); response.on('data', (chunk) => { responseChunks.push(chunk); outgoing.write(chunk); }); response.on('end', () => { outgoing.end(); const body = Buffer.concat(responseChunks); observations.push({ challengeId, method: incoming.method, path: new URL(incoming.url, 'http://observer').pathname, status: response.statusCode, startedAt, observedAt: Date.now(), requestDigest: createHash('sha256').update(requestBody).digest('hex'), requestValueDigests: jsonValueDigests(requestBody, 'request'), responseDigest: createHash('sha256').update(body).digest('hex'), responseValues: jsonScalarValues(body) }); }); }); upstream.on('error', () => { outgoing.writeHead(502); outgoing.end(); }); upstream.end(requestBody); }); }); server.once('error', reject); server.listen(port, '127.0.0.1', () => resolveServer(server)); }); }
function startExternalObserver(port, observations, challengeId) { return new Promise((resolveServer, reject) => { const server = createHttpServer((request, response) => { const chunks = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => { const requestBody = Buffer.concat(chunks); const received = request.headers['x-validation-challenge']; const matched = received === challengeId; const externalResultId = matched ? randomUUID() : null; const body = Buffer.from(JSON.stringify(matched ? { externalResultId, status: 'accepted' } : { error: 'challenge-mismatch' })); observations.push({ challengeId: received || null, method: request.method, path: new URL(request.url, 'http://external-observer').pathname, status: matched ? 200 : 403, observedAt: Date.now(), externalResultId, requestDigest: createHash('sha256').update(requestBody).digest('hex'), requestValueDigests: jsonValueDigests(requestBody, 'provider'), responseDigest: createHash('sha256').update(body).digest('hex') }); response.writeHead(matched ? 200 : 403, { 'content-type': 'application/json' }); response.end(body); }); }); server.once('error', reject); server.listen(port, '127.0.0.1', () => resolveServer(server)); }); }
function jsonScalarValues(buffer) { try { const values = []; collectScalars(JSON.parse(buffer.toString('utf8')), values); return values; } catch { return []; } }
function collectScalars(value, values) { if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) values.push(value); else if (Array.isArray(value)) for (const item of value) collectScalars(item, values); else if (value && typeof value === 'object') for (const item of Object.values(value)) collectScalars(item, values); }
function jsonValueDigests(buffer, prefix) { try { const values = {}; collectValueDigests(JSON.parse(buffer.toString('utf8')), prefix, values); return values; } catch { return {}; } }
function collectValueDigests(value, path, values) { values[path] = createHash('sha256').update(JSON.stringify(value)).digest('hex'); if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, item] of Object.entries(value)) collectValueDigests(item, `${path}.${key}`, values); }
function routeMatches(contractPath, observedPath) { const pattern = String(contractPath).split(/(\{[^}]+\})/).map((part) => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''); return new RegExp(`^${pattern}$`).test(observedPath); }
function parseArgs(values) { const result = {}; for (let i = 0; i < values.length; i++) if (values[i].startsWith('--')) { result[values[i].slice(2)] = values[i + 1]; i++; } return result; }
function usage() { console.error('Usage: run-validation-campaign.mjs --functional <approved-package> --handoff <approved-handoff> --candidate <dir-with-campaign-contract> --output <dir> [--count <positive-integer>] [--level simulated|integrated]'); process.exit(2); }
