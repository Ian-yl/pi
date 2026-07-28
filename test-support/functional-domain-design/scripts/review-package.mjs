#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { presentationFindings } from './lib/presentation.mjs';
import { primarySubmitFindings } from './lib/primary-submit.mjs';
import { controlDispositionFindings } from './lib/control-dispositions.mjs';
import { treeDigest } from './lib/validator-tree.mjs';
import { buildSemanticReviewRequest, semanticReviewFindings } from './lib/semantic-review.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.package || !args['reviewer-agent']) usage();
const dir = resolve(args.package);
const manifest = read('manifest.json');
const inputMode = manifest.inputMode;
const spec = read('functional-spec.json');
const unresolved = read('unresolved-items.json');
const planningManifest = read('planning-manifest.json');
const planningArtifacts = read('planning-artifacts.json');
const definitions = read('capability-definitions.json');
const designManifest = read('design-manifest.json');
const schema23 = manifest.schemaVersion === '2.3';
const SCHEMA_23_SEMANTIC_FILES = ['frontend-semantic-inventory.json', 'observed-interactions.json', 'control-capability-map.json', 'asset-role-inventory.json'];
const assetRoleMode = schema23;
const frontendInventory = schema23 ? read('frontend-semantic-inventory.json') : {};
const observedInteractions = schema23 ? read('observed-interactions.json') : {};
const controlMap = schema23 ? read('control-capability-map.json') : {};
const controlDispositions = schema23 ? read('control-dispositions.json') : { dispositions: [] };
const assetInventory = assetRoleMode ? read('asset-role-inventory.json') : { assets: [] };
const reviewerAgentId = args['reviewer-agent'];
const findings = [];
const semanticReviewRequest = buildSemanticReviewRequest(dir, spec, frontendInventory, controlDispositions);
write('semantic-review-request.json', semanticReviewRequest);
if (args['prepare-semantic-review']) { console.log(`Semantic review request written: ${dir}/semantic-review-request.json`); process.exit(0); }
const semanticReview = existsSync(`${dir}/semantic-review.json`) ? read('semantic-review.json') : null;
if (!semanticReview) findings.push('independent reviewer Agent must author semantic-review.json from semantic-review-request.json before approval');
else findings.push(...semanticReviewFindings(semanticReviewRequest, semanticReview, reviewerAgentId));
if (schema23) findings.push(...primarySubmitFindings(spec, frontendInventory, observedInteractions, controlMap));
if (schema23) findings.push(...controlDispositionFindings(controlDispositions, spec, frontendInventory, controlMap, observedInteractions));
const coreCapabilityIds = new Set((spec.journeys || []).filter((journey) => journey.core === true).flatMap((journey) => journey.capabilityIds || []));
const integrationCapabilityIds = new Set((spec.integrations || []).flatMap((integration) => integration.capabilityIds || []));
const permissionCapabilityIds = new Set((spec.permissions || []).flatMap((permission) => permission.capabilityIds || []));
if (manifest.schemaVersion !== '2.3') findings.push('only functional-domain schema 2.3 can be reviewed');
if (!['release-backed', 'design-led'].includes(inputMode) || planningManifest.inputMode !== inputMode) findings.push('inputMode must be release-backed or design-led and match the planning manifest');
if (schema23 && JSON.stringify(manifest.semanticArtifacts) !== JSON.stringify(SCHEMA_23_SEMANTIC_FILES)) findings.push('schema 2.3 semanticArtifacts must equal the fixed semantic artifact contract');
if (planningManifest.packageType !== 'fdd-bmad-planning' || planningArtifacts.method !== 'bmad-planning') findings.push('FDD BMAD planning artifacts are invalid');
if (!designManifest.images?.length || !planningManifest.inputDigests?.designs || !planningManifest.synthesisInputDigest) findings.push('finalized design input is absent or not bound to FDD planning');
for (const group of ['capabilities', 'entities', 'valueObjects', 'relationships', 'consistencyBoundaries', 'journeys', 'rules', 'permissions', 'integrations']) if (JSON.stringify(definitions[group] || []) !== JSON.stringify(spec[group] || [])) findings.push(`planning capability definitions differ from formal domain: ${group}`);
if (!frontendInventory.pages?.length || !frontendInventory.sourceSummary?.length) findings.push('presentation semantics have no pages or source summary');
if (inputMode === 'release-backed' && (!frontendInventory.release?.releaseDigest || observedInteractions.releaseDigest !== frontendInventory.release.releaseDigest || controlMap.releaseDigest !== frontendInventory.release.releaseDigest || assetInventory.releaseDigest !== frontendInventory.release.releaseDigest)) findings.push('frontend release semantics were not fully extracted and release-bound');
if (inputMode === 'design-led' && (!frontendInventory.design?.manifestDigest || observedInteractions.designManifestDigest !== frontendInventory.design.manifestDigest || controlMap.designManifestDigest !== frontendInventory.design.manifestDigest || assetInventory.designManifestDigest !== frontendInventory.design.manifestDigest)) findings.push('design-led presentation semantics are not bound to the finalized design manifest');
if (assetRoleMode && !Array.isArray(assetInventory.assets)) findings.push('asset role inventory is absent');
for (const asset of assetInventory.assets || []) { if (!['decorative', 'business-sample'].includes(asset.role) || !asset.digest || !asset.evidence?.sources?.length) findings.push(`${asset.id || asset.path}: static asset is unclassified`); if (asset.role === 'business-sample' && !['api-data', 'user-input', 'empty-state'].includes(asset.requiredReplacement)) findings.push(`${asset.id}: business sample has no replacement contract`); }
if (inputMode === 'release-backed' && spec.architecture?.visualAlignment?.status === 'blocked') findings.push('architecture and immutable frontend release do not identify the same product');
if (!manifest.authorAgentId) findings.push('missing authorAgentId');
if (manifest.authorAgentId === reviewerAgentId) findings.push('reviewer must be a different agent from the author');
for (const item of unresolved.items || []) if (item.severity === 'blocker' && item.status !== 'resolved') findings.push(`${item.id}: ${item.question}`);
for (const capability of spec.capabilities || []) if (capability.specificationStatus === 'blocked') findings.push(`${capability.id}: capability specification is blocked`);
for (const capability of spec.capabilities || []) if (capability.specificationStatus === 'planned' && capability.presentation?.mode === 'headless') findings.push(`${capability.id}: planned capability cannot be headless`);
for (const capability of spec.capabilities || []) findings.push(...presentationFindings(capability.id, capability.presentation, capability, { requireDeliveryPolicy: true }));
for (const capability of spec.capabilities || []) {
  const requiresServerOperation = capabilityRequiresServerOperation(capability, integrationCapabilityIds, permissionCapabilityIds);
  if (capability.specificationStatus === 'planned' && (coreCapabilityIds.has(capability.id) || capability.deliveryPolicy?.requiredForCompletion === true)) findings.push(`${capability.id}: core capability cannot remain planned`);
  if (capability.specificationStatus === 'complete' && requiresServerOperation && !capability.operations?.length) findings.push(`${capability.id}: complete server-required capability has no operation`);
  if (capability.presentation?.mode !== 'headless' && !(controlMap.mappings || []).some((item) => item.capabilityId === capability.id)) findings.push(`${capability.id}: frontend control mapping is absent`);
  if (capability.presentation?.primaryOperationId && !(capability.operations || []).some((operation) => operation.id === capability.presentation.primaryOperationId)) findings.push(`${capability.id}: primary operation is absent`);
  if (containsUnconstrainedGeneric(capability.inputSchema) || containsUnconstrainedGeneric(capability.outputSchema)) findings.push(`${capability.id}: unconstrained generic objects replace business schemas`);
  if (capability.aggregateSubmission) findings.push(...reviewAggregateSubmission(capability, spec));
  findings.push(...reviewResultPresentation(capability, frontendInventory));
  for (const operation of capability.operations || []) {
    if (!operation.method || !operation.path || !operation.request?.contentType || !operation.response?.bodySchema) findings.push(`${operation.id}: operation lacks method, path, content type, request, or response schema`);
    if (!operation.authorization || !operation.errors?.length || !operation.effects?.length) findings.push(`${operation.id}: operation lacks authorization, errors, or entity effects`);
    if (!operation.authorization || !operation.idempotency || !operation.concurrency || !operation.acceptanceExample || !operation.errors?.length) findings.push(`${operation.id}: operation semantics are incomplete`);
    const resourceTransfer = operation.resourceTransfer;
    if (operation.assetTransfer) findings.push(`${operation.id}: legacy assetTransfer must be migrated to resourceTransfer`);
    if (operation.request?.contentType === 'multipart/form-data' && (!resourceTransfer || resourceTransfer.interaction !== 'file-selection')) findings.push(`${operation.id}: transfer has no file-selection resource transfer contract`);
    if (operation.providerContract && !operation.providerContract.parameterMappings?.length) findings.push(`${operation.id}: provider contract does not cover operation inputs`);
    if (operation.providerContract && !operation.providerContract.controlledResponse) findings.push(`${operation.id}: provider contract has no Agent-authored controlled response fixture`);
    if (operation.providerContract && !operation.providerContract.providerResultLineage) findings.push(`${operation.id}: provider contract has no Agent-authored provider-to-business result lineage`);
    if (operation.providerContract) for (const mapping of operation.providerContract.parameterMappings || []) if (!(operation.integrationBindings || []).some((binding) => binding.source === mapping.source && binding.target === mapping.target && binding.required === mapping.required)) findings.push(`${operation.id}: provider mapping ${mapping.source} is not a formal integration binding`);
    if (operation.providerContract && !operation.integrationVerification) findings.push(`${operation.id}: provider contract has no integrated verification scenarios`);
    if (operation.integrationVerification?.resultReview?.required === true && !operation.integrationVerification.resultReview.assertions?.length) findings.push(`${operation.id}: independent result review has no Agent-authored acceptance assertions`);
    if (!operation.ruleIds?.length || operation.ruleIds.some((ruleId) => !capability.ruleIds?.includes(ruleId))) findings.push(`${operation.id}: operation is not bound to capability rules`);
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
const triggers = new Map();
for (const capability of spec.capabilities || []) {
  if (capability.aliasOf) continue;
  const trigger = capability.presentation?.triggerControl?.controlId; const triggerKey = `${capability.pageIds?.[0]}:${trigger}`;
  if (trigger) { if (triggers.has(triggerKey)) findings.push(`${capability.id}: primary trigger ${trigger} is already assigned to unrelated capability ${triggers.get(triggerKey)}`); else triggers.set(triggerKey, capability.id); }
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
if (existsSync(`${dir}/review-rejection.json`)) rmSync(`${dir}/review-rejection.json`);
write('manifest.json', manifest);
planningManifest.status = 'approved';
const reviewPhase = planningArtifacts.phases.find((item) => item.id === 'independent-domain-review');
if (reviewPhase) { reviewPhase.status = 'completed'; reviewPhase.outputs = { reviewerAgentId, result: 'approved' }; }
write('planning-manifest.json', planningManifest);
write('planning-artifacts.json', planningArtifacts);
write('planning-review-receipt.json', { schemaVersion: '1.0', status: 'approved', workflow: 'fdd-bmad-planning', authorAgentId: manifest.authorAgentId, reviewerAgentId, reviewedAt: manifest.approval.reviewedAt, checks: ['project understanding reviewed', 'requirements analysis reviewed', 'domain design matches capability definitions', 'formal package semantics reviewed'] });
if (existsSync(`${dir}/approval-runtime`)) rmSync(`${dir}/approval-runtime`, { recursive: true, force: true });
const trustedValidatorId = 'fdd-validator-2.3.1';
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
function capabilityRequiresServerOperation(capability, integrationCapabilityIds, permissionCapabilityIds) { return capability.presentation?.behavior === 'server-operation' || capability.writesState === true || (capability.entityEffects || []).length > 0 || (capability.operations || []).length > 0 || integrationCapabilityIds.has(capability.id) || permissionCapabilityIds.has(capability.id) || (capability.capabilityIntent?.sideEffects || []).length > 0; }
function reviewResultPresentation(capability, frontend) {
  if (capability.specificationStatus !== 'complete') return [];
  const result = []; const destination = capability.closure?.resultDestination; const product = capability.aggregateSubmission?.finalProduct || destination?.targetKind === 'region'; const contract = capability.resultPresentation || (destination?.targetKind === 'region' ? { targetRegion: destination.targetRegion, bindings: destination.bindings, states: destination.states, evidence: { status: 'observed' } } : null);
  if (product && !contract) return [`${capability.id}: product-producing complete capability has no resultPresentation`];
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
function parseArgs(values) { const result = {}; for (let i = 0; i < values.length; i++) if (values[i].startsWith('--')) { const key = values[i].slice(2); result[key] = values[i + 1] && !values[i + 1].startsWith('--') ? values[++i] : true; } return result; }
function usage() { console.error('Usage: review-package.mjs --package <dir> --reviewer-agent <stable-agent-id> [--prepare-semantic-review]'); process.exit(2); }
