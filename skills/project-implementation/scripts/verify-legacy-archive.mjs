#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { schemaFindings } from './lib/json-schema.mjs';
import { digestJSON, releaseDigest } from './lib/handoff.mjs';

const dirArg = process.argv.slice(2).find((value) => !value.startsWith('--'));
if (!dirArg) { console.error('Usage: verify-legacy-archive.mjs <legacy-archive> [--require-level simulated|integrated]'); process.exit(2); }
const dir = resolve(dirArg);
const functionalManifestPreview = existsSync(`${dir}/inputs/functional-manifest.json`) ? readJSON(`${dir}/inputs/functional-manifest.json`) : {};
const semanticInputs = functionalManifestPreview.schemaVersion === '2.1' ? ['frontend-semantic-inventory.json', 'observed-interactions.json', 'control-capability-map.json'] : [];
const formalFunctionalInputs = ['manifest.json', 'planning-manifest.json', 'planning-artifacts.json', 'capability-definitions.json', ...semanticInputs, 'functional-spec.json', 'page-function-map.json', 'unresolved-items.json', 'planning-review-receipt.json', 'review-receipt.json', 'package-lock.json'];
const formalHandoffInputs = ['handoff-manifest.json', 'visual-source.json', 'release-manifest.json', 'suite-gate.json', 'visual-approval.json', 'frontend-manifest.json', 'functional-spec.json', ...semanticInputs, 'visual-controls.json', 'ui-implementation-plan.json', 'api-contract.json', 'domain-bindings.json', 'runtime-contract.json', 'handoff-review-receipt.json', 'handoff-lock.json'];
if (process.argv.includes('--legacy') || process.argv.includes('--legacy-archive-internal')) fail(['legacy archive inspection does not accept verifier mode flags']);
const legacyMode = true;
const requiredLevel = optionValue('--require-level') || 'integrated';
const levels = ['simulated', 'integrated'];
if (!levels.includes(requiredLevel)) { console.error(`invalid verification level: ${requiredLevel}`); process.exit(2); }
const hasUiPlan = existsSync(`${dir}/inputs/handoff-ui-implementation-plan.json`);
const requiresFrontendRuntime = hasUiPlan && (readJSON(`${dir}/inputs/handoff-ui-implementation-plan.json`).capabilities || []).some((item) => item.presentation?.mode !== 'headless');
const lockHeader = existsSync(`${dir}/input-lock.json`) ? readJSON(`${dir}/input-lock.json`) : {};
const preparedVersion = Number(lockHeader.schemaVersion || 0);
const hasPreparedHandoff = existsSync(`${dir}/inputs/handoff-handoff-manifest.json`) || Boolean(lockHeader.sources?.handoffPackageDigest);
const requiresBmad = !legacyMode || preparedVersion >= 1.1 || hasPreparedHandoff || hasUiPlan || existsSync(`${dir}/bmad-traceability.json`);
const required = ['input-lock.json', 'implementation-plan.json', ...(!legacyMode ? ['field-binding-plan.json', 'operation-events.json', 'operation-receipts.json'] : []), 'implementation-provenance.json', 'implementation-manifest.json', 'integration-evidence.json', 'openapi.json', 'startup.json', 'test-report.json', ...(requiresBmad ? ['bmad-traceability.json', 'bmad-completion.json'] : []), ...(requiresFrontendRuntime ? ['interaction-manifest.json', 'control-bindings.json', 'frontend-runtime-config.json', 'frontend-runtime-report.json', ...(!legacyMode ? ['frontend-capability-results.json'] : []), 'browser-e2e-report.json', 'placeholder-resolution.json', 'placeholder-audit-report.json'] : [])];
const errors = [];
for (const file of required) if (!existsSync(`${dir}/${file}`) || statSync(`${dir}/${file}`).size === 0) errors.push(`missing ${file}`);
if (errors.length) fail(errors);

const plan = readJSON(`${dir}/implementation-plan.json`);
const manifest = readJSON(`${dir}/implementation-manifest.json`);
const integration = readJSON(`${dir}/integration-evidence.json`);
const report = readJSON(`${dir}/test-report.json`);
const operationReceipts = !legacyMode ? readJSON(`${dir}/operation-receipts.json`) : null;
const provenance = readJSON(`${dir}/implementation-provenance.json`);
const inputLock = readJSON(`${dir}/input-lock.json`);
if (!legacyMode && inputLock.schemaVersion !== '1.1') fail(['formal verification requires input-lock schema 1.1']);
if (requiresBmad && (Number(inputLock.schemaVersion || 0) < 1.1 || inputLock.bmadRequired !== true || !inputLock.bmad?.contracts)) fail(['prepared workspace BMAD requirement was removed or downgraded']);
if (existsSync(`${dir}/implementation-lock.json`)) {
  const prior = readJSON(`${dir}/implementation-lock.json`);
  if (prior.schemaVersion !== '1.0' || prior.algorithm !== 'sha256' || !prior.digests || !prior.sourceDigests || !prior.sourceFiles) fail(['existing implementation lock is incomplete or unsupported']);
}
const bmadTraceability = existsSync(`${dir}/bmad-traceability.json`) ? readJSON(`${dir}/bmad-traceability.json`) : null;
const bmadCompletion = existsSync(`${dir}/bmad-completion.json`) ? readJSON(`${dir}/bmad-completion.json`) : null;
const api = readJSON(!legacyMode ? `${dir}/inputs/handoff-api-contract.json` : (existsSync(`${dir}/inputs/handoff-api-contract.json`) ? `${dir}/inputs/handoff-api-contract.json` : `${dir}/inputs/frontend-api-contract.json`));
if (!legacyMode) verifyFieldBindingPlan(readJSON(`${dir}/field-binding-plan.json`), api, errors);
if (!legacyMode) verifyOperationReceipts(operationReceipts, readFileSync(`${dir}/operation-events.json`), api, errors);
verifyInputLock(inputLock, errors, !legacyMode);
verifyProvenance(plan, provenance, errors);
if (inputLock.bmadRequired === true && !bmadTraceability) errors.push('BMAD traceability is required by the prepared workspace');
if (bmadTraceability) verifyBmadTraceability(plan, bmadTraceability, bmadCompletion, inputLock, errors);
if (requiresFrontendRuntime) verifyImplementedPresentation(api, errors);
if (requiresFrontendRuntime) {
  const runtimeVerification = spawnSync(process.execPath, [resolve(import.meta.dirname, 'verify-frontend-runtime.mjs'), dir], { encoding: 'utf8' });
  if (runtimeVerification.status !== 0) errors.push(`frontend runtime verification failed:\n${runtimeVerification.stderr || runtimeVerification.stdout}`);
}
if (!levels.includes(manifest.verificationLevel)) errors.push('implementation manifest has no valid verification level');
if (manifest.verificationLevel !== integration.verificationLevel) errors.push('manifest and integration evidence levels differ');
if (levels.indexOf(manifest.verificationLevel) < levels.indexOf(requiredLevel)) errors.push(`verification level ${manifest.verificationLevel} is below required ${requiredLevel}`);
if (manifest.verificationLevel !== 'simulated') {
  if (integration.viaApplication !== true || !integration.operationId) errors.push('integrated evidence must come through an application operation');
  const declaredOperationIds = new Set((plan.units || []).flatMap((unit) => unit.operationIds || []));
  if (integration.operationId && !declaredOperationIds.has(integration.operationId)) errors.push(`integrated evidence references unknown operation: ${integration.operationId}`);
  const structuredEvidence = {};
  for (const kind of ['requestEvidence', 'responseEvidence', 'dataEffectEvidence']) {
    const artifacts = integration[kind] || [];
    structuredEvidence[kind] = [];
    if (!artifacts.length) errors.push(`integrated evidence lacks ${kind}`);
    for (const artifact of artifacts) {
      const file = resolveArtifact(artifact);
      if (!file || !existsSync(file) || statSync(file).size === 0) errors.push(`integrated evidence artifact is missing: ${artifact}`);
      else try { structuredEvidence[kind].push(readJSON(file)); } catch { errors.push(`integrated evidence artifact is not valid JSON: ${artifact}`); }
    }
  }
  const contractOperation = (api.operations || api.endpoints || []).find((item) => (item.id || item.operationId) === integration.operationId);
  if (contractOperation) verifyStructuredIntegration(contractOperation, integration.operationId, structuredEvidence, errors);
  const integrationContract = contractOperation?.integrationVerification;
  if (!integrationContract) errors.push(`operation ${integration.operationId} has no integrationVerification contract`);
  if (integrationContract?.endpointPolicy?.nonLocal === true) { const host = endpointHost(integration.endpoint); if (!host || ['localhost', '127.0.0.1', '::1'].includes(host)) errors.push('integrated endpoint policy requires a non-local endpoint'); }
  for (const scenario of integrationContract?.requiredScenarios || []) {
    const item = integration.scenarios?.[scenario];
    if (!item?.status || !['passed', 'observed'].includes(item.status) || !item.evidence?.length) { errors.push(`integrated evidence lacks scenario: ${scenario}`); continue; }
    for (const artifact of item.evidence) {
      const file = resolveArtifact(artifact);
      if (!file || !existsSync(file) || statSync(file).size === 0) errors.push(`integrated scenario evidence is missing: ${artifact}`);
      else try {
        const record = readJSON(file);
        if (record.operationId !== integration.operationId || record.scenario !== scenario || record.observed !== true) errors.push(`integrated scenario evidence does not match ${scenario}: ${artifact}`);
      } catch { errors.push(`integrated scenario evidence is not valid JSON: ${artifact}`); }
    }
  }
  const assertionContext = { request: structuredEvidence.requestEvidence?.find((item) => item.operationId === integration.operationId)?.request, response: structuredEvidence.responseEvidence?.find((item) => item.operationId === integration.operationId)?.body, effects: structuredEvidence.dataEffectEvidence?.filter((item) => item.operationId === integration.operationId) };
  for (const assertion of integrationContract?.artifactAssertions || []) for (const finding of schemaFindings(getPath(assertionContext, assertion.path), assertion.schema || assertion, assertion.path)) errors.push(`integrated artifact assertion ${finding}`);
  const observationPath = resolveArtifact('operation-observation-receipt.json');
  if (!observationPath) errors.push('integrated verification lacks campaign-owned operation observation receipt');
  else {
    const observation = readJSON(observationPath);
    const ingress = observation.observations?.find((item) => item.challengeId === observation.challengeId && String(item.method).toUpperCase() === String(contractOperation?.method).toUpperCase() && pathMatches(contractOperation?.path, item.path) && Number(item.status) >= 200 && Number(item.status) < 300);
    const egress = observation.externalObservations?.find((item) => item.challengeId === observation.challengeId && Number(item.status) >= 200 && Number(item.status) < 300 && ingress && item.observedAt >= ingress.startedAt && item.observedAt <= ingress.observedAt && ingress.responseValues?.includes(item.externalResultId));
    const observedBindings = observation.integrationBindingEvidence || [];
    const bindingsValid = (contractOperation?.integrationBindings || []).every((binding) => observedBindings.some((record) => record.operationId === integration.operationId && record.source === binding.source && record.target === (binding.target || binding.providerField) && record.observed === true && /^[a-f0-9]{64}$/i.test(record.sourceValueDigest || '') && record.sourceValueDigest === record.targetValueDigest));
    if (observation.schemaVersion !== '1.2' || observation.generatedBy !== 'project-implementation/validation-campaign-observer' || observation.operationId !== integration.operationId || observation.status !== 'passed' || !ingress || !egress || !bindingsValid) errors.push('campaign-owned operation observation receipt is invalid');
  }
}
const declaredUnits = new Set((plan.units || []).map((unit) => unit.id));
const plannedUnits = new Map((plan.units || []).map((unit) => [unit.id, unit]));
const completedUnits = new Set((manifest.units || []).filter((unit) => unit.status === 'succeeded').map((unit) => unit.id));
for (const id of declaredUnits) if (!completedUnits.has(id)) errors.push(`implementation unit not succeeded: ${id}`);
for (const unit of manifest.units || []) if (!declaredUnits.has(unit.id)) errors.push(`implementation manifest contains unknown unit: ${unit.id}`);
const passed = new Map((report.cases || []).filter((item) => item.status === 'passed').map((item) => [item.id, item]));
for (const unit of manifest.units || []) {
  for (const testId of unit.testIds || []) {
    const test = passed.get(testId);
    if (!test) errors.push(`unit ${unit.id} lacks passing test ${testId}`);
    if (test && !test.unitIds?.includes(unit.id)) errors.push(`test ${testId} does not declare unit ${unit.id}`);
    if (test && test.unitIds?.length !== 1) errors.push(`test ${testId} must map to exactly one implementation unit`);
    if (!legacyMode && test) for (const operationId of plannedUnits.get(unit.id)?.operationIds || []) verifyOperationTestEvidence((api.operations || []).find((item) => item.id === operationId), test, unit.id, errors);
    for (const artifact of test?.evidence || []) { const file = resolveArtifact(artifact); if (!file || statSync(file).size === 0) errors.push(`test ${testId} lacks safe workspace evidence ${artifact}`); }
  }
  if (!(unit.testIds || []).length) errors.push(`unit ${unit.id} has no test IDs`);
}
if (errors.length) fail(errors);

console.log(JSON.stringify({ schemaVersion: '1.0', generatedBy: 'project-implementation/verify-legacy-archive', status: 'archive-only', mutation: 'none', summary: { structurallyCheckedUnits: declaredUnits.size, observedPassingCases: passed.size }, completionEvidence: false }));

function fail(items) { console.error(items.map((item) => `- ${item}`).join('\n')); process.exit(1); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function optionValue(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
function verifyInputLock(lock, items, formal) {
  if (formal || Number(lock.schemaVersion || 0) >= 1.1) {
    if (lock.schemaVersion !== '1.1' || lock.algorithm !== 'sha256') items.push('prepared input lock schema or algorithm is invalid');
    const expected = [...formalFunctionalInputs.map((file) => `functional/${file}`), ...formalHandoffInputs.map((file) => `handoff/${file}`)].sort();
    const actual = Object.keys(lock.digests || {}).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) items.push('prepared input lock digest file set mismatch');
    const functionalLockPath = `${dir}/inputs/functional-package-lock.json`; const handoffLockPath = `${dir}/inputs/handoff-handoff-lock.json`; const releasePath = `${dir}/inputs/handoff-release-manifest.json`;
    if (!lock.sources || !lock.sources.functionalPackageDigest || !lock.sources.fddPlanningDigest || !lock.sources.handoffPackageDigest || !lock.sources.visualReleaseDigest) items.push('prepared input lock source chain is incomplete');
    else {
      if (!existsSync(functionalLockPath) || lock.sources.functionalPackageDigest !== digestJSON(readJSON(functionalLockPath))) items.push('functional package source digest mismatch');
      if (!existsSync(handoffLockPath) || lock.sources.handoffPackageDigest !== digestJSON(readJSON(handoffLockPath))) items.push('handoff package source digest mismatch');
      const planningFiles = ['planning-manifest.json', 'planning-artifacts.json', 'capability-definitions.json', 'planning-review-receipt.json'];
      const planning = Object.fromEntries(planningFiles.map((file) => [file.replace('.json', '').replaceAll('-', '_'), readJSON(`${dir}/inputs/functional-${file}`)]));
      const planningDigest = digestJSON({ manifest: planning.planning_manifest, artifacts: planning.planning_artifacts, definitions: planning.capability_definitions, review: planning.planning_review_receipt });
      if (lock.sources.fddPlanningDigest !== planningDigest || plan.planningSource?.workflow !== 'fdd-bmad-planning' || plan.planningSource?.digest !== planningDigest || plan.planningSource?.semanticChangesAllowed !== false) items.push('FDD planning source chain or PI semantic boundary is invalid');
      if (!existsSync(releasePath)) items.push('visual release source manifest is missing');
      else { const release = readJSON(releasePath); if (releaseDigest(release) !== release.releaseDigest || lock.sources.visualReleaseDigest !== release.releaseDigest) items.push('visual release source digest mismatch'); }
    }
  }
  for (const [source, digest] of Object.entries(lock.digests || {})) {
    const target = source === 'frontend/web'
      ? `${dir}/web`
      : `${dir}/inputs/${source.replace('/', '-')}`;
    if (!existsSync(target)) { items.push(`locked input is missing: ${source}`); continue; }
    const actual = statSync(target).isDirectory() ? hashDirectory(target) : sha(readFileSync(target));
    if (actual !== digest) items.push(`input lock mismatch: ${source}`);
  }
}
function hashDirectory(root) {
  const hash = createHash('sha256');
  for (const file of walk(root)) {
    hash.update(file.slice(root.length + 1)).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}
function walk(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => !['node_modules', 'dist'].includes(entry.name))
    .flatMap((entry) => entry.isDirectory() ? walk(`${root}/${entry.name}`) : [`${root}/${entry.name}`])
    .sort();
}
function resolveArtifact(relative) {
  if (!relative || typeof relative !== 'string') return null;
  const path = resolve(dir, relative);
  if (path !== dir && !path.startsWith(`${dir}/`)) return null;
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return null;
  const rootReal = realpathSync(dir); const targetReal = realpathSync(path);
  const rel = targetReal.slice(rootReal.length);
  return (targetReal === rootReal || rel.startsWith('/')) ? targetReal : null;
}
function verifyProvenance(plan, provenance, items) {
  if (!provenance.backendSource || provenance.backendSource === 'not-implemented' || provenance.backendSource.status === 'pending') items.push('implementation provenance backend source is pending');
  const sources = new Map((provenance.operationSources || []).map((item) => [item.operationId, item]));
  const operationIds = new Set((plan.units || []).flatMap((unit) => unit.operationIds || []));
  for (const operationId of operationIds) {
    const source = sources.get(operationId);
    if (!source) { items.push(`operation ${operationId} has no source provenance`); continue; }
    const locations = source.files || (source.file ? [{ path: source.file, symbol: source.symbol, route: source.route }] : []);
    if (!locations.length) { items.push(`operation ${operationId} has no source location`); continue; }
    for (const location of locations) {
      if (!location.path || (!location.symbol && !location.route)) { items.push(`operation ${operationId} source location lacks path and symbol or route`); continue; }
      const file = resolveArtifact(location.path);
      if (!file || !existsSync(file) || !statSync(file).isFile()) items.push(`operation ${operationId} source file is missing: ${location.path}`);
      else {
        const sourceText = readFileSync(file, 'utf8');
        const locator = location.symbol || location.route;
        if (!sourceText.includes(locator)) items.push(`operation ${operationId} source locator is absent from ${location.path}: ${locator}`);
      }
    }
  }
}
function verifyFieldBindingPlan(bindingPlan, apiContract, items) {
  if (bindingPlan.generatedFrom !== 'locked-functional-and-handoff-contracts' || !Array.isArray(bindingPlan.bindings)) { items.push('field binding plan is missing or not contract-derived'); return; }
  const ids = new Set(); const operations = new Map((apiContract.operations || []).map((item) => [item.id, item]));
  for (const binding of bindingPlan.bindings) {
    if (!binding.id || ids.has(binding.id)) items.push(`field binding plan has a missing or duplicate binding: ${binding.id || '<missing>'}`); else ids.add(binding.id);
    if (!binding.controlId || !binding.capabilityId || !binding.statePath || typeof binding.required !== 'boolean' || !Array.isArray(binding.effectIds)) items.push(`field binding is incomplete: ${binding.id}`);
    if (binding.operationId && !operations.has(binding.operationId)) items.push(`field binding references unknown operation: ${binding.id}`);
    if (binding.kind === 'input' && !binding.requestPath) items.push(`input binding has no request path: ${binding.id}`);
    if (binding.kind === 'display' && !binding.responsePath) items.push(`display binding has no response path: ${binding.id}`);
  }
  for (const operation of operations.values()) {
    const expectedInputs = requestContractPaths(operation.request || {}).sort(); const actualInputs = bindingPlan.bindings.filter((item) => item.operationId === operation.id && item.kind === 'input').map((item) => item.requestPath).sort();
    const expectedResponses = schemaContractPaths(operation.response?.bodySchema || operation.response?.schema).sort(); const actualResponses = bindingPlan.bindings.filter((item) => item.operationId === operation.id && item.kind === 'display').map((item) => item.responsePath).sort();
    const expectedEffects = (operation.effects || []).map((item, index) => `${operation.id}:${item.entityId}:${item.effect}:${index}`).sort(); const actualEffects = [...new Set(bindingPlan.bindings.filter((item) => item.operationId === operation.id).flatMap((item) => item.effectIds || []))].sort();
    if (JSON.stringify(expectedInputs) !== JSON.stringify(actualInputs)) items.push(`field binding input set differs from operation contract: ${operation.id}`);
    if (JSON.stringify(expectedResponses) !== JSON.stringify(actualResponses)) items.push(`field binding response set differs from operation contract: ${operation.id}`);
    if (JSON.stringify(expectedEffects) !== JSON.stringify(actualEffects)) items.push(`field binding effect set differs from operation contract: ${operation.id}`);
  }
}
function verifyOperationTestEvidence(operation, test, unitId, items) { if (operation && !operationReceipts.receipts?.some((receipt) => receipt.operationId === operation.id && receipt.status === 'passed')) items.push(`unit ${unitId} has no passing runner-owned operation receipt for ${operation.id}`); }
function verifyOperationReceipts(receipts, rawEvents, apiContract, items) { if (receipts.generatedBy !== 'project-implementation/build-operation-receipts' || receipts.trustLevel !== 'self-reported-runtime-events' || receipts.sourceDigest !== sha(rawEvents)) items.push('operation receipts are not bound to declared simulated runtime events'); const expected = new Set((apiContract.operations || []).map((item) => item.id)); const actual = new Set((receipts.receipts || []).map((item) => item.operationId)); if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) items.push('operation receipt set differs from API contract'); for (const receipt of receipts.receipts || []) if (receipt.status !== 'passed' || receipt.findings?.length) items.push(`operation receipt failed: ${receipt.operationId}`); }
function requestContractPaths(request) { return [['path', request.pathSchema], ['query', request.querySchema], ['header', request.headerSchema], ['body', request.bodySchema]].flatMap(([location, schema]) => schemaContractPaths(schema).map((path) => `${location}.${path}`)); }
function schemaContractPaths(schema, prefix = '') { if (!schema || typeof schema !== 'object') return []; if (schema.type === 'object') return Object.entries(schema.properties || {}).flatMap(([key, child]) => schemaContractPaths(child, prefix ? `${prefix}.${key}` : key)); return prefix ? [prefix] : []; }
function verifyBmadTraceability(plan, traceability, completion, lock, items) {
  if (traceability.method !== 'bmad-v6') items.push('BMAD traceability has an unsupported method');
  if (traceability.workflow !== 'pi-implementation-bmad' || traceability.domainAuthority !== 'inputs/functional-functional-spec.json' || traceability.fddPlanningSource !== 'inputs/functional-planning-artifacts.json') items.push('PI implementation BMAD is not separated from FDD planning authority');
  const mappings = new Map();
  const completionRecords = new Map(); const planUnitIds = new Set((plan.units || []).map((unit) => unit.id));
  for (const record of completion?.records || []) {
    if (!record.unitId || completionRecords.has(record.unitId)) { items.push(`BMAD completion has a missing or duplicate unit: ${record.unitId || '<missing>'}`); continue; }
    if (!planUnitIds.has(record.unitId)) items.push(`BMAD completion references unknown unit: ${record.unitId}`);
    completionRecords.set(record.unitId, record);
  }
  const expectedCompletionUnits = [...planUnitIds].sort(); const actualCompletionUnits = [...completionRecords.keys()].sort();
  if (JSON.stringify(expectedCompletionUnits) !== JSON.stringify(actualCompletionUnits)) items.push('BMAD completion record set differs from implementation plan');
  if (completion?.status !== 'completed') items.push('BMAD completion is not completed');
  const sprintPath = resolveArtifact(`${traceability.output}/implementation-artifacts/sprint-status.yaml`);
  const sprint = sprintPath ? parseSprintStatus(readFileSync(sprintPath, 'utf8')) : new Map();
  for (const item of traceability.stories || []) {
    if (!item.unitId || mappings.has(item.unitId)) { items.push(`BMAD traceability has a missing or duplicate unit: ${item.unitId || '<missing>'}`); continue; }
    mappings.set(item.unitId, item);
  }
  for (const unit of plan.units || []) {
    const mapping = mappings.get(unit.id);
    if (!mapping) { items.push(`implementation unit has no BMAD story: ${unit.id}`); continue; }
    const storyPath = [traceability.output, mapping.storyPath].filter(Boolean).join('/');
    const story = resolveArtifact(storyPath);
    if (!story || !existsSync(story) || !statSync(story).isFile()) items.push(`BMAD story is missing for unit ${unit.id}: ${storyPath}`);
    const contract = { unitId: unit.id, type: unit.type, dependsOn: [...(unit.dependsOn || [])], acceptance: [...(unit.acceptance || [])] };
    const contractDigest = sha(Buffer.from(JSON.stringify(contract)));
    if (mapping.contractDigest !== contractDigest || JSON.stringify(mapping.contract) !== JSON.stringify(contract) || lock.bmad?.contracts?.[unit.id] !== contractDigest) items.push(`BMAD immutable story contract differs for unit: ${unit.id}`);
    else if (story) {
      const storyText = readFileSync(story, 'utf8'); const storyDocument = parseMarkdownStory(storyText); const record = completionRecords.get(unit.id);
      if (storyDocument.contractDigest !== contractDigest) items.push(`BMAD story no longer declares its source contract digest: ${unit.id}`);
      if (JSON.stringify(parseStoryContract(storyDocument)) !== JSON.stringify(contract)) items.push(`BMAD story source contract text differs for unit: ${unit.id}`);
      if (!['done', 'completed'].includes(storyDocument.status) || storyDocument.checkboxes.some((item) => !item.checked)) items.push(`BMAD story tasks are not completed: ${unit.id}`);
      if (!storyDocument.sections.has('dev agent record') || !storyDocument.sections.has('code review record')) items.push(`BMAD story lacks development or code review records: ${unit.id}`);
      const devTime = Date.parse(record?.devStory?.completedAt); const reviewTime = Date.parse(record?.codeReview?.reviewedAt);
      const devAgent = sectionField(storyDocument, 'dev agent record', 'agent'); const reviewAgent = sectionField(storyDocument, 'code review record', 'reviewer');
      if (!record || record.storyId !== mapping.storyId || record.storyDigest !== sha(Buffer.from(storyText)) || record.devStory?.status !== 'completed' || !record.devStory?.agentId || record.codeReview?.status !== 'approved' || !record.codeReview?.reviewerAgentId || record.codeReview.reviewerAgentId === record.devStory.agentId || !Number.isFinite(devTime) || !Number.isFinite(reviewTime) || reviewTime < devTime || devAgent !== record.devStory.agentId || reviewAgent !== record.codeReview.reviewerAgentId) items.push(`BMAD completion receipt is invalid: ${unit.id}`);
      if (!['done', 'completed'].includes(sprint.get(mapping.storyId))) items.push(`BMAD sprint status is not completed: ${unit.id}`);
    }
  }
  if (lock.bmadRequired === true) {
    const expected = Object.keys(lock.bmad?.contracts || {}).sort();
    const actual = (traceability.stories || []).map((item) => item.unitId).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) items.push('BMAD locked story set differs from traceability');
  }
  for (const unitId of mappings.keys()) if (!(plan.units || []).some((unit) => unit.id === unitId)) items.push(`BMAD traceability references unknown unit: ${unitId}`);
}
function parseStoryContract(document) {
  const source = document.sections.get('source contract') || [];
  const field = (name) => source.find((item) => item.key === name)?.value;
  const dependsLine = field('depends on');
  return { unitId: unquoteCode(field('implementation unit')), type: unquoteCode(field('type')), dependsOn: !dependsLine || dependsLine === 'none' ? [] : codeValues(dependsLine), acceptance: (document.sections.get('acceptance criteria') || []).filter((item) => item.checkbox).map((item) => item.text) };
}
function parseMarkdownStory(text) {
  const sections = new Map(); const checkboxes = []; let section = ''; let inFence = false; let inComment = false; let status; let contractDigest;
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw;
    if (inComment) { const end = line.indexOf('-->'); if (end < 0) continue; line = line.slice(end + 3); inComment = false; }
    while (line.includes('<!--')) { const start = line.indexOf('<!--'); const end = line.indexOf('-->', start + 4); if (end < 0) { line = line.slice(0, start); inComment = true; break; } line = line.slice(0, start) + line.slice(end + 3); }
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) { inFence = !inFence; continue; }
    if (inFence || !trimmed) continue;
    if (trimmed.startsWith('## ')) { section = trimmed.slice(3).trim().toLowerCase(); if (!sections.has(section)) sections.set(section, []); continue; }
    if (!section && trimmed.toLowerCase().startsWith('status:')) status = scalar(trimmed.slice(trimmed.indexOf(':') + 1)).toLowerCase();
    const checkbox = parseCheckbox(trimmed); if (checkbox) checkboxes.push(checkbox);
    if (section) {
      const entry = checkbox || parseMarkdownField(trimmed) || { text: trimmed };
      sections.get(section).push(entry);
      if (section === 'source contract' && entry.key === 'contract digest') contractDigest = unquoteCode(entry.value);
    }
  }
  return { status, contractDigest, sections, checkboxes };
}
function parseMarkdownField(line) { if (!line.startsWith('- ')) return null; const body = line.slice(2); const index = body.indexOf(':'); return index < 1 ? null : { key: body.slice(0, index).trim().toLowerCase(), value: body.slice(index + 1).trim() }; }
function sectionField(document, section, key) { return scalar((document.sections.get(section) || []).find((item) => item.key === key)?.value); }
function parseCheckbox(line) { const lower = line.toLowerCase(); if (!lower.startsWith('- [') || line.length < 6 || line[4] !== ']') return null; const mark = lower[3]; if (mark !== ' ' && mark !== 'x') return null; return { checkbox: true, checked: mark === 'x', text: line.slice(5).trim() }; }
function unquoteCode(value) { const text = String(value || '').trim(); return text.startsWith('`') && text.endsWith('`') ? text.slice(1, -1) : text; }
function codeValues(value) { const result = []; let rest = String(value); while (rest.includes('`')) { const start = rest.indexOf('`'); const end = rest.indexOf('`', start + 1); if (end < 0) break; result.push(rest.slice(start + 1, end)); rest = rest.slice(end + 1); } return result; }
function parseSprintStatus(text) {
  const result = new Map(); let inDevelopmentStatus = false; let developmentIndent = -1;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = stripYamlComment(raw); if (!line.trim()) continue; const indent = line.length - line.trimStart().length; const trimmed = line.trim();
    if (trimmed === 'development_status:') { inDevelopmentStatus = true; developmentIndent = indent; continue; }
    if (!inDevelopmentStatus) continue; if (indent <= developmentIndent) break;
    const pair = splitYamlPair(trimmed); if (pair) result.set(scalar(pair[0]), scalar(pair[1]).toLowerCase());
  }
  return result;
}
function stripYamlComment(line) { let single = false; let double = false; for (let index = 0; index < line.length; index += 1) { const char = line[index]; if (char === "'" && !double) single = !single; else if (char === '"' && !single && line[index - 1] !== '\\') double = !double; else if (char === '#' && !single && !double) return line.slice(0, index); } return line; }
function splitYamlPair(line) { let single = false; let double = false; for (let index = 0; index < line.length; index += 1) { const char = line[index]; if (char === "'" && !double) single = !single; else if (char === '"' && !single && line[index - 1] !== '\\') double = !double; else if (char === ':' && !single && !double) return [line.slice(0, index), line.slice(index + 1)]; } return null; }
function scalar(value) { const text = String(value || '').trim(); if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1); return text; }
function verifyImplementedPresentation(apiContract, items) {
  const uiPlan = readJSON(`${dir}/inputs/handoff-ui-implementation-plan.json`);
  const interactions = readJSON(`${dir}/interaction-manifest.json`);
  const controls = readJSON(`${dir}/control-bindings.json`);
  if (interactions.status !== 'implemented') items.push('interaction manifest is not implemented');
  if (controls.status !== 'implemented') items.push('control bindings are not implemented');
  const operations = new Map((apiContract.operations || []).map((operation) => [operation.id, operation]));
  const intents = new Map((uiPlan.capabilities || []).map((item) => [item.capabilityId, item.presentation]));
  const interactionItems = interactions.interactions || [];
  const bindingItems = controls.bindings || [];
  for (const interaction of interactionItems) {
    const intent = intents.get(interaction.capabilityId);
    if (!intent) items.push(`interaction references unknown capability: ${interaction.capabilityId}`);
    if (interaction.operationId) {
      const operation = operations.get(interaction.operationId);
      if (!operation) items.push(`interaction references unknown operation: ${interaction.operationId}`);
      else if (operation.capabilityId !== interaction.capabilityId) items.push(`interaction capability does not match operation: ${interaction.operationId}`);
    }
  }
  for (const binding of bindingItems) {
    const intent = intents.get(binding.capabilityId);
    if (!intent) { items.push(`control binding references unknown capability: ${binding.capabilityId}`); continue; }
    if (binding.mode !== intent.mode) items.push(`control binding mode differs from UI intent: ${binding.capabilityId}`);
    if (!binding.source?.path || !binding.source?.locator) { items.push(`control binding has no source location: ${binding.capabilityId}`); continue; }
    const file = resolveArtifact(binding.source.path);
    if (!file || !existsSync(file) || !statSync(file).isFile()) items.push(`control binding source is missing: ${binding.source.path}`);
    else if (!readFileSync(file, 'utf8').includes(binding.source.locator)) items.push(`control binding locator is absent from ${binding.source.path}: ${binding.source.locator}`);
    if (binding.operationId) {
      const operation = operations.get(binding.operationId);
      if (!operation || operation.capabilityId !== binding.capabilityId) items.push(`control binding operation does not match capability: ${binding.capabilityId}`);
    }
  }
  for (const [capabilityId, intent] of intents) {
    if (intent.mode === 'headless') continue;
    const matches = bindingItems.filter((item) => item.capabilityId === capabilityId);
    if (!matches.length) items.push(`capability has no implemented presentation binding: ${capabilityId}`);
    const contract = (uiPlan.capabilities || []).find((item) => item.capabilityId === capabilityId);
    if (contract?.specificationStatus === 'planned') {
      if (matches.some((item) => item.operationId) || !matches.some((item) => item.bindingType === 'planned-state' || item.bindingType === 'activation')) items.push(`planned capability has an operation binding or no planned-state presentation: ${capabilityId}`);
      continue;
    }
    const capabilityOperations = new Set([...operations.values()].filter((operation) => operation.capabilityId === capabilityId).map((operation) => operation.id));
    if (intent.mode === 'display-only') {
      const renders = matches.filter((item) => item.bindingType === 'data-render' && item.trigger);
      if (!renders.length) items.push(`display-only capability has no data-render binding: ${capabilityId}`);
      continue;
    }
    const requiresServerOperation = capabilityOperations.size > 0 || intent.behavior === 'server-operation';
    if (requiresServerOperation && !interactionItems.some((item) => item.capabilityId === capabilityId && capabilityOperations.has(item.operationId))) items.push(`capability has no implemented operation interaction: ${capabilityId}`);
  }
}
function verifyStructuredIntegration(operation, operationId, evidence, items) {
  const requests = evidence.requestEvidence || [];
  const matchingRequest = requests.find((item) => item.operationId === operationId && String(item.method).toUpperCase() === String(operation.method).toUpperCase() && item.path === operation.path && item.request && typeof item.request === 'object');
  if (!matchingRequest) items.push(`integrated request evidence does not match operation contract: ${operationId}`);
  else for (const [location, schema] of [['path', operation.request?.pathSchema], ['query', operation.request?.querySchema], ['header', operation.request?.headerSchema], ['body', operation.request?.bodySchema]]) {
    const value = Object.hasOwn(matchingRequest.request, location) ? matchingRequest.request[location] : location === 'body' ? matchingRequest.request : {};
    for (const error of schemaFindings(value, schema, `request.${location}`)) items.push(`integrated ${operationId} ${error}`);
  }
  const responses = evidence.responseEvidence || [];
  const matchingResponse = responses.find((item) => item.operationId === operationId && ((operation.successStatuses?.map(Number) || []).includes(Number(item.status)) || (!operation.successStatuses?.length && Number(item.status) >= 200 && Number(item.status) < 300)));
  if (!matchingResponse) items.push(`integrated response evidence does not match operation contract: ${operationId}`);
  else for (const error of schemaFindings(matchingResponse.body, operation.response?.bodySchema || operation.response?.schema, 'response.body')) items.push(`integrated ${operationId} ${error}`);
  const effects = (evidence.dataEffectEvidence || []).filter((item) => item.operationId === operationId).flatMap((item) => item.effects || []);
  for (const expected of operation.effects || []) {
    const observed = effects.find((item) => item.entityId === expected.entityId && item.effect === expected.effect && item.observed === true && Object.hasOwn(item, 'before') && Object.hasOwn(item, 'after'));
    if (!observed) items.push(`integrated data-effect evidence does not cover ${operationId}/${expected.entityId}/${expected.effect}`);
  }
  for (const dependency of operation.dataDependencies || []) {
    const complete = (evidence.dataFlowEvidence || []).some((record) => record.sourceOperationId === dependency.sourceOperationId && record.sourceField === dependency.sourceField && record.targetOperationId === operationId && record.targetField === dependency.targetField && record.observed === true && /^[a-f0-9]{64}$/i.test(record.sourceValueDigest || '') && record.sourceValueDigest === record.targetValueDigest && record.runtimeGenerated === true);
    if (!complete) items.push(`integrated data flow does not prove ${dependency.sourceOperationId}:${dependency.sourceField} -> ${operationId}:${dependency.targetField}`);
  }
  for (const binding of operation.integrationBindings || []) {
    const complete = (evidence.integrationBindingEvidence || []).some((record) => record.operationId === operationId && record.source === binding.source && record.target === (binding.target || binding.providerField) && record.observed === true && /^[a-f0-9]{64}$/i.test(record.valueDigest || ''));
    if (!complete) items.push(`integrated external binding is not proven: ${operationId}/${binding.source}`);
  }
}
function getPath(value, path) { return String(path || '').split('.').filter(Boolean).reduce((current, key) => current?.[key], value); }
function endpointHost(endpoint) { if (endpoint?.host) return endpoint.host; try { return new URL(endpoint?.url).hostname; } catch { return null; } }
function pathMatches(contractPath, observedPath) { const pattern = String(contractPath || '').split(/(\{[^}]+\})/).map((part) => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''); return new RegExp(`^${pattern}$`).test(observedPath); }
function implementationSources() {
  const groups = { backend: [], frontend: [], migrations: [], tests: [], deployment: [] };
  const generated = new Set([...required, 'bmad-traceability.json', 'implementation-lock.json', 'unit-test-report.json', 'operation-observation-receipt.json']);
  for (const file of walk(dir)) {
    const relative = file.slice(dir.length + 1).replaceAll('\\', '/');
    if (generated.has(relative) || /^(inputs|evidence|_bmad-output|node_modules|dist|\.git)\//.test(relative)) continue;
    if (!/\.(?:[cm]?[jt]sx?|ts|tsx|py|rb|go|rs|java|kt|cs|php|sql|graphql|prisma|sh|ya?ml|toml|json|html|css|scss|vue|svelte)$/.test(relative) && !/(?:^|\/)(?:Dockerfile|Makefile)$/.test(relative)) continue;
    const group = relative.startsWith('web/') || relative.startsWith('frontend/') ? 'frontend'
      : /(^|\/)(tests?|specs?|__tests__)(\/|$)|\.(?:test|spec)\./.test(relative) ? 'tests'
        : /(^|\/)(migrations?|schema)(\/|\.|$)/.test(relative) || /\.sql$/.test(relative) ? 'migrations'
          : /(^|\/)(deploy|deployment|infra|k8s|helm)(\/|$)|(^|\/)(Dockerfile|docker-compose[^/]*)$/.test(relative) ? 'deployment'
            : 'backend';
    groups[group].push(relative);
  }
  for (const files of Object.values(groups)) files.sort();
  return groups;
}
function hashSourceFiles(files) {
  const hash = createHash('sha256');
  for (const relative of files) hash.update(relative).update('\0').update(readFileSync(`${dir}/${relative}`)).update('\0');
  return hash.digest('hex');
}
