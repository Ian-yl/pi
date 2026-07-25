#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { presentationFindings } from './lib/presentation.mjs';
import { treeDigest } from './lib/validator-tree.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.package || !args['reviewer-agent']) usage();
const dir = resolve(args.package);
const manifest = read('manifest.json');
const spec = read('functional-spec.json');
const unresolved = read('unresolved-items.json');
const planningManifest = read('planning-manifest.json');
const planningArtifacts = read('planning-artifacts.json');
const definitions = read('capability-definitions.json');
const schema22 = manifest.schemaVersion === '2.2';
const semanticMode = false;
const SCHEMA_22_SEMANTIC_FILES = ['frontend-semantic-inventory.json', 'observed-interactions.json', 'control-capability-map.json', 'asset-role-inventory.json'];
const assetRoleMode = schema22;
const frontendInventory = schema22 ? read('frontend-semantic-inventory.json') : {};
const observedInteractions = schema22 ? read('observed-interactions.json') : {};
const controlMap = schema22 ? read('control-capability-map.json') : {};
const assetInventory = assetRoleMode ? read('asset-role-inventory.json') : { assets: [] };
const reviewerAgentId = args['reviewer-agent'];
const findings = [];
if (manifest.schemaVersion !== '2.2') findings.push('only functional-domain schema 2.2 can be reviewed');
if (schema22 && JSON.stringify(manifest.semanticArtifacts) !== JSON.stringify(SCHEMA_22_SEMANTIC_FILES)) findings.push('schema 2.2 semanticArtifacts must equal the fixed semantic artifact contract');
if (planningManifest.packageType !== 'fdd-bmad-planning' || planningArtifacts.method !== 'bmad-planning') findings.push('FDD BMAD planning artifacts are invalid');
for (const group of ['capabilities', 'entities', 'valueObjects', 'relationships', 'consistencyBoundaries', 'journeys', 'rules', 'permissions', 'integrations']) if (JSON.stringify(definitions[group] || []) !== JSON.stringify(spec[group] || [])) findings.push(`planning capability definitions differ from formal domain: ${group}`);
if (semanticMode && (!frontendInventory.pages?.length || !frontendInventory.sourceSummary?.length || observedInteractions.releaseDigest !== frontendInventory.release?.releaseDigest || controlMap.releaseDigest !== frontendInventory.release?.releaseDigest)) findings.push('frontend release semantics were not fully extracted and release-bound');
if (assetRoleMode && (assetInventory.releaseDigest !== frontendInventory.release?.releaseDigest || !Array.isArray(assetInventory.assets))) findings.push('asset role inventory is absent or not release-bound');
for (const asset of assetInventory.assets || []) { if (!['decorative', 'business-sample'].includes(asset.role) || !asset.digest || !asset.evidence?.sources?.length) findings.push(`${asset.id || asset.path}: static asset is unclassified`); if (asset.role === 'business-sample' && !['api-data', 'user-input', 'empty-state'].includes(asset.requiredReplacement)) findings.push(`${asset.id}: business sample has no replacement contract`); }
if (semanticMode && (spec.architecture?.visualAlignment?.status !== 'aligned' || spec.architecture?.visualAlignment?.coverage !== 1 || spec.architecture?.visualAlignment?.routeMismatches?.length)) findings.push('architecture pages, routes, and immutable frontend release are not aligned');
if (!manifest.authorAgentId) findings.push('missing authorAgentId');
if (manifest.authorAgentId === reviewerAgentId) findings.push('reviewer must be a different agent from the author');
for (const item of unresolved.items || []) if (item.severity === 'blocker' && item.status !== 'resolved') findings.push(`${item.id}: ${item.question}`);
for (const capability of spec.capabilities || []) if (capability.specificationStatus === 'blocked') findings.push(`${capability.id}: capability specification is blocked`);
for (const capability of spec.capabilities || []) if (semanticMode && capability.specificationStatus === 'planned' && capability.presentation?.mode === 'headless') findings.push(`${capability.id}: planned capability cannot be headless`);
for (const capability of spec.capabilities || []) findings.push(...presentationFindings(capability.id, capability.presentation, capability, { requireDeliveryPolicy: semanticMode }));
for (const capability of spec.capabilities || []) {
  const requiredIntent = ['userGoal', 'businessOutcome', 'trigger', 'prerequisites', 'inputs', 'processingSemantics', 'outputs', 'sideEffects', 'downstreamUsage', 'qualityCriteria', 'failures', 'evidence'];
  if (semanticMode && requiredIntent.some((field) => capability.capabilityIntent?.[field] === undefined)) findings.push(`${capability.id}: capability intent is not semantically closed`);
  if (semanticMode) { const leaf = (spec.architecture?.leafClassifications || []).find((item) => item.pageId === capability.pageIds?.[0] && item.leafId === capability.synthesisAnalysis?.sourceArchitectureLeafId); if (!leaf || (!['business-capability', 'operation'].includes(leaf.classification) && !leaf.embeddedOperations?.length)) findings.push(`${capability.id}: capability was synthesized from an input, display, local control, navigation, state, or constraint leaf without an embedded operation`); }
  if (semanticMode && (capability.synthesisAnalysis?.classifierRole !== 'candidate-analysis' || (capability.specificationStatus === 'complete' && capability.synthesisAnalysis?.minimumImplementableInformation !== 'satisfied'))) findings.push(`${capability.id}: keyword classification was not confirmed by minimum implementable information`);
  if (semanticMode && capability.synthesisAnalysis?.confidence === 'low' && !['planned', 'blocked'].includes(capability.specificationStatus)) findings.push(`${capability.id}: low-confidence semantics must remain planned until an explicit decision exists`);
  if (semanticMode && capability.specificationStatus === 'planned' && ((capability.operations || []).length || (capability.entityEffects || []).length || capability.writesState || (capability.inputs || []).length || capability.inputSchema || (capability.outcomes || []).length || capability.outputSchema || (capability.acceptanceExamples || []).length || capability.deliveryPolicy?.requiredForCompletion !== false || capability.deliveryPolicy?.uiBehavior !== 'show-planned-state' || !capability.planningReason)) findings.push(`${capability.id}: planned capability exposes implementation semantics or lacks a planned UI contract`);
  if (semanticMode && capability.synthesisAnalysis?.confidence === 'medium') {
    const decision = capability.synthesisAnalysis.bmadDecision;
    if (decision?.status !== 'accepted' || decision.chosenPattern !== capability.synthesisAnalysis.candidatePattern || !decision.rationale || !decision.rejectedAlternatives?.length || decision.rejectedAlternatives.some((item) => !item.pattern || !item.reason) || !decision.evidence?.length || !decision.reviewerAgentId || decision.inputDigest !== planningManifest.synthesisInputDigest) findings.push(`${capability.id}: medium-confidence semantics have no accepted input-bound BMAD decision`);
  }
  if (semanticMode) for (const input of capability.capabilityIntent?.inputs || []) {
    const ownership = input.ownership;
    if (!ownership?.type) findings.push(`${capability.id}: input ${input.id} has no capability-specific ownership evidence`);
    if (ownership?.capabilityModuleId && ownership.capabilityModuleId !== capability.synthesisAnalysis?.sourceModuleId) findings.push(`${capability.id}: input ${input.id} belongs to another capability module`);
    if (ownership?.type === 'architecture-owner-module' && ownership.ownerModuleId !== capability.synthesisAnalysis?.sourceContainerModuleId && Number(ownership.affinity || 0) < 0.6) findings.push(`${capability.id}: input ${input.id} is not semantically related to its capability`);
  }
  if (semanticMode && capability.presentation?.mode !== 'headless' && !(controlMap.mappings || []).some((item) => item.capabilityId === capability.id)) findings.push(`${capability.id}: frontend control mapping is absent`);
  if (capability.presentation?.primaryOperationId && !(capability.operations || []).some((operation) => operation.id === capability.presentation.primaryOperationId)) findings.push(`${capability.id}: primary operation is absent`);
  if (semanticMode && (containsUnconstrainedGeneric(capability.inputSchema) || containsUnconstrainedGeneric(capability.outputSchema))) findings.push(`${capability.id}: unconstrained generic objects replace business schemas`);
  if (semanticMode && capability.specificationStatus === 'complete' && ['create', 'update', 'retry', 'external-operation'].includes(capability.synthesisAnalysis?.candidatePattern) && hasOnlyNameWrappedGenericResult(capability.outputSchema)) findings.push(`${capability.id}: capability-name wrapper around kind/references/quality is not a business result contract`);
  if (semanticMode && capability.aggregateSubmission) findings.push(...reviewAggregateSubmission(capability, spec));
  if (semanticMode) findings.push(...reviewResultPresentation(capability, frontendInventory));
  for (const operation of capability.operations || []) {
    if (semanticMode && (!operation.authorization || !operation.idempotency || !operation.concurrency || !operation.acceptanceExample || !operation.errors?.length)) findings.push(`${operation.id}: operation semantics are incomplete`);
    const resourceTransfer = operation.resourceTransfer || (!semanticMode ? operation.assetTransfer : null);
    if (semanticMode && operation.assetTransfer) findings.push(`${operation.id}: legacy assetTransfer must be migrated to resourceTransfer`);
    if (operation.request?.contentType === 'multipart/form-data' && (!resourceTransfer || resourceTransfer.interaction !== 'file-selection')) findings.push(`${operation.id}: transfer has no file-selection resource transfer contract`);
    if (operation.providerContract && !operation.providerContract.parameterMappings?.length) findings.push(`${operation.id}: provider contract does not cover operation inputs`);
    if (operation.providerContract) for (const mapping of operation.providerContract.parameterMappings || []) if (!(operation.integrationBindings || []).some((binding) => binding.source === mapping.source && binding.target === mapping.target && binding.required === mapping.required)) findings.push(`${operation.id}: provider mapping ${mapping.source} is not a formal integration binding`);
    if (semanticMode && operation.providerContract && !operation.integrationVerification) findings.push(`${operation.id}: provider contract has no integrated verification scenarios`);
    if (semanticMode && (!operation.ruleIds?.length || operation.ruleIds.some((ruleId) => !capability.ruleIds?.includes(ruleId)))) findings.push(`${operation.id}: operation is not bound to capability rules`);
    if (operation.dataDependencies?.some((item) => !item.runtimeValueRequired || !item.requiredOwnership || !item.requiredLifecycleStatus)) findings.push(`${operation.id}: runtime data lineage is incomplete`);
  }
  if (capability.evidence?.status !== 'designed') continue;
  if (!capability.evidence.rationale) findings.push(`${capability.id}: designed capability has no rationale`);
  if (!capability.operations?.length && capability.presentation?.behavior === 'server-operation') findings.push(`${capability.id}: designed server capability has no operation`);
  for (const example of capability.acceptanceExamples || []) {
    if (!example.given || typeof example.given !== 'object' || Array.isArray(example.given)) findings.push(`${capability.id}: acceptance example has no structured given values`);
    for (const value of allStrings(example.given)) {
      if (/placeholder|undetermined|TODO/i.test(value)) findings.push(`${capability.id}: acceptance example contains placeholder text: ${value}`);
      if (value.startsWith('fixtures/') && !existsSync(`${dir}/${value}`)) findings.push(`${capability.id}: acceptance fixture does not exist: ${value}`);
    }
    if (!Array.isArray(example.then) || !example.then.length || example.then.some((item) => typeof item !== 'object' || !item.assertion)) findings.push(`${capability.id}: acceptance example does not contain executable assertions`);
  }
}
const fingerprints = new Map();
const triggers = new Map();
const providerFingerprints = new Map();
for (const capability of spec.capabilities || []) {
  if (!semanticMode) break;
  if (capability.aliasOf) continue;
  const fingerprint = JSON.stringify({ pageScope: capability.pageIds, input: capability.inputSchema, output: capability.outputSchema, processing: capability.capabilityIntent?.processingSemantics, effects: capability.entityEffects, failures: capability.failures });
  if (fingerprints.has(fingerprint)) findings.push(`${capability.id}: business semantics are indistinguishable from ${fingerprints.get(fingerprint)}`); else fingerprints.set(fingerprint, capability.id);
  const trigger = capability.presentation?.triggerControl?.controlId; const triggerKey = `${capability.pageIds?.[0]}:${trigger}`;
  if (trigger) { if (triggers.has(triggerKey)) findings.push(`${capability.id}: primary trigger ${trigger} is already assigned to unrelated capability ${triggers.get(triggerKey)}`); else triggers.set(triggerKey, capability.id); }
  const provider = capability.operations?.find((operation) => operation.providerContract)?.providerContract;
  if (provider) {
    const providerFingerprint = JSON.stringify({ pageScope: capability.pageIds, requiredCapability: provider.requiredCapability, transformation: provider.transformation, parameterMappings: provider.parameterMappings, assetBindings: provider.assetBindings, inputConstraints: provider.inputConstraints });
    if (providerFingerprints.has(providerFingerprint)) findings.push(`${capability.id}: provider semantics are indistinguishable from ${providerFingerprints.get(providerFingerprint)}`); else providerFingerprints.set(providerFingerprint, capability.id);
  }
}
if (findings.length) {
  manifest.status = 'draft';
  delete manifest.approval;
  write('manifest.json', manifest);
  if (existsSync(`${dir}/review-receipt.json`)) rmSync(`${dir}/review-receipt.json`);
  if (existsSync(`${dir}/planning-review-receipt.json`)) rmSync(`${dir}/planning-review-receipt.json`);
  if (existsSync(`${dir}/approval-runtime`)) rmSync(`${dir}/approval-runtime`, { recursive: true, force: true });
  write('review-rejection.json', { schemaVersion: '1.0', status: 'rejected', authorAgentId: manifest.authorAgentId, reviewerAgentId, reviewedAt: new Date().toISOString(), findings });
  console.error(`Package rejected by independent reviewer (${findings.length} finding(s))`);
  process.exit(1);
}
manifest.status = 'approved';
manifest.approval = { method: 'independent-agent-review', reviewerAgentId, reviewedAt: new Date().toISOString() };
write('manifest.json', manifest);
planningManifest.status = 'approved';
const reviewPhase = planningArtifacts.phases.find((item) => item.id === 'independent-domain-review');
if (reviewPhase) { reviewPhase.status = 'completed'; reviewPhase.outputs = { reviewerAgentId, result: 'approved' }; }
write('planning-manifest.json', planningManifest);
write('planning-artifacts.json', planningArtifacts);
write('planning-review-receipt.json', { schemaVersion: '1.0', status: 'approved', workflow: 'fdd-bmad-planning', authorAgentId: manifest.authorAgentId, reviewerAgentId, reviewedAt: manifest.approval.reviewedAt, checks: ['project understanding reviewed', 'requirements analysis reviewed', 'domain design matches capability definitions', 'formal package semantics reviewed'] });
if (existsSync(`${dir}/approval-runtime`)) rmSync(`${dir}/approval-runtime`, { recursive: true, force: true });
// Signing pins the latest immutable validator revision. A new approval can never be minted against a
// superseded revision to evade its added rules — an explicit downgrade request is rejected, so the only
// way to keep an older revision is to already hold an older approval receipt (never to sign a new one).
const LATEST_VALIDATOR_ID = 'fdd-validator-2.2.1';
const requestedValidatorId = args['validator-version'] ? `fdd-validator-${args['validator-version']}` : LATEST_VALIDATOR_ID;
if (requestedValidatorId !== LATEST_VALIDATOR_ID) { console.error(`cannot sign an approval with the superseded validator revision ${requestedValidatorId}; new approvals are pinned to the latest ${LATEST_VALIDATOR_ID}`); process.exit(1); }
const trustedValidatorId = LATEST_VALIDATOR_ID;
const trustedValidatorPath = resolve(import.meta.dirname, `../validators/${trustedValidatorId.replace('fdd-validator-', 'fdd-')}/validate-package.mjs`);
write('review-receipt.json', { schemaVersion: '1.4', contractVersion: `functional-domain/${manifest.schemaVersion}`, trustedValidatorId, validatorDigest: treeDigest(resolve(trustedValidatorPath, '..')), status: 'approved', authorAgentId: manifest.authorAgentId, reviewerAgentId, reviewedAt: manifest.approval.reviewedAt, checks: ['all blockers resolved', 'all capability specifications complete', 'evidence statuses reviewed', 'acceptance criteria executable'] });
const validation = spawnSync('node', [resolve(import.meta.dirname, 'validate-package.mjs'), dir, '--require-approved'], { encoding: 'utf8' });
process.stdout.write(validation.stdout || ''); process.stderr.write(validation.stderr || '');
if (validation.status !== 0) {
  manifest.status = 'draft'; delete manifest.approval; write('manifest.json', manifest);
  planningManifest.status = 'review-pending'; write('planning-manifest.json', planningManifest);
  if (reviewPhase) { reviewPhase.status = 'pending'; reviewPhase.outputs = {}; write('planning-artifacts.json', planningArtifacts); }
  if (existsSync(`${dir}/review-receipt.json`)) rmSync(`${dir}/review-receipt.json`);
  if (existsSync(`${dir}/planning-review-receipt.json`)) rmSync(`${dir}/planning-review-receipt.json`);
  if (existsSync(`${dir}/approval-runtime`)) rmSync(`${dir}/approval-runtime`, { recursive: true, force: true });
  write('review-rejection.json', { schemaVersion: '1.0', status: 'rejected', authorAgentId: manifest.authorAgentId, reviewerAgentId, reviewedAt: new Date().toISOString(), findings: ['complete package validation failed after review checks'] });
}
process.exit(validation.status ?? 1);

function read(file) { return JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')); }
function write(file, value) { writeFileSync(`${dir}/${file}`, `${JSON.stringify(value, null, 2)}\n`); }
function digestFile(file) { return hash(readFileSync(resolve(import.meta.dirname, file))); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function allStrings(value, found = []) { if (typeof value === 'string') found.push(value); else if (Array.isArray(value)) for (const item of value) allStrings(item, found); else if (value && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, found); return found; }
function containsUnconstrainedGeneric(schema) { if (!schema || typeof schema !== 'object') return false; if (schema.type === 'object' && schema.additionalProperties === true && !Object.keys(schema.properties || {}).length) return true; return Object.values(schema).some((value) => Array.isArray(value) ? value.some(containsUnconstrainedGeneric) : containsUnconstrainedGeneric(value)); }
function reviewResultPresentation(capability, frontend) {
  const result = []; const product = capability.aggregateSubmission?.finalProduct || (capability.specificationStatus === 'complete' && ['create', 'update', 'retry', 'external-operation'].includes(capability.synthesisAnalysis?.candidatePattern)); const contract = capability.resultPresentation;
  if (product && capability.specificationStatus === 'complete' && !contract) return [`${capability.id}: product-producing complete capability has no resultPresentation`];
  if (!contract) return result;
  const page = (frontend.pages || []).find((item) => item.pageId === capability.pageIds?.[0]); const regions = new Set([...(page?.regions || []).map((item) => item.regionId), ...(page?.resultSurfaces || []).map((item) => item.surfaceId)]);
  if (!regions.has(contract.targetRegion)) result.push(`${capability.id}: resultPresentation targets a region absent from the immutable release inventory`);
  if (!['confirmed', 'documented', 'observed'].includes(contract.evidence?.status)) result.push(`${capability.id}: resultPresentation is not evidence-backed`);
  if (!contract.bindings?.length || contract.bindings.some((item) => !item.responsePath || !item.element?.semantic || !item.count?.mode)) result.push(`${capability.id}: resultPresentation has incomplete response-to-element bindings`);
  for (const state of ['processing', 'success', 'failure']) if (!contract.states?.[state]?.regionStatus || !contract.states?.[state]?.elementSemantic) result.push(`${capability.id}: resultPresentation lacks ${state} state semantics`);
  if (contract.states?.success?.requiresBoundElements !== true || contract.states?.success?.elementSemantic === 'status-text') result.push(`${capability.id}: status text alone does not present the operation result`);
  return result;
}
function reviewAggregateSubmission(capability, spec) { const result = []; const aggregate = capability.aggregateSubmission; if (aggregate.status === 'planned') { if (capability.specificationStatus !== 'planned' || capability.operations?.length || capability.inputSchema || capability.acceptanceExamples?.length) result.push(`${capability.id}: unresolved aggregate submission is not fail-closed planned`); return result; } if (capability.operations?.length !== 1) result.push(`${capability.id}: one aggregate submit action does not map to exactly one final submit operation`); const operation = capability.operations?.[0]; const sectionFields = aggregate.sections.flatMap((section) => section.fields.map((field) => field.id)); const schemaFields = Object.keys(operation?.request?.bodySchema?.properties || {}); for (const field of sectionFields) if (!schemaFields.includes(field)) result.push(`${capability.id}: aggregate request schema omits section field ${field}`); const config = (spec.entities || []).find((entity) => entity.id === aggregate.configurationAggregate?.entityId); if (!config?.aggregateRoot || !operation?.effects?.some((effect) => effect.entityId === config.id)) result.push(`${capability.id}: aggregate configuration root is absent or not written by final submit`); if (!aggregate.finalProduct?.type || !aggregate.finalProduct?.quantity || !aggregate.finalProduct?.lifecycle?.length || !aggregate.finalProduct?.downstreamUsage?.length) result.push(`${capability.id}: final product semantics are incomplete`); return result; }
function hasOnlyNameWrappedGenericResult(schema) { const generic = new Set(['id', 'operationId', 'status', 'output', 'result']); const specialized = Object.entries(schema?.properties || {}).filter(([key]) => !generic.has(key)); return specialized.length > 0 && specialized.every(([, value]) => { const keys = Object.keys(value?.properties || {}); return value?.type === 'object' && keys.length > 0 && keys.every((key) => ['kind', 'references', 'quality'].includes(key)) && keys.includes('kind') && keys.includes('references'); }); }
function parseArgs(values) { const result = {}; for (let i = 0; i < values.length; i++) if (values[i].startsWith('--')) { result[values[i].slice(2)] = values[i + 1]; i++; } return result; }
function usage() { console.error('Usage: review-package.mjs --package <dir> --reviewer-agent <stable-agent-id>'); process.exit(2); }
