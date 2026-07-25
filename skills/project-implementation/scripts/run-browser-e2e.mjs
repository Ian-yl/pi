#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { hasPostOperationTestDomMutation } from './lib/trace-mutation.mjs';
import { networkInterceptionFindings } from './lib/network-integrity.mjs';
import { hasOriginReceipt, startOriginProxy } from './lib/origin-proxy.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.dir) usage();
const dir = resolve(args.dir);
const config = readJSON(`${dir}/frontend-runtime-config.json`);
const fieldPlan = existsSync(`${dir}/field-binding-plan.json`) ? readJSON(`${dir}/field-binding-plan.json`) : { bindings: [] };
const interactionOperations = existsSync(`${dir}/interaction-manifest.json`) ? new Map((readJSON(`${dir}/interaction-manifest.json`).interactions || []).map((item) => [item.evidenceId, item.operationId])) : new Map();
const operations = new Map((readJSON(`${dir}/inputs/handoff-api-contract.json`).operations || []).map((item) => [item.id, item]));
const uiContracts = new Map((readJSON(`${dir}/inputs/handoff-ui-implementation-plan.json`).capabilities || []).map((item) => [item.capabilityId, item]));
// Contract-driven independent-media map: every path and field is read from the declared contract,
// never a product-specific field name, so the gate applies to any collection-resource capability.
const functionalSpec = existsSync(`${dir}/inputs/handoff-functional-spec.json`) ? readJSON(`${dir}/inputs/handoff-functional-spec.json`) : { capabilities: [] };
const semanticInventory = existsSync(`${dir}/inputs/handoff-frontend-semantic-inventory.json`) ? readJSON(`${dir}/inputs/handoff-frontend-semantic-inventory.json`) : { pages: [] };
const controlDefaults = new Map((semanticInventory.pages || []).flatMap((page) => (page.controls || []).map((control) => [control.controlId, control.defaultValue])));
const controlByField = new Map((existsSync(`${dir}/inputs/handoff-control-capability-map.json`) ? readJSON(`${dir}/inputs/handoff-control-capability-map.json`).mappings || [] : []).flatMap((mapping) => (mapping.fieldBindings || []).map((field) => [field.inputId, field.controlId])));
const itemContracts = new Map((functionalSpec.capabilities || []).filter((item) => item.closure?.resultDestination?.itemContract).map((item) => { const destination = item.closure.resultDestination; const binding = (destination.bindings || []).find((entry) => entry.responsePath?.startsWith('response.')); const countField = String(binding?.count?.requestPath || '').replace(/^request\./, '').replace(/^body\./, ''); const controlDefault = controlDefaults.get(controlByField.get(countField)); return [item.id, { contract: destination.itemContract, responsePath: binding?.responsePath, countRequestPath: binding?.count?.requestPath, nonDefaultValueRequired: binding?.count?.nonDefaultValueRequired === true, controlDefault, operationId: item.presentation?.primaryOperationId || item.operations?.[0]?.id }]; }));
const visualControls = existsSync(`${dir}/inputs/handoff-visual-controls.json`) ? readJSON(`${dir}/inputs/handoff-visual-controls.json`) : { controls: [] };
const pageAnchors = new Map();
for (const control of visualControls.controls || []) { if (!pageAnchors.has(control.pageId)) pageAnchors.set(control.pageId, new Set()); pageAnchors.get(control.pageId).add(control.referenceId); }
const functionalManifest = existsSync(`${dir}/inputs/functional-manifest.json`) ? readJSON(`${dir}/inputs/functional-manifest.json`) : {}; const assetInventoryRequired = functionalManifest.schemaVersion === '2.2'; const assetInventoryPath = `${dir}/inputs/handoff-asset-role-inventory.json`;
if (assetInventoryRequired && !existsSync(assetInventoryPath)) fail('locked asset role inventory is missing from browser runtime inputs');
const assetInventory = existsSync(assetInventoryPath) ? readJSON(assetInventoryPath) : { assets: [] };
const RENDER_OBSERVER_SOURCE = `elements => elements.map(element => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return { visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0, tag: element.tagName.toLowerCase(), text: element.textContent.trim(), src: element.currentSrc || element.src || null, href: element.href || null, value: 'value' in element ? element.value : null }; })`;
if (Number(fieldPlan.schemaVersion || 0) >= 1.1 && (Number(config.schemaVersion || 0) < 1.1 || config.evidenceProtocol?.version !== 'playwright-computed-render-v1' || normalizeSource(config.evidenceProtocol?.renderObserverSource) !== normalizeSource(RENDER_OBSERVER_SOURCE))) fail('frontend runtime config does not preserve the required browser evidence protocol');
if (config.status !== 'implemented' || !config.start?.command || !config.healthUrl || !config.e2e?.command) fail('frontend runtime config is incomplete');
const evidenceDir = `${dir}/evidence/frontend`;
const rawPath = `${evidenceDir}/raw-browser-report.json`;
for (const file of [rawPath, `${dir}/browser-e2e-report.json`, `${dir}/frontend-runtime-report.json`]) if (existsSync(file)) rmSync(file);
mkdirSync(evidenceDir, { recursive: true });
const appPort = String(config.port || await freePort()); const browserPort = String(await freePort());
const cleanDataDir = mkdtempSync(`${tmpdir()}/pi-clean-data-`);
const uploadChallenges = Object.fromEntries([...operations.values()].filter((operation) => operation.resourceTransfer).map((operation) => { const bytes = randomBytes(97); const path = `${cleanDataDir}/upload-${sha(Buffer.from(operation.id)).slice(0, 12)}.bin`; writeFileSync(path, bytes); return [operation.id, { path, sha256: sha(bytes), bytes: bytes.length, fileField: operation.resourceTransfer.fileField }]; }));
const appBaseUrl = expand(config.baseUrl || config.healthUrl.replace(/\/health.*$/, ''), { PORT: appPort }); const browserBaseUrl = replacePort(appBaseUrl, browserPort);
const variables = { PORT: browserPort, BASE_URL: browserBaseUrl, DATA_DIR: cleanDataDir, FRONTEND_UPLOAD_CHALLENGES: JSON.stringify(uploadChallenges) };
const appVariables = { PORT: appPort, BASE_URL: appBaseUrl, DATA_DIR: variables.DATA_DIR };
const app = spawn(config.start.command, (config.start.args || []).map((value) => expand(value, appVariables)), { cwd: resolve(dir, config.start.cwd || '.'), env: expandedEnv(config.start.env, appVariables), stdio: ['ignore', 'pipe', 'pipe'] });
const output = [];
app.stdout.on('data', (chunk) => output.push(chunk)); app.stderr.on('data', (chunk) => output.push(chunk));
let originProxy;
try {
  await waitFor(expand(config.healthUrl, appVariables), Number(config.startupTimeoutMs || 20000));
  originProxy = await startOriginProxy({ port: Number(browserPort), targetBaseUrl: appBaseUrl });
  const e2eArgs = (config.e2e.args || []).map((value) => expand(value, variables));
  const result = await runProcess(config.e2e.command, e2eArgs, { cwd: resolve(dir, config.e2e.cwd || '.'), env: { ...expandedEnv(config.e2e.env, variables), FRONTEND_RAW_REPORT: rawPath, BASE_URL: variables.BASE_URL }, timeout: Number(config.e2e.timeoutMs || 120000) });
  writeFileSync(`${evidenceDir}/browser-e2e-command.txt`, `$ ${config.e2e.command} ${e2eArgs.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`);
  if (result.status !== 0) fail('browser E2E command failed');
  if (!existsSync(rawPath) || statSync(rawPath).size === 0) fail('browser E2E did not produce a raw runtime report');
  const raw = readJSON(rawPath);
  const findings = validateRaw(raw);
  findings.push(...validatePlaywrightTrace(raw, variables.BASE_URL, originProxy.receipts));
  findings.push(...(await verifyItemIndependence(raw.cases, appBaseUrl)));
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
  if (originProxy) await originProxy.close();
  app.kill('SIGTERM');
  writeFileSync(`${evidenceDir}/application-runtime.txt`, Buffer.concat(output).toString());
  rmSync(cleanDataDir, { recursive: true, force: true });
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
  if ((assetInventory.assets || []).length) { const requiredPages = new Set([...uiContracts.values()].filter((item) => item.presentation?.mode !== 'headless').map((item) => item.presentation.targetPageId)); for (const pageId of requiredPages) if (!(raw.cases || []).some((item) => item.event === 'initial-state' && item.pageId === pageId)) errors.push(`browser report has no clean-session initial-state case for page: ${pageId}`); }
  return errors;
}
function validatePlaywrightTrace(raw, baseUrl, originReceipts) {
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
  const sourceTexts = entries.filter((entry) => /^resources\/src@.+\.txt$/.test(entry)).map((entry) => spawnSync('unzip', ['-p', file, entry], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })).filter((result) => result.status === 0).map((result) => result.stdout);
  errors.push(...networkInterceptionFindings(traceEvents, sourceTexts));
  if (errors.length) return errors;
  const usedCallIds = new Set();
  const actions = (raw.cases || []).map((item) => {
    const matches = traceEvents.filter((event) => event.type === 'before' && !usedCallIds.has(event.callId) && event.method === traceMethod(item.event) && (item.event === 'initial-state' ? samePageUrl(event.params?.url, item.pageUrl) : JSON.stringify(event.params || {}).includes(item.locator)));
    const event = item.event === 'initial-state' ? matches[0] : matches.find((candidate) => samePageUrl(actionPageUrl(traceEvents, candidate), item.pageUrl)) || matches[0];
    if (event?.callId) usedCallIds.add(event.callId);
    return { item, event, pageUrl: item.event === 'initial-state' ? event?.params?.url : actionPageUrl(traceEvents, event) };
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
    const contractForCase = uiContracts.get(item.capabilityId);
    const casePageId = item.pageId || contractForCase?.presentation?.targetPageId;
    const provenance = deriveControlProvenance(finalDom, item, contractForCase);
    if (provenance) { item.provenance = provenance; if (!provenance.matched) errors.push(`runtime trigger element identity does not match the release control: ${item.id} — operate the release control [data-vr-id="${provenance.expectedControl}"], not an injected surrogate`); }
    const releaseAnchors = deriveReleaseAnchors(finalDom, casePageId);
    const plannedContract = contractForCase?.specificationStatus === 'planned' || contractForCase?.presentation?.mode === 'extend-flow';
    const anchorsApply = item.event === 'initial-state' || (contractForCase && !plannedContract && contractForCase.presentation?.mode !== 'headless');
    if (anchorsApply && releaseAnchors && releaseAnchors.missing.length) errors.push(`release layout anchors disappeared after the action: ${item.id} [${releaseAnchors.missing.join(', ')}] — keep the release page controls present; a delivered action must not replace <main> with a bespoke surface`);
    let addControlRegion;
    if (contractForCase?.presentation?.mode === 'add-control' && contractForCase?.specificationStatus !== 'planned' && item.event !== 'initial-state') { addControlRegion = { preferredRegion: contractForCase.presentation.preferredRegion, withinRegion: ancestorHasVrId(finalDom, item.locator, contractForCase.presentation.preferredRegion) }; if (!addControlRegion.withinRegion) errors.push(`add-control capability control is outside its declared region: ${item.id} — place the added control within [data-vr-id="${contractForCase.presentation.preferredRegion}"]`); }
    const activeCapabilityId = lastMainAttribute(finalDom, 'data-active-capability-id'); const capabilityStatus = lastMainAttribute(finalDom, 'data-capability-status');
    const actionBefore = segment.find((candidate) => candidate.type === 'frame-snapshot' && candidate.snapshot?.snapshotName === event.beforeSnapshot); const actionAfter = segment.find((candidate) => candidate.type === 'frame-snapshot' && candidate.snapshot?.callId === event.callId && candidate.snapshot?.snapshotName?.startsWith('after@'));
    const stateTransitions = [...new Set([...segmentText.matchAll(/"data-state":"([^"]+)"/g)].map((match) => match[1]))];
    const observedRequests = networkEvents.flatMap((candidate) => { const snapshot = candidate.snapshot; const time = Number(snapshot?._monotonicTime); if (!snapshot || time < start || time >= end) return []; try { const url = new URL(snapshot.request?.url); const contentType = headerValue(snapshot.request?.headers, 'content-type'); return [{ method: snapshot.request?.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: Object.fromEntries((snapshot.request?.headers || []).map((entry) => [String(entry.name).toLowerCase(), entry.value])), responseHeaders: Object.fromEntries((snapshot.response?.headers || []).map((entry) => [String(entry.name).toLowerCase(), entry.value])), status: Number(snapshot.response?.status), contentType, requestBody: tracePostData(file, snapshot.request?.postData, contentType), responseBody: traceResponseBody(file, snapshot) }]; } catch { return []; } });
    const operationId = interactionOperations.get(item.id); const operation = operations.get(operationId); const operationRequest = matchingRequest(observedRequests, operation); const previousGoto = [...traceEvents].reverse().find((candidate) => candidate.type === 'before' && candidate.method === 'goto' && Number(candidate.startTime) < start)?.startTime ?? -Infinity;
    if (operation && operationRequest && !hasOriginReceipt(operationRequest, originReceipts)) errors.push(`operation response lacks a runner-owned application origin receipt: ${item.id} — remove interception and let the request reach the runner-proxied application`);
    const caseEvents = traceEvents.filter((candidate) => eventTime(candidate) > previousGoto && eventTime(candidate) < end);
    const fileBinding = operation?.resourceTransfer ? (fieldPlan.bindings || []).find((binding) => binding.operationId === operationId && binding.kind === 'input' && String(binding.requestPath).replace(/^body\./, '') === operation.resourceTransfer.fileField) : undefined;
    const fileSelectionAction = operation?.resourceTransfer && event.method === 'setInputFiles' && (!fileBinding || JSON.stringify(event.params || {}).includes(fileBinding.controlId)) ? event : undefined;
    const selectedFiles = actionValue(fileSelectionAction);
    const selectedPaths = Array.isArray(selectedFiles) ? selectedFiles : selectedFiles ? [selectedFiles] : []; const challenge = uploadChallenges[operationId]; const multipartFiles = operationRequest?.requestBody?.files?.[operation?.resourceTransfer?.fileField] || [];
    const responseIntegrityDigests = operation?.resourceTransfer ? collectNamedValues(operationRequest?.responseBody, /checksum|sha256|digest/i) : [];
    const fileSelectionEvidence = operation?.resourceTransfer ? { operationId, controlId: fileBinding?.controlId, fileField: operation.resourceTransfer.fileField, actionCallId: fileSelectionAction?.callId, observedAction: fileSelectionAction?.method, selectedCount: selectedPaths.length, selectedChallenge: selectedPaths.length === 1 && selectedPaths[0] === challenge?.path, requestMatched: Boolean(operationRequest), requestContentType: operationRequest?.contentType, contractContentType: operation.resourceTransfer.contentType || operation.request?.contentType, multipartFiles, responseIntegrityDigests, challengeDigestMatched: (multipartFiles.length === 1 && multipartFiles[0].sha256 === challenge?.sha256 && multipartFiles[0].bytes === challenge?.bytes) || responseIntegrityDigests.includes(challenge?.sha256) } : undefined;
    const inputBindings = (fieldPlan.bindings || []).filter((binding) => binding.kind === 'input' && binding.capabilityId === item.capabilityId && (!operationId || binding.operationId === operationId)).map((binding) => {
      const fill = [...traceEvents].reverse().find((candidate) => candidate.type === 'before' && ['fill', 'setInputFiles', 'selectOption', 'check'].includes(candidate.method) && Number(candidate.startTime) > previousGoto && Number(candidate.startTime) < start && JSON.stringify(candidate.params || {}).includes(binding.controlId));
      if (operation?.resourceTransfer && String(binding.requestPath).replace(/^body\./, '') === operation.resourceTransfer.fileField) return { bindingId: binding.id, controlId: binding.controlId, operationId: binding.operationId, bindingType: 'multipart-file', inputValue: challenge?.sha256, requestValue: multipartFiles.map((item) => item.sha256), dynamic: fileSelectionEvidence?.selectedChallenge === true && fileSelectionEvidence?.challengeDigestMatched === true };
      const inputValue = actionValue(fill) ?? observedStateValue(finalDom, binding, caseEvents); const requestValue = requestBindingValue(operationRequest, operation, binding);
      return { bindingId: binding.id, controlId: binding.controlId, operationId: binding.operationId, inputValue, requestValue, dynamic: inputValue !== undefined && deepEqual(inputValue, requestValue) && !deepEqual(inputValue, binding.schema?.default) };
    });
    if (matchCount !== 1 || visible !== true || (item.mode !== 'display-only' && item.event !== 'initial-state' && enabled !== true)) errors.push(`Playwright trace does not prove a unique visible enabled binding: ${item.id}`);
    if (item.event === 'initial-state') {
      const initialFindings = validateInitialState(item, finalDom, observedRequests); errors.push(...initialFindings); item.observed = { matchCount, visible, enabled, pageUrl, cleanSession: true, networkRequests: observedRequests, stateTransitions, domChanged: false, releaseAnchors, visibleText: visibleText(finalDom) }; continue;
    }
    const contract = uiContracts.get(item.capabilityId); const expectedStatus = contract?.specificationStatus === 'planned' ? 'planned' : 'implemented';
    if (activeCapabilityId !== item.capabilityId || capabilityStatus !== expectedStatus) errors.push(`Playwright trace does not prove the expected active capability state ${expectedStatus}: ${item.id}`);
    const fingerprint = deriveSurfaceFingerprint(finalDom);
    const resultBindings = (fieldPlan.bindings || []).filter((binding) => binding.kind === 'result' && binding.capabilityId === item.capabilityId && (!operationId || binding.operationId === operationId));
    const failureScenario = item.expectedOutcome === 'failure';
    const resultEvidence = failureScenario ? [] : resultBindings.map((binding) => deriveResultEvidence(finalDom, binding, operationRequest, segment, caseEvents, start, event.callId));
    for (const evidence of resultEvidence) { if (!evidence.testDomMutationFree) errors.push(`result binding was preceded by test-authored DOM mutation: ${evidence.bindingId}`); if (!evidence.regionPresent || !evidence.regionVisible) errors.push(`result binding target region is absent or hidden: ${evidence.bindingId}`); if (!evidence.allElementsVisible) errors.push(`result binding contains hidden result elements: ${evidence.bindingId}`); if (!evidence.semanticMatches) errors.push(`result binding element semantic differs from the contract: ${evidence.bindingId}`); if (evidence.responseCount !== evidence.expectedCount || evidence.actualCount !== evidence.expectedCount) errors.push(`result binding request, response, and element counts differ: ${evidence.bindingId}`); if (!deepEqual(evidence.actualValues, evidence.expectedValues)) errors.push(`result binding values differ from the operation response: ${evidence.bindingId}`); if (evidence.actualCount === 0 || evidence.regionStatus !== 'success') errors.push(`result binding only updates status or never reaches semantic success: ${evidence.bindingId}`); }
    const displayEvidence = failureScenario ? [] : (fieldPlan.bindings || []).filter((binding) => binding.kind === 'display' && binding.runtimeValueRequired === true && binding.capabilityId === item.capabilityId && (!operationId || binding.operationId === operationId)).map((binding) => deriveDisplayEvidence(finalDom, binding, operationRequest, segment, caseEvents, start, event.callId));
    for (const evidence of displayEvidence) if (!evidence.testDomMutationFree || !evidence.allElementsVisible || !evidence.semanticMatches || !deepEqual(evidence.actualValues, evidence.expectedValues)) errors.push(`display binding does not visibly render the matching response value without test-authored DOM mutation: ${evidence.bindingId}`);
    if (failureScenario && !resultBindings.every((binding) => visibleFailureRegion(finalDom, binding.regionId))) errors.push(`failure scenario does not visibly render the declared result-region error state: ${item.id}`);
    if (expectedStatus === 'planned' && ((fingerprint?.inputIds || []).length || fingerprint?.primaryAction || fingerprint?.primaryOperationId || (fingerprint?.requiredRegions || []).some((region) => /result|output/i.test(region)))) errors.push(`planned capability retains implemented inputs, primary action, operation, or result surface: ${item.id}`);
    item.observed = { matchCount, visible, enabled, pageUrl, actionCallId: event.callId, activeCapabilityId, capabilityStatus, networkRequests: observedRequests, inputBindings, ...(fileSelectionEvidence ? { fileSelectionEvidence } : {}), resultEvidence, displayEvidence, stateTransitions, domChanged: Boolean(actionBefore && actionAfter && JSON.stringify(actionBefore.snapshot?.html) !== JSON.stringify(actionAfter.snapshot?.html)), releaseAnchors, ...(addControlRegion ? { addControlRegion } : {}), visibleText: visibleText(finalDom) };
    item.surfaceFingerprint = fingerprint;
  }
  return errors;
}
function jsonLines(value) { return String(value).split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function traceMethod(event) { return ({ click: 'click', submit: 'click', change: 'fill', upload: 'setInputFiles', 'initial-state': 'goto' })[event] || event || 'click'; }
function eventTime(event) { return Number(event.startTime ?? event.endTime ?? event.time ?? event.snapshot?.timestamp ?? -1); }
function traceResult(events, method, locator) { const before = events.find((event) => event.type === 'before' && event.method === method && JSON.stringify(event.params || {}).includes(locator)); if (!before) return undefined; return events.find((event) => event.type === 'after' && event.callId === before.callId)?.result?.value; }
function traceMethodResult(events, method) { const before = events.find((event) => event.type === 'before' && event.method === method); if (!before) return undefined; return events.find((event) => event.type === 'after' && event.callId === before.callId)?.result?.value; }
function actionPageUrl(events, event) { if (!event) return undefined; const named = events.find((candidate) => candidate.type === 'frame-snapshot' && candidate.snapshot?.snapshotName === event.beforeSnapshot); if (named?.snapshot?.frameUrl) return named.snapshot.frameUrl; return [...events].reverse().find((candidate) => candidate.type === 'frame-snapshot' && candidate.pageId === event.pageId && eventTime(candidate) <= eventTime(event))?.snapshot?.frameUrl; }
function samePageUrl(actual, expected) { try { const left = new URL(actual); const right = new URL(expected); return left.origin === right.origin && normalizePath(left.pathname) === normalizePath(right.pathname); } catch { return false; } }
function replacePort(value, port) { const url = new URL(value); url.hostname = '127.0.0.1'; url.port = String(port); return url.origin; }
function normalizePath(value) { const path = String(value || '/').replace(/\/+$/, ''); return path || '/'; }
function headerValue(headers, name) { const item = (headers || []).find((entry) => String(entry.name).toLowerCase() === name); return item?.value; }
function parseBody(value) { if (value === undefined || value === null) return undefined; if (typeof value === 'object') return value; try { return JSON.parse(value); } catch { return String(value); } }
function actionValue(event) { if (!event) return undefined; if (event.method === 'setInputFiles') return event.params?.localPaths || event.params?.files || event.params?.payloads; if (event.method === 'check') return true; return event.params?.value ?? event.params?.values ?? event.params?.options; }
function getPath(value, path) { return String(path || '').split('.').filter(Boolean).reduce((current, key) => current?.[key], value); }
function deepEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function matchingRequest(requests, operation) { return operation && requests.find((request) => String(request.method).toUpperCase() === String(operation.method).toUpperCase() && pathMatches(operation.path, request.path)); }
function pathMatches(contractPath, observedPath) { const pattern = String(contractPath || '').split(/(\{[^}]+\})/).map((part) => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''); return new RegExp(`^${pattern}$`).test(observedPath); }
function traceResponseBody(traceFile, snapshot) { const sha1 = snapshot.response?.content?._sha1; if (!sha1) return undefined; const result = spawnSync('unzip', ['-p', traceFile, `resources/${sha1}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); return result.status === 0 ? parseBody(result.stdout) : undefined; }
function tracePostData(traceFile, postData, contentType) { const sha1 = postData?._sha1; const result = sha1 ? spawnSync('unzip', ['-p', traceFile, `resources/${sha1}`], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }) : null; const bytes = result?.status === 0 ? result.stdout : Buffer.from(typeof postData === 'string' ? postData : JSON.stringify(postData || '')); return String(contentType || '').toLowerCase().includes('multipart/form-data') ? parseMultipart(bytes, contentType) : parseBody(bytes.toString('utf8')); }
function parseMultipart(bytes, contentType) { const boundary = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.slice(1).find(Boolean); if (!boundary) return { fields: {}, files: {} }; const fields = {}; const files = {}; for (const part of bytes.toString('binary').split(`--${boundary}`).slice(1, -1)) { const split = part.indexOf('\r\n\r\n'); if (split < 0) continue; const headers = part.slice(0, split); const bodyBinary = part.slice(split + 4).replace(/\r\n$/, ''); const name = headers.match(/name="([^"]+)"/i)?.[1]; const filename = headers.match(/filename="([^"]*)"/i)?.[1]; if (!name) continue; if (filename !== undefined) { const body = Buffer.from(bodyBinary, 'binary'); (files[name] ||= []).push({ filename, contentType: headers.match(/content-type:\s*([^\r\n]+)/i)?.[1], bytes: body.length, sha256: sha(body) }); } else fields[name] = Buffer.from(bodyBinary, 'binary').toString('utf8'); } return { fields, files }; }
function requestBindingValue(request, operation, binding) { const [location, ...parts] = String(binding.requestPath || '').split('.'); const fieldPath = parts.join('.'); if (location === 'body') return getPath(request?.requestBody?.fields || request?.requestBody, fieldPath); if (location === 'query') return getPath(request?.query, fieldPath); if (location === 'header') return getPath(request?.headers, fieldPath.toLowerCase()); if (location === 'path') return pathParameters(operation?.path, request?.path)?.[parts[0]]; return undefined; }
function pathParameters(contractPath, observedPath) { const names = [...String(contractPath || '').matchAll(/\{([^}]+)\}/g)].map((item) => item[1]); const pattern = String(contractPath || '').split(/(\{[^}]+\})/).map((part) => part.startsWith('{') ? '([^/]+)' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''); const match = String(observedPath || '').match(new RegExp(`^${pattern}$`)); return match ? Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])])) : {}; }
function observedStateValue(html, binding, events) { const element = semanticElements(html).find((item) => item.attributes['data-state-binding-id'] === binding.id); const rendered = renderObservation(events, `[data-state-binding-id="${binding.id}"]`); return element?.visible && rendered.length === 1 && rendered[0].visible === true ? observedRenderValue(rendered[0]) : undefined; }
function lastAttribute(text, name) { return [...text.matchAll(new RegExp(`"${name}":"([^"]*)"`, 'g'))].at(-1)?.[1]; }
function lastMainAttribute(html = '', name) { const mains = [...String(html).matchAll(/<main\b([^>]*)>/gi)].map((match) => match[1]).filter((attrs) => !/\bhidden\b|aria-hidden=["']true["']|display\s*:\s*none/i.test(attrs)); return attribute(mains.at(-1), name); }
function deriveSurfaceFingerprint(html = '') { const activeMain = [...String(html).matchAll(/<main\b[^>]*data-active-capability-id=["'][^"']+["'][^>]*>([\s\S]*?)<\/main>/gi)].at(-1)?.[0] || ''; const heading = attribute(activeMain, 'data-surface-heading'); if (!heading) return undefined; return { heading, inputIds: [...new Set([...activeMain.matchAll(/data-domain-input-id=["']([^"']+)["']/gi)].map((match) => match[1]))], primaryAction: attribute(activeMain, 'data-primary-action'), primaryOperationId: attribute(activeMain, 'data-primary-operation-id'), emptyState: attribute(activeMain, 'data-empty-state'), requiredRegions: [...new Set([...activeMain.matchAll(/data-region=["']([^"']+)["']/gi)].map((match) => match[1]))] }; }
function deriveResultEvidence(html = '', binding, request, traceSegment = [], caseEvents = [], operationStart = -Infinity, actionCallId = null) {
  const activeMain = [...String(html).matchAll(/<main\b[^>]*data-active-capability-id=["'][^"']+["'][^>]*>([\s\S]*?)<\/main>/gi)].at(-1)?.[0] || '';
  const elements = semanticElements(activeMain); const region = elements.find((item) => item.attributes['data-result-region-id'] === binding.regionId && !item.attributes['data-result-binding-id']); const items = elements.filter((item) => item.attributes['data-result-region-id'] === binding.regionId && item.attributes['data-result-binding-id'] === binding.id);
  const raw = getPath(request?.responseBody, binding.responsePath); const expectedValues = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(semanticValue); const requestCountPath = String(binding.count?.requestPath || '').replace(/^request\./, ''); const requestCount = binding.count?.mode === 'request-field' ? Number(getPath(request?.requestBody?.fields || request?.requestBody, requestCountPath.replace(/^body\./, ''))) : null; const expectedCount = Number.isFinite(requestCount) ? requestCount : expectedValues.length;
  const rendered = renderObservation(traceSegment, `[data-result-binding-id="${binding.id}"]`); const renderedRegion = renderObservation(traceSegment, `[data-result-region-id="${binding.regionId}"]:not([data-result-binding-id])`); const actualValues = rendered.map((item, index) => observedRenderValue(item, expectedValues[index])); const observedSemantics = rendered.map((item) => observedResultSemantic(item.tag));
  return { bindingId: binding.id, operationId: binding.operationId, observationSource: rendered.length && renderedRegion.length === 1 ? 'playwright-computed-render-v1' : null, testDomMutationFree: !hasPostOperationTestDomMutation(caseEvents, { operationStart, actionCallId, observerSource: RENDER_OBSERVER_SOURCE }), regionId: binding.regionId, elementSemantic: binding.elementSemantic, observedSemantics, semanticMatches: rendered.length > 0 && observedSemantics.every((semantic) => semantic === binding.elementSemantic), allElementsVisible: rendered.length > 0 && rendered.every((item) => item.visible === true), regionPresent: Boolean(region) && renderedRegion.length === 1, regionVisible: renderedRegion[0]?.visible === true, regionStatus: region?.attributes['data-result-status'], expectedCount, responseCount: expectedValues.length, actualCount: rendered.length, expectedValues, actualValues };
}
function deriveDisplayEvidence(html = '', binding, request, traceSegment = [], caseEvents = [], operationStart = -Infinity, actionCallId = null) {
  const activeMain = [...String(html).matchAll(/<main\b[^>]*data-active-capability-id=["'][^"']+["'][^>]*>([\s\S]*?)<\/main>/gi)].at(-1)?.[0] || ''; const elements = semanticElements(activeMain).filter((item) => item.attributes['data-display-binding-id'] === binding.id); const raw = getPath(request?.responseBody, binding.responsePath); const expectedValues = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(semanticValue); const rendered = renderObservation(traceSegment, `[data-display-binding-id="${binding.id}"]`); const actualValues = rendered.map((item, index) => observedRenderValue(item, expectedValues[index])); const expectedSemantic = Array.isArray(raw) ? 'collection-value' : 'field-value';
  return { bindingId: binding.id, observationSource: rendered.length ? 'playwright-computed-render-v1' : null, testDomMutationFree: !hasPostOperationTestDomMutation(caseEvents, { operationStart, actionCallId, observerSource: RENDER_OBSERVER_SOURCE }), expectedValues, actualValues, allElementsVisible: elements.length > 0 && rendered.length === elements.length && rendered.every((item) => item.visible === true), semanticMatches: rendered.length > 0 && binding.elementSemantic === expectedSemantic };
}
function visibleFailureRegion(html, regionId) { const activeMain = [...String(html).matchAll(/<main\b[^>]*data-active-capability-id=["'][^"']+["'][^>]*>([\s\S]*?)<\/main>/gi)].at(-1)?.[0] || ''; const elements = semanticElements(activeMain); const region = elements.find((item) => item.attributes['data-result-region-id'] === regionId && !item.attributes['data-result-binding-id']); return Boolean(region?.visible && region.attributes['data-result-status'] === 'error' && new RegExp(`data-result-error=["']true["']`, 'i').test(activeMain)); }
function renderObservation(events, selector) { const before = events.find((event) => event.type === 'before' && ['evalOnSelectorAll', 'evaluateAll'].includes(event.method) && event.params?.selector === selector && normalizeSource(event.params?.expression) === normalizeSource(RENDER_OBSERVER_SOURCE)); if (!before) return []; const value = decodeTraceValue(events.find((event) => event.type === 'after' && event.callId === before.callId)?.result?.value); return Array.isArray(value) ? value : []; }
function decodeTraceValue(value) { if (!value || typeof value !== 'object') return value; if (Array.isArray(value)) return value.map(decodeTraceValue); if (Array.isArray(value.a)) return value.a.map(decodeTraceValue); if (Array.isArray(value.o)) return Object.fromEntries(value.o.map((entry) => [entry.k, decodeTraceValue(entry.v)])); if (Object.hasOwn(value, 's')) return value.s; if (Object.hasOwn(value, 'b')) return value.b; if (Object.hasOwn(value, 'n')) return value.n; if (value.v === 'null') return null; if (value.v === 'undefined') return undefined; return value; }
function normalizeSource(value) { return String(value || '').replace(/\s+/g, ' ').trim().replace(/;\s*}/g, ' }'); }
function observedRenderValue(item, expected) { const raw = ['img', 'video', 'audio', 'source'].includes(item.tag) ? item.src : item.tag === 'a' ? item.href : ['input', 'textarea', 'select'].includes(item.tag) ? item.value : item.text; if (typeof raw === 'string' && typeof expected === 'string') { if (raw === expected) return expected; try { const url = new URL(raw); if (expected === `${url.pathname}${url.search}${url.hash}` || expected === url.pathname) return expected; } catch {} } return parseSemanticValue(raw); }
function observedResultSemantic(tag) { if (['img', 'video', 'audio', 'source'].includes(tag)) return 'media-item'; if (['li', 'tr'].includes(tag)) return 'record-item'; return 'result-item'; }
function semanticElements(html) {
  const result = []; const stack = [];
  for (const match of String(html).matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
    const closing = match[0][1] === '/'; const tag = match[1].toLowerCase();
    if (closing) { const index = stack.map((item) => item.tag).lastIndexOf(tag); if (index >= 0) stack.splice(index); continue; }
    const attributes = Object.fromEntries([...match[2].matchAll(/([:\w-]+)(?:=["']([^"']*)["'])?/g)].map((item) => [item[1].toLowerCase(), item[2] ?? true]));
    const ownHidden = attributes.hidden === true || attributes['aria-hidden'] === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(String(attributes.style || '')); const visible = !ownHidden && stack.every((item) => item.visible);
    if (attributes['data-result-binding-id'] || attributes['data-result-region-id'] || attributes['data-display-binding-id'] || attributes['data-state-binding-id']) result.push({ tag, attributes, visible });
    if (!/\/$/.test(match[0]) && !['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag)) stack.push({ tag, visible });
  }
  return result;
}
function domScan(html) {
  const source = String(html).replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const elements = []; const stack = [];
  for (const match of source.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
    const closing = match[0][1] === '/'; const tag = match[1].toLowerCase();
    if (closing) { const index = stack.map((item) => item.tag).lastIndexOf(tag); if (index >= 0) stack.splice(index); continue; }
    const attributes = Object.fromEntries([...match[2].matchAll(/([:\w-]+)(?:=["']([^"']*)["'])?/g)].map((item) => [item[1].toLowerCase(), item[2] ?? true]));
    const ownHidden = attributes.hidden === true || attributes['aria-hidden'] === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(String(attributes.style || ''));
    const visible = !ownHidden && stack.every((item) => item.visible);
    elements.push({ tag, attributes, visible, ancestorVrIds: stack.map((item) => item.vrId).filter(Boolean) });
    if (!/\/$/.test(match[0]) && !['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag)) stack.push({ tag, visible, vrId: attributes['data-vr-id'] });
  }
  return elements;
}
function deriveControlProvenance(html, item, contract) {
  const reuseControl = contract?.presentation?.mode === 'reuse-control' || contract?.presentation?.activation?.type === 'existing-control';
  if (!reuseControl) return null;
  const expectedControl = contract.presentation?.triggerControl?.controlId;
  const element = domScan(html).find((entry) => entry.attributes.id === item.locator);
  const observedControl = element?.attributes['data-vr-id'] ?? null;
  return { expectedControl: expectedControl ?? null, observedControl, matched: Boolean(expectedControl) && observedControl === expectedControl };
}
function deriveReleaseAnchors(html, pageId) {
  const expected = pageAnchors.get(pageId);
  if (!expected) return null;
  const present = new Set(domScan(html).filter((entry) => entry.visible && entry.attributes['data-vr-id']).map((entry) => entry.attributes['data-vr-id']));
  return { pageId, expected: [...expected], present: [...present], missing: [...expected].filter((anchor) => !present.has(anchor)) };
}
function ancestorHasVrId(html, locator, regionId) {
  const element = domScan(html).find((entry) => entry.attributes.id === locator);
  return Boolean(regionId) && Boolean(element) && element.ancestorVrIds.includes(regionId);
}
function validateInitialState(item, html, requests) {
  const findings = []; const text = `${html}\n${JSON.stringify(requests)}`; const samples = (assetInventory.assets || []).filter((asset) => asset.role === 'business-sample');
  for (const asset of samples) if (text.includes(asset.digest) || text.includes(asset.path)) findings.push(`clean-session initial state exposes business-sample asset: ${asset.id}`);
  if (!String(html).includes('data-clean-session="true"') && !String(html).includes("data-clean-session='true'")) findings.push(`clean-session case has no clean state marker: ${item.pageId}`);
  const pageContracts = [...uiContracts.values()].filter((contract) => contract.presentation?.targetPageId === item.pageId);
  for (const contract of pageContracts) {
    const result = contract.presentation?.surface?.contentContract?.resultContract; if (result) { const regionPattern = new RegExp(`data-result-region-id=["']${escapeRegex(result.targetRegion)}["'][^>]*data-result-status=["']empty["']|data-result-status=["']empty["'][^>]*data-result-region-id=["']${escapeRegex(result.targetRegion)}["']`, 'i'); if (!regionPattern.test(String(html)) || !String(html).includes(contract.presentation.surface.contentContract.emptyState)) findings.push(`clean-session result region does not show its declared empty state: ${contract.capabilityId}`); }
    const capabilityOperations = [...operations.values()].filter((operation) => operation.capabilityId === contract.capabilityId); if (capabilityOperations.some((operation) => operation.resourceTransfer) && !/data-upload-state=["']empty["']/i.test(String(html))) findings.push(`clean-session upload region is not empty: ${contract.capabilityId}`); if (capabilityOperations.some((operation) => /history|list/i.test(operation.id)) && !/data-history-state=["']empty["']/i.test(String(html))) findings.push(`clean-session history region is not empty: ${contract.capabilityId}`);
  }
  return findings;
}
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function semanticValue(value) { return value && typeof value === 'object' ? JSON.stringify(value) : value; }
function parseSemanticValue(value) { if (value === undefined) return undefined; try { return JSON.parse(value); } catch { return value; } }
function visibleText(html = '') { return String(html).replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(/\n+/).filter(Boolean); }
function collectNamedValues(value, pattern, result = []) { if (Array.isArray(value)) for (const item of value) collectNamedValues(item, pattern, result); else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (pattern.test(key) && typeof item === 'string') result.push(item); collectNamedValues(item, pattern, result); } return result; }
function attribute(text = '', name) { return String(text).match(new RegExp(`${name}=["']([^"']*)["']`, 'i'))?.[1]; }
function safePath(relative) { if (!relative || typeof relative !== 'string') return null; const path = resolve(dir, relative); if (!path.startsWith(`${dir}/`) || !existsSync(path) || lstatSync(path).isSymbolicLink()) return null; const rootReal = realpathSync(dir); const targetReal = realpathSync(path); return targetReal.startsWith(`${rootReal}/`) ? targetReal : null; }
function freePort() { return new Promise((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => done(address.port)); }); }); }
async function waitFor(url, timeoutMs) { const start = Date.now(); while (Date.now() - start < timeoutMs) { try { const response = await fetch(url); if (response.ok) return; } catch {} await new Promise((done) => setTimeout(done, 100)); } fail(`application health check timed out: ${url}`); }
function runProcess(command, args, options) { return new Promise((done) => { const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] }); const stdout = []; const stderr = []; child.stdout.on('data', (chunk) => stdout.push(chunk)); child.stderr.on('data', (chunk) => stderr.push(chunk)); const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout); child.on('close', (status) => { clearTimeout(timer); done({ status, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }); }); }); }
function expandedEnv(values = {}, variables) { return { ...process.env, ...variables, ...Object.fromEntries(Object.entries(values || {}).map(([key, value]) => [key, expand(value, variables)])) }; }
function expand(value, variables) { return String(value).replace(/\$\{([A-Z_]+)\}/g, (_, key) => variables[key] ?? `\${${key}}`); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJSON(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function parseArgs(values) { const result = {}; for (let index = 0; index < values.length; index += 1) if (values[index].startsWith('--')) result[values[index].slice(2)] = values[++index]; return result; }
function fail(message) { throw new Error(message); }
// Trusted runner enforcement of the independent-media item contract. The runner reads the item
// collection from the trace-validated operation response (not the browser's self-report), then
// fetches each item resource itself while the application is still running, proving per-item
// uniqueness by response bytes. Every path/field comes from the contract; no content-type or field
// name is assumed, so the gate applies to any collection-resource capability that declares it.
async function verifyItemIndependence(cases, baseUrl) {
  const findings = [];
  for (const [capabilityId, plan] of itemContracts) {
    const operation = operations.get(plan.operationId);
    const kase = (cases || []).find((item) => item.capabilityId === capabilityId && item.expectedOutcome !== 'failure' && item.observed);
    if (!kase) { findings.push(`independent-media capability produced no successful runtime case: ${capabilityId}`); continue; }
    const request = (kase.observed.networkRequests || []).find((item) => operation && item.path === operation.path && item.status >= 200 && item.status < 300);
    const collection = request && plan.responsePath ? getPath(request.responseBody, plan.responsePath.replace(/^response\./, '')) : undefined;
    if (!Array.isArray(collection) || !collection.length) { findings.push(`independent-media response collection is missing or empty: ${capabilityId} (${plan.responsePath})`); continue; }
    const contract = plan.contract;
    const urls = collection.map((item) => (contract.urlField ? item?.[contract.urlField] : item));
    const ids = collection.map((item) => (contract.idField ? item?.[contract.idField] : contract.urlField ? item?.[contract.urlField] : item));
    if (contract.uniqueUrlRequired && new Set(urls).size !== urls.length) findings.push(`independent-media items reuse a resource locator: ${capabilityId}`);
    if (contract.uniqueIdRequired && new Set(ids).size !== ids.length) findings.push(`independent-media items reuse an item identifier: ${capabilityId}`);
    const digests = [];
    for (const url of urls) { if (typeof url !== 'string' || !url) { findings.push(`independent-media item has no resource locator: ${capabilityId}`); continue; } let response; try { response = await fetch(new URL(url, baseUrl)); } catch { response = null; } if (!response || !response.ok) { findings.push(`independent-media item resource did not fetch a 200: ${capabilityId} (${url})`); continue; } digests.push(sha(Buffer.from(await response.arrayBuffer()))); }
    if (contract.uniqueFileRequired && digests.length === urls.length && new Set(digests).size !== digests.length) findings.push(`independent-media items resolve to identical resource bytes: ${capabilityId} — a single result reused across the collection`);
    const requestCount = plan.countRequestPath ? Number(getPath(request.requestBody?.fields || request.requestBody, plan.countRequestPath.replace(/^request\./, '').replace(/^body\./, ''))) : collection.length;
    if (Number.isFinite(requestCount) && requestCount !== collection.length) findings.push(`independent-media collection length (${collection.length}) does not equal the requested quantity (${requestCount}): ${capabilityId}`);
    const nonDefault = plan.controlDefault === undefined ? null : String(requestCount) !== String(plan.controlDefault);
    if (plan.nonDefaultValueRequired && nonDefault === false) findings.push(`independent-media quantity used the control default value (${plan.controlDefault}); a non-default quantity is required so a page default cannot masquerade as an explicit choice: ${capabilityId}`);
    kase.observed.itemIndependence = { capabilityId, count: collection.length, requestCount, nonDefault, uniqueUrls: new Set(urls).size, uniqueIds: new Set(ids).size, uniqueDigests: new Set(digests).size, fetched: digests.length };
  }
  return findings;
}
function usage() { console.error('Usage: run-browser-e2e.mjs --dir <implementation-dir>'); process.exit(2); }
