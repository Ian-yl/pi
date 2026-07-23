#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';

const args = parseArgs(process.argv.slice(2));
if (!args.dir) usage();
const dir = resolve(args.dir);
const config = readJSON(`${dir}/frontend-runtime-config.json`);
const fieldPlan = existsSync(`${dir}/field-binding-plan.json`) ? readJSON(`${dir}/field-binding-plan.json`) : { bindings: [] };
const interactionOperations = existsSync(`${dir}/interaction-manifest.json`) ? new Map((readJSON(`${dir}/interaction-manifest.json`).interactions || []).map((item) => [item.evidenceId, item.operationId])) : new Map();
const operations = new Map((readJSON(`${dir}/inputs/handoff-api-contract.json`).operations || []).map((item) => [item.id, item]));
const uiContracts = new Map((readJSON(`${dir}/inputs/handoff-ui-implementation-plan.json`).capabilities || []).map((item) => [item.capabilityId, item]));
if (config.status !== 'implemented' || !config.start?.command || !config.healthUrl || !config.e2e?.command) fail('frontend runtime config is incomplete');
const evidenceDir = `${dir}/evidence/frontend`;
const rawPath = `${evidenceDir}/raw-browser-report.json`;
for (const file of [rawPath, `${dir}/browser-e2e-report.json`, `${dir}/frontend-runtime-report.json`]) if (existsSync(file)) rmSync(file);
mkdirSync(evidenceDir, { recursive: true });
const port = String(config.port || await freePort());
const variables = { PORT: port, BASE_URL: expand(config.baseUrl || config.healthUrl.replace(/\/health.*$/, ''), { PORT: port }) };
const app = spawn(config.start.command, (config.start.args || []).map((value) => expand(value, variables)), { cwd: resolve(dir, config.start.cwd || '.'), env: expandedEnv(config.start.env, variables), stdio: ['ignore', 'pipe', 'pipe'] });
const output = [];
app.stdout.on('data', (chunk) => output.push(chunk)); app.stderr.on('data', (chunk) => output.push(chunk));
try {
  await waitFor(expand(config.healthUrl, variables), Number(config.startupTimeoutMs || 20000));
  const e2eArgs = (config.e2e.args || []).map((value) => expand(value, variables));
  const result = spawnSync(config.e2e.command, e2eArgs, { cwd: resolve(dir, config.e2e.cwd || '.'), encoding: 'utf8', env: { ...expandedEnv(config.e2e.env, variables), FRONTEND_RAW_REPORT: rawPath, BASE_URL: variables.BASE_URL }, timeout: Number(config.e2e.timeoutMs || 120000) });
  writeFileSync(`${evidenceDir}/browser-e2e-command.txt`, `$ ${config.e2e.command} ${e2eArgs.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`);
  if (result.status !== 0) fail('browser E2E command failed');
  if (!existsSync(rawPath) || statSync(rawPath).size === 0) fail('browser E2E did not produce a raw runtime report');
  const raw = readJSON(rawPath);
  const findings = validateRaw(raw);
  findings.push(...validatePlaywrightTrace(raw, variables.BASE_URL));
  if (findings.length) fail(findings.join('\n'));
  const artifacts = [...new Set((raw.cases || []).flatMap((item) => item.artifacts || []))];
  const artifactDigests = {};
  for (const artifact of artifacts) {
    const file = safePath(artifact);
    if (!file || !existsSync(file) || statSync(file).size === 0) fail(`browser artifact is missing: ${artifact}`);
    const bytes = readFileSync(file);
    if (/\.png$/i.test(file) && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail(`browser screenshot is not a PNG: ${artifact}`);
    artifactDigests[artifact] = sha(bytes);
  }
  const receipt = { schemaVersion: '1.0', generatedBy: 'project-implementation/run-browser-e2e', generatedAt: new Date().toISOString(), command: { executable: config.e2e.command, args: e2eArgs }, healthUrl: expand(config.healthUrl, variables), rawReportDigest: sha(readFileSync(rawPath)), runtimeCasesDigest: sha(Buffer.from(JSON.stringify(raw.cases))), artifactDigests, status: 'passed' };
  writeJSON(`${dir}/browser-e2e-report.json`, receipt);
  writeJSON(`${dir}/frontend-runtime-report.json`, { schemaVersion: '1.0', generatedBy: receipt.generatedBy, browserReceiptDigest: sha(Buffer.from(JSON.stringify(receipt))), application: { baseUrl: variables.BASE_URL, healthPassed: true }, cases: raw.cases, status: 'passed' });
} finally {
  app.kill('SIGTERM');
  writeFileSync(`${evidenceDir}/application-runtime.txt`, Buffer.concat(output).toString());
}

function validateRaw(raw) {
  const errors = [];
  if (raw.engine !== 'playwright') errors.push('raw browser report was not produced by the required browser engine');
  if (!Array.isArray(raw.cases) || !raw.cases.length) return ['raw browser report has no cases'];
  for (const item of raw.cases) {
    if (!item.id || !item.capabilityId || item.status !== 'passed') errors.push('browser case lacks identity or passed status');
    if (!item.bindingId || !item.locator || !item.pageUrl) errors.push(`browser case has no binding or page URL declaration: ${item.id}`);
    if (!item.artifacts?.length) errors.push(`browser case has no artifacts: ${item.id}`);
  }
  return errors;
}
function validatePlaywrightTrace(raw, baseUrl) {
  const errors = [];
  const file = safePath(raw.traceArtifact);
  if (!file || !existsSync(file) || statSync(file).size === 0) return ['raw browser report has no Playwright trace artifact'];
  const bytes = readFileSync(file);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return ['Playwright trace artifact is not a ZIP archive'];
  const listing = spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' });
  const entries = listing.stdout.split(/\r?\n/);
  if (listing.status !== 0 || !entries.includes('trace.trace') || !entries.includes('trace.network')) return ['Playwright trace archive has no trace and network event streams'];
  const trace = spawnSync('unzip', ['-p', file, 'trace.trace'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const network = spawnSync('unzip', ['-p', file, 'trace.network'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const traceEvents = jsonLines(trace.stdout); const networkEvents = jsonLines(network.stdout);
  if (trace.status !== 0 || network.status !== 0 || !traceEvents.some((item) => item.type === 'context-options') || !trace.stdout.includes(baseUrl)) return ['Playwright trace does not prove a browser context visited the application'];
  const usedCallIds = new Set();
  const actions = (raw.cases || []).map((item) => {
    const matches = traceEvents.filter((event) => event.type === 'before' && !usedCallIds.has(event.callId) && event.method === traceMethod(item.event) && JSON.stringify(event.params || {}).includes(item.locator));
    const event = matches.find((candidate) => samePageUrl(actionPageUrl(traceEvents, candidate), item.pageUrl)) || matches[0];
    if (event?.callId) usedCallIds.add(event.callId);
    return { item, event, pageUrl: actionPageUrl(traceEvents, event) };
  });
  const orderedStarts = actions.map(({ event }) => Number(event?.startTime)).filter(Number.isFinite).sort((a, b) => a - b);
  for (const { item, event, pageUrl } of actions) {
    if (!event) { errors.push(`Playwright trace has no ${item.event || 'action'} for case locator: ${item.id}`); continue; }
    if (!samePageUrl(pageUrl, item.pageUrl)) errors.push(`Playwright action page URL does not match case: ${item.id}`);
    const start = Number(event.startTime); const nextAction = orderedStarts.find((value) => value > start) ?? Infinity; const nextNavigation = traceEvents.find((candidate) => candidate.type === 'before' && candidate.method === 'goto' && Number(candidate.startTime) > start)?.startTime ?? Infinity; const end = Math.min(nextAction, Number(nextNavigation));
    const segment = traceEvents.filter((candidate) => eventTime(candidate) >= start && eventTime(candidate) < end);
    const segmentText = segment.map((candidate) => JSON.stringify(candidate)).join('\n');
    if (!segment.some((candidate) => candidate.type === 'before' && candidate.method === 'screenshot')) errors.push(`Playwright trace has no case screenshot action: ${item.id}`);
    const matchCount = traceResult(segment, 'queryCount', item.locator); const visible = traceResult(segment, 'isVisible', item.locator); const enabled = traceResult(segment, 'isEnabled', item.locator);
    const finalDom = traceMethodResult(segment, 'content');
    const activeCapabilityId = lastMainAttribute(finalDom, 'data-active-capability-id'); const capabilityStatus = lastMainAttribute(finalDom, 'data-capability-status');
    const actionBefore = segment.find((candidate) => candidate.type === 'frame-snapshot' && candidate.snapshot?.snapshotName === event.beforeSnapshot); const actionAfter = segment.find((candidate) => candidate.type === 'frame-snapshot' && candidate.snapshot?.callId === event.callId && candidate.snapshot?.snapshotName?.startsWith('after@'));
    const stateTransitions = [...new Set([...segmentText.matchAll(/"data-state":"([^"]+)"/g)].map((match) => match[1]))];
    const observedRequests = networkEvents.flatMap((candidate) => { const snapshot = candidate.snapshot; const time = Number(snapshot?._monotonicTime); if (!snapshot || time < start || time >= end) return []; try { const url = new URL(snapshot.request?.url); return [{ method: snapshot.request?.method, path: url.pathname, status: Number(snapshot.response?.status), contentType: headerValue(snapshot.request?.headers, 'content-type'), requestBody: tracePostData(file, snapshot.request?.postData), responseBody: traceResponseBody(file, snapshot) }]; } catch { return []; } });
    const operationId = interactionOperations.get(item.id); const operation = operations.get(operationId); const operationRequest = matchingRequest(observedRequests, operation); const previousGoto = [...traceEvents].reverse().find((candidate) => candidate.type === 'before' && candidate.method === 'goto' && Number(candidate.startTime) < start)?.startTime ?? -Infinity;
    const inputBindings = (fieldPlan.bindings || []).filter((binding) => binding.kind === 'input' && binding.capabilityId === item.capabilityId && (!operationId || binding.operationId === operationId)).map((binding) => {
      const fill = [...traceEvents].reverse().find((candidate) => candidate.type === 'before' && ['fill', 'setInputFiles', 'selectOption', 'check'].includes(candidate.method) && Number(candidate.startTime) > previousGoto && Number(candidate.startTime) < start && JSON.stringify(candidate.params || {}).includes(binding.controlId));
      const inputValue = actionValue(fill); const requestValue = getPath(operationRequest?.requestBody, String(binding.requestPath || '').replace(/^(?:body|query|path|header)\./, ''));
      return { bindingId: binding.id, controlId: binding.controlId, operationId: binding.operationId, inputValue, requestValue, dynamic: fill !== undefined && deepEqual(inputValue, requestValue) && !deepEqual(inputValue, binding.schema?.default) };
    });
    if (matchCount !== 1 || visible !== true || (item.mode !== 'display-only' && enabled !== true)) errors.push(`Playwright trace does not prove a unique visible enabled binding: ${item.id}`);
    const contract = uiContracts.get(item.capabilityId); const expectedStatus = contract?.specificationStatus === 'planned' ? 'planned' : 'implemented';
    if (activeCapabilityId !== item.capabilityId || capabilityStatus !== expectedStatus) errors.push(`Playwright trace does not prove the expected active capability state ${expectedStatus}: ${item.id}`);
    const fingerprint = deriveSurfaceFingerprint(finalDom);
    const resultBindings = (fieldPlan.bindings || []).filter((binding) => binding.kind === 'result' && binding.capabilityId === item.capabilityId && (!operationId || binding.operationId === operationId));
    const resultEvidence = resultBindings.map((binding) => deriveResultEvidence(finalDom, binding, operationRequest));
    for (const evidence of resultEvidence) { if (!evidence.regionPresent || !evidence.regionVisible) errors.push(`result binding target region is absent or hidden: ${evidence.bindingId}`); if (evidence.actualCount !== evidence.expectedCount) errors.push(`result binding element count differs from the operation response: ${evidence.bindingId}`); if (!deepEqual(evidence.actualValues, evidence.expectedValues)) errors.push(`result binding values differ from the operation response: ${evidence.bindingId}`); if (evidence.actualCount === 0 || evidence.regionStatus !== 'success') errors.push(`result binding only updates status or never reaches semantic success: ${evidence.bindingId}`); }
    if (expectedStatus === 'planned' && ((fingerprint?.inputIds || []).length || fingerprint?.primaryOperationId || (fingerprint?.requiredRegions || []).some((region) => /result|output/i.test(region)))) errors.push(`planned capability retains implemented inputs, operation, or result surface: ${item.id}`);
    item.observed = { matchCount, visible, enabled, pageUrl, actionCallId: event.callId, activeCapabilityId, capabilityStatus, networkRequests: observedRequests, inputBindings, resultEvidence, stateTransitions, domChanged: Boolean(actionBefore && actionAfter && JSON.stringify(actionBefore.snapshot?.html) !== JSON.stringify(actionAfter.snapshot?.html)), visibleText: [segmentText] };
    item.surfaceFingerprint = fingerprint;
  }
  return errors;
}
function jsonLines(value) { return String(value).split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function traceMethod(event) { return ({ click: 'click', submit: 'click', change: 'fill', upload: 'setInputFiles' })[event] || event || 'click'; }
function eventTime(event) { return Number(event.startTime ?? event.endTime ?? event.time ?? event.snapshot?.timestamp ?? -1); }
function traceResult(events, method, locator) { const before = events.find((event) => event.type === 'before' && event.method === method && JSON.stringify(event.params || {}).includes(locator)); if (!before) return undefined; return events.find((event) => event.type === 'after' && event.callId === before.callId)?.result?.value; }
function traceMethodResult(events, method) { const before = events.find((event) => event.type === 'before' && event.method === method); if (!before) return undefined; return events.find((event) => event.type === 'after' && event.callId === before.callId)?.result?.value; }
function actionPageUrl(events, event) { if (!event) return undefined; const named = events.find((candidate) => candidate.type === 'frame-snapshot' && candidate.snapshot?.snapshotName === event.beforeSnapshot); if (named?.snapshot?.frameUrl) return named.snapshot.frameUrl; return [...events].reverse().find((candidate) => candidate.type === 'frame-snapshot' && candidate.pageId === event.pageId && eventTime(candidate) <= eventTime(event))?.snapshot?.frameUrl; }
function samePageUrl(actual, expected) { try { const left = new URL(actual); const right = new URL(expected); return left.origin === right.origin && normalizePath(left.pathname) === normalizePath(right.pathname); } catch { return false; } }
function normalizePath(value) { const path = String(value || '/').replace(/\/+$/, ''); return path || '/'; }
function headerValue(headers, name) { const item = (headers || []).find((entry) => String(entry.name).toLowerCase() === name); return item?.value; }
function parseBody(value) { if (value === undefined || value === null) return undefined; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return String(value); } }
function actionValue(event) { if (!event) return undefined; if (event.method === 'setInputFiles') return event.params?.localPaths || event.params?.files || event.params?.payloads; if (event.method === 'check') return true; return event.params?.value ?? event.params?.values ?? event.params?.options; }
function getPath(value, path) { return String(path || '').split('.').filter(Boolean).reduce((current, key) => current?.[key], value); }
function deepEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function matchingRequest(requests, operation) { return operation && requests.find((request) => String(request.method).toUpperCase() === String(operation.method).toUpperCase() && pathMatches(operation.path, request.path)); }
function pathMatches(contractPath, observedPath) { const pattern = String(contractPath || '').split(/(\{[^}]+\})/).map((part) => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''); return new RegExp(`^${pattern}$`).test(observedPath); }
function traceResponseBody(traceFile, snapshot) { const sha1 = snapshot.response?.content?._sha1; if (!sha1) return undefined; const result = spawnSync('unzip', ['-p', traceFile, `resources/${sha1}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); return result.status === 0 ? parseBody(result.stdout) : undefined; }
function tracePostData(traceFile, postData) { const sha1 = postData?._sha1; if (!sha1) return parseBody(postData); const result = spawnSync('unzip', ['-p', traceFile, `resources/${sha1}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); return result.status === 0 ? parseBody(result.stdout) : undefined; }
function lastAttribute(text, name) { return [...text.matchAll(new RegExp(`"${name}":"([^"]*)"`, 'g'))].at(-1)?.[1]; }
function lastMainAttribute(html = '', name) { const mains = [...String(html).matchAll(/<main\b([^>]*)>/gi)].map((match) => match[1]).filter((attrs) => !/\bhidden\b|aria-hidden=["']true["']|display\s*:\s*none/i.test(attrs)); return attribute(mains.at(-1), name); }
function deriveSurfaceFingerprint(html = '') { const activeMain = [...String(html).matchAll(/<main\b[^>]*data-active-capability-id=["'][^"']+["'][^>]*>([\s\S]*?)<\/main>/gi)].at(-1)?.[0] || ''; const heading = attribute(activeMain, 'data-surface-heading'); if (!heading) return undefined; return { heading, inputIds: [...new Set([...activeMain.matchAll(/data-domain-input-id=["']([^"']+)["']/gi)].map((match) => match[1]))], primaryAction: attribute(activeMain, 'data-primary-action'), primaryOperationId: attribute(activeMain, 'data-primary-operation-id'), emptyState: attribute(activeMain, 'data-empty-state'), requiredRegions: [...new Set([...activeMain.matchAll(/data-region=["']([^"']+)["']/gi)].map((match) => match[1]))] }; }
function deriveResultEvidence(html = '', binding, request) {
  const activeMain = [...String(html).matchAll(/<main\b[^>]*data-active-capability-id=["'][^"']+["'][^>]*>([\s\S]*?)<\/main>/gi)].at(-1)?.[0] || '';
  const regionTags = [...activeMain.matchAll(/<[^>]+data-result-region-id=["']([^"']+)["'][^>]*>/gi)].filter((match) => match[1] === binding.regionId);
  const regionTag = regionTags.find((match) => !attribute(match[0], 'data-result-binding-id'))?.[0] || '';
  const itemTags = regionTags.filter((match) => attribute(match[0], 'data-result-binding-id') === binding.id);
  const raw = getPath(request?.responseBody, binding.responsePath); const expectedValues = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(semanticValue); const actualValues = itemTags.map((match) => parseSemanticValue(attribute(match[0], 'data-result-value')));
  return { bindingId: binding.id, operationId: binding.operationId, regionId: binding.regionId, elementSemantic: binding.elementSemantic, regionPresent: Boolean(regionTag), regionVisible: Boolean(regionTag) && !/\bhidden\b|aria-hidden=["']true["']|display\s*:\s*none/i.test(regionTag), regionStatus: attribute(regionTag, 'data-result-status'), expectedCount: expectedValues.length, actualCount: itemTags.length, expectedValues, actualValues };
}
function semanticValue(value) { return value && typeof value === 'object' ? JSON.stringify(value) : value; }
function parseSemanticValue(value) { if (value === undefined) return undefined; try { return JSON.parse(value); } catch { return value; } }
function attribute(text = '', name) { return String(text).match(new RegExp(`${name}=["']([^"']*)["']`, 'i'))?.[1]; }
function safePath(relative) { if (!relative || typeof relative !== 'string') return null; const path = resolve(dir, relative); if (!path.startsWith(`${dir}/`) || !existsSync(path) || lstatSync(path).isSymbolicLink()) return null; const rootReal = realpathSync(dir); const targetReal = realpathSync(path); return targetReal.startsWith(`${rootReal}/`) ? targetReal : null; }
function freePort() { return new Promise((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => done(address.port)); }); }); }
async function waitFor(url, timeoutMs) { const start = Date.now(); while (Date.now() - start < timeoutMs) { try { const response = await fetch(url); if (response.ok) return; } catch {} await new Promise((done) => setTimeout(done, 100)); } fail(`application health check timed out: ${url}`); }
function expandedEnv(values = {}, variables) { return { ...process.env, ...variables, ...Object.fromEntries(Object.entries(values || {}).map(([key, value]) => [key, expand(value, variables)])) }; }
function expand(value, variables) { return String(value).replace(/\$\{([A-Z_]+)\}/g, (_, key) => variables[key] ?? `\${${key}}`); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJSON(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function parseArgs(values) { const result = {}; for (let index = 0; index < values.length; index += 1) if (values[index].startsWith('--')) result[values[index].slice(2)] = values[++index]; return result; }
function fail(message) { throw new Error(message); }
function usage() { console.error('Usage: run-browser-e2e.mjs --dir <implementation-dir>'); process.exit(2); }
