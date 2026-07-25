#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { presentationFindings } from './lib/presentation.mjs';
import { treeDigest } from './lib/validator-tree.mjs';
import { collectStringValues, collectAnchorReferences, bookkeepingFindings } from './lib/evidence-index.mjs';

const dirArg = process.argv.slice(2).find((value) => !value.startsWith('--'));
if (!dirArg) { console.error('Usage: validate-package.mjs <package-dir> [--require-approved]'); process.exit(2); }
const dir = resolve(dirArg);
const requireApproved = process.argv.includes('--require-approved');
const checkLock = process.argv.includes('--check-lock');
const manifestPreview = readJSON(`${dir}/manifest.json`);
const SCHEMA_22_SEMANTIC_FILES = ['frontend-semantic-inventory.json', 'observed-interactions.json', 'control-capability-map.json', 'asset-role-inventory.json'];
const isSchema22 = manifestPreview.schemaVersion === '2.2';
const semanticFiles = isSchema22 ? SCHEMA_22_SEMANTIC_FILES : [];
const files = ['manifest.json', 'planning-manifest.json', 'planning-artifacts.json', 'capability-definitions.json', 'evidence-index.json', 'evidence-dispositions.json', ...semanticFiles, 'functional-spec.json', 'page-function-map.json', 'unresolved-items.json'];
if (existsSync(`${dir}/review-receipt.json`)) files.push('review-receipt.json');
if (existsSync(`${dir}/planning-review-receipt.json`)) files.push('planning-review-receipt.json');
const docs = Object.fromEntries(files.map((file) => [file, readJSON(`${dir}/${file}`)]));
const errors = [];
const manifest = docs['manifest.json'];
if (manifest.schemaVersion !== '2.2') errors.push('only functional-domain schema 2.2 is supported');
if (isSchema22 && JSON.stringify(manifest.semanticArtifacts) !== JSON.stringify(SCHEMA_22_SEMANTIC_FILES)) errors.push('schema 2.2 semanticArtifacts must equal the fixed semantic artifact contract');
if (isSchema22 && manifest.evidenceIndex !== 'evidence-index.json') errors.push('schema 2.2 manifest must declare the evidence-index.json bookkeeping artifact');
const spec = docs['functional-spec.json'];
const mapping = docs['page-function-map.json'];
const unresolved = docs['unresolved-items.json'];
const planningManifest = docs['planning-manifest.json'];
const planningArtifacts = docs['planning-artifacts.json'];
const definitions = docs['capability-definitions.json'];
const frontendInventory = docs['frontend-semantic-inventory.json'] || {};
const observedInteractions = docs['observed-interactions.json'] || {};
const controlMap = docs['control-capability-map.json'] || {};
const assetInventory = docs['asset-role-inventory.json'] || {};
const approvalReceipt = docs['review-receipt.json'];
const trustedValidators = new Map([
  ['fdd-validator-2.2.0', { contractVersion: 'functional-domain/2.2', entry: resolve(import.meta.dirname, '../validators/fdd-2.2.0/validate-package.mjs') }],
]);
const trustedValidator = approvalReceipt?.trustedValidatorId ? trustedValidators.get(approvalReceipt.trustedValidatorId) : null;
if (requireApproved && !approvalReceipt?.contractVersion) errors.push('approved package requires a versioned trusted review receipt');
if (requireApproved && approvalReceipt?.contractVersion && !process.argv.includes('--trusted-validator-internal') && (!trustedValidator || trustedValidator.contractVersion !== approvalReceipt.contractVersion || !existsSync(trustedValidator.entry) || approvalReceipt.validatorDigest !== treeDigest(resolve(trustedValidator.entry, '..')))) errors.push('approval receipt does not reference the immutable trusted repository validator for its contract version');
if (requireApproved && approvalReceipt?.contractVersion && !process.argv.includes('--trusted-validator-internal') && !errors.length) { const replay = spawnSync(process.execPath, [trustedValidator.entry, dir, '--require-approved', '--trusted-validator-internal', ...(checkLock ? ['--check-lock'] : [])], { encoding: 'utf8' }); process.stdout.write(replay.stdout || ''); process.stderr.write(replay.stderr || ''); process.exit(replay.status ?? 1); }
const requiredPlanningArtifacts = ['evidence-index.json', 'evidence-dispositions.json', 'planning-artifacts.json', 'capability-definitions.json', ...semanticFiles];
if (planningManifest.packageType !== 'fdd-bmad-planning' || JSON.stringify(planningManifest.artifacts) !== JSON.stringify(requiredPlanningArtifacts)) errors.push('FDD planning manifest is invalid');
if (planningArtifacts.method !== 'bmad-planning' || !['project-understanding', 'requirements-analysis', 'domain-design', 'independent-domain-review'].every((id) => planningArtifacts.phases?.some((item) => item.id === id))) errors.push('FDD BMAD planning phases are incomplete');
for (const group of ['capabilities', 'entities', 'valueObjects', 'relationships', 'consistencyBoundaries', 'journeys', 'rules', 'permissions', 'integrations']) if (JSON.stringify(definitions[group] || []) !== JSON.stringify(spec[group] || [])) errors.push(`capability definitions differ from functional spec: ${group}`);
if (!frontendInventory.release?.releaseDigest || !frontendInventory.pages?.length || !frontendInventory.sourceSummary?.length) errors.push('frontend semantic inventory did not parse the immutable release');
if (!manifest.visualReleaseDigest || !spec.visualSource?.releaseDigest || manifest.visualReleaseDigest !== spec.visualSource.releaseDigest || manifest.visualReleaseDigest !== frontendInventory.release?.releaseDigest) errors.push('functional package visual release digest is missing or inconsistent');
if (observedInteractions.releaseDigest !== frontendInventory.release?.releaseDigest || controlMap.releaseDigest !== frontendInventory.release?.releaseDigest) errors.push('frontend semantic artifact release digests differ');
if (!Array.isArray(observedInteractions.interactions) || !Array.isArray(controlMap.mappings)) errors.push('frontend semantic artifacts are incomplete');
if (assetInventory.releaseDigest !== frontendInventory.release?.releaseDigest || !Array.isArray(assetInventory.assets)) errors.push('asset role inventory is absent or not release-bound');
for (const asset of assetInventory.assets || []) { if (!asset.id || !asset.path || !asset.digest || !['decorative', 'business-sample'].includes(asset.role) || !asset.evidence?.sources?.length) errors.push(`asset role entry is unclassified or incomplete: ${asset.id || asset.path || '<unknown>'}`); if (asset.role === 'business-sample' && !['api-data', 'user-input', 'empty-state'].includes(asset.requiredReplacement)) errors.push(`business sample asset has no valid replacement contract: ${asset.id}`); }
if (spec.planningContext) errors.push('external planningContext is outside the FDD-owned planning workflow');
if (manifest.schemaVersion !== '2.2' || manifest.packageType !== 'functional-domain') errors.push('manifest contract is invalid');
if (requireApproved && manifest.status !== 'approved') errors.push('package is not approved');
if (!manifest.authorAgentId) errors.push('package has no author agent identity');
if (requireApproved) {
  const receipt = docs['review-receipt.json'];
  if (!receipt) errors.push('approved package has no independent review receipt');
  else {
    if (receipt.status !== 'approved') errors.push('review receipt is not approved');
    if (!receipt.reviewerAgentId) errors.push('review receipt has no reviewer agent identity');
    if (receipt.reviewerAgentId === manifest.authorAgentId) errors.push('author and reviewer agents must be different');
    if (receipt.authorAgentId !== manifest.authorAgentId) errors.push('review receipt author identity mismatch');
  }
  const planningReceipt = docs['planning-review-receipt.json'];
  if (!planningReceipt || planningReceipt.status !== 'approved' || planningReceipt.reviewerAgentId !== receipt?.reviewerAgentId || planningReceipt.authorAgentId !== manifest.authorAgentId) errors.push('FDD planning has no matching independent review receipt');
  if (planningManifest.status !== 'approved') errors.push('FDD planning is not approved');
}
if (manifest.schemaVersion !== spec.schemaVersion || manifest.schemaVersion !== mapping.schemaVersion || manifest.schemaVersion !== unresolved.schemaVersion) errors.push('package schema versions do not match');
const ids = new Set();
for (const group of ['domains', 'entities', 'valueObjects', 'relationships', 'consistencyBoundaries', 'capabilities', 'journeys', 'rules', 'permissions', 'integrations']) {
  if (!Array.isArray(spec[group])) errors.push(`${group} must be an array`);
  for (const item of spec[group] || []) {
    if (!item.id) errors.push(`${group} contains an item without id`);
    else if (ids.has(item.id)) errors.push(`duplicate id: ${item.id}`);
    else ids.add(item.id);
  }
}
const capabilities = new Map((spec.capabilities || []).map((item) => [item.id, item]));
const operations = new Map((spec.capabilities || []).flatMap((item) => (item.operations || []).map((operation) => [operation.id, { ...operation, capabilityId: item.id }])));
const entities = new Set((spec.entities || []).map((item) => item.id));
const domains = new Set((spec.domains || []).map((item) => item.id));
const pages = new Set((mapping.pages || []).map((item) => item.pageId));
const rules = new Set((spec.rules || []).map((item) => item.id));
const consistencyBoundaryIds = new Set((spec.consistencyBoundaries || []).map((item) => item.id));
const actors = new Set((spec.capabilities || []).map((item) => item.actor).filter(Boolean));
const cardinalities = new Set(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']);
const ownerships = new Set(['aggregate', 'reference', 'shared']);
const deleteRules = new Set(['cascade', 'restrict', 'set-null', 'detach']);
for (const domain of spec.domains || []) {
  for (const pageId of domain.pageIds || []) if (!pages.has(pageId)) errors.push(`domain ${domain.id} references unknown page ${pageId}`);
  for (const entityId of domain.entityIds || []) if (!entities.has(entityId)) errors.push(`domain ${domain.id} references unknown entity ${entityId}`);
}
for (const entity of spec.entities || []) {
  if (entity.domainId && !domains.has(entity.domainId)) errors.push(`entity ${entity.id} references unknown domain ${entity.domainId}`);
  if (!entity.identity?.fields?.length) errors.push(`entity ${entity.id} has no identity fields`);
  if (typeof entity.aggregateRoot !== 'boolean') errors.push(`entity ${entity.id} has no aggregateRoot declaration`);
  if (!Array.isArray(entity.lifecycle) || !entity.lifecycle.length) errors.push(`entity ${entity.id} has no lifecycle`);
  if (!entity.constraints || !Array.isArray(entity.constraints.required) || !Array.isArray(entity.constraints.unique) || !entity.constraints.status) errors.push(`entity ${entity.id} has incomplete constraints`);
  if (!entity.accessScope?.ownerActor || !['owner', 'tenant', 'shared', 'system'].includes(entity.accessScope.scope) || (entity.accessScope.scope === 'owner' && !entity.accessScope.ownershipField)) errors.push(`entity ${entity.id} has incomplete access scope`);
  if (!entity.aggregateRoot) {
    const root = (spec.entities || []).find((item) => item.id === entity.aggregateRootEntityId);
    if (!root?.aggregateRoot) errors.push(`entity ${entity.id} references an invalid aggregate root`);
  }
}
for (const relation of spec.relationships || []) {
  if (!entities.has(relation.fromEntityId)) errors.push(`relationship ${relation.id} references unknown from entity ${relation.fromEntityId}`);
  if (!entities.has(relation.toEntityId)) errors.push(`relationship ${relation.id} references unknown to entity ${relation.toEntityId}`);
  if (!cardinalities.has(relation.cardinality)) errors.push(`relationship ${relation.id} has invalid cardinality`);
  if (typeof relation.required !== 'boolean') errors.push(`relationship ${relation.id} has no required declaration`);
  if (!ownerships.has(relation.ownership)) errors.push(`relationship ${relation.id} has invalid ownership`);
  if (!deleteRules.has(relation.onDelete)) errors.push(`relationship ${relation.id} has invalid onDelete rule`);
  if (!relation.associationKey?.fromFields?.length || !relation.associationKey?.toFields?.length) errors.push(`relationship ${relation.id} has no association key`);
  else if (relation.associationKey.fromFields.length !== relation.associationKey.toFields.length) errors.push(`relationship ${relation.id} has mismatched association key fields`);
  if (!relation.invariants?.length) errors.push(`relationship ${relation.id} has no invariants`);
}
for (const boundary of spec.consistencyBoundaries || []) {
  if (!entities.has(boundary.aggregateRootEntityId)) errors.push(`consistency boundary ${boundary.id} references unknown aggregate root`);
  for (const entityId of boundary.entityIds || []) if (!entities.has(entityId)) errors.push(`consistency boundary ${boundary.id} references unknown entity ${entityId}`);
  if (!boundary.entityIds?.includes(boundary.aggregateRootEntityId) || !['atomic', 'eventual'].includes(boundary.strategy)) errors.push(`consistency boundary ${boundary.id} is incomplete`);
}
for (const cap of capabilities.values()) {
  if (!['complete', 'planned', 'blocked', 'draft-pending-authoring'].includes(cap.specificationStatus)) errors.push(`capability ${cap.id} has invalid specification status`);
  if (!cap.name || !cap.purpose || !cap.pageIds?.length) errors.push(`capability ${cap.id} lacks identity or pages`);
  if (!cap.acceptanceCriteria?.length) errors.push(`capability ${cap.id} has no acceptance criteria`);
  if (cap.specificationStatus === 'complete' && (!validObjectSchema(cap.inputSchema) || !validObjectSchema(cap.outputSchema) || !cap.acceptanceExamples?.length)) errors.push(`capability ${cap.id} lacks structured input, output, or acceptance examples`);
  if (cap.specificationStatus === 'planned' && ((cap.operations || []).length || (cap.entityEffects || []).length || cap.writesState || (cap.inputs || []).length || cap.inputSchema || (cap.outcomes || []).length || cap.outputSchema || (cap.acceptanceExamples || []).length || cap.deliveryPolicy?.requiredForCompletion !== false || cap.deliveryPolicy?.uiBehavior !== 'show-planned-state' || !cap.planningReason)) errors.push(`planned capability ${cap.id} exposes implementation semantics or lacks its planned delivery contract`);
  if (cap.specificationStatus === 'planned' && cap.presentation?.mode === 'headless') errors.push(`planned capability ${cap.id} cannot be headless`);
  if (cap.specificationStatus === 'complete' && cap.deliveryPolicy?.requiredForCompletion === false) errors.push(`complete capability ${cap.id} is explicitly excluded from completion`);
  if (containsUnconstrainedGeneric(cap.inputSchema) || containsUnconstrainedGeneric(cap.outputSchema)) errors.push(`capability ${cap.id} uses an unconstrained generic input or result object`);
  const mapped = (controlMap.mappings || []).find((item) => item.capabilityId === cap.id);
  if (cap.presentation?.mode !== 'headless' && (!mapped || (!mapped.controlId && mapped.mappingType !== 'designed-control'))) errors.push(`capability ${cap.id} has no frontend control mapping`);
  if (cap.presentation?.primaryOperationId && !(cap.operations || []).some((operation) => operation.id === cap.presentation.primaryOperationId)) errors.push(`capability ${cap.id} primary operation does not exist`);
  if (cap.writesState && cap.specificationStatus !== 'blocked' && (!cap.entityEffects?.length || !cap.failures?.length)) errors.push(`write capability ${cap.id} lacks effects or failures`);
  for (const effect of cap.entityEffects || []) if (!entities.has(effect.entityId)) errors.push(`${cap.id} references unknown entity ${effect.entityId}`);
  for (const pageId of cap.pageIds || []) if (!pages.has(pageId)) errors.push(`${cap.id} references unknown page ${pageId}`);
  for (const ruleId of cap.ruleIds || []) if (!rules.has(ruleId)) errors.push(`${cap.id} references unknown rule ${ruleId}`);
  if (cap.operations?.length && !cap.ruleIds?.length) errors.push(`capability ${cap.id} has operations but no bound rules`);
  errors.push(...presentationFindings(cap.id, cap.presentation, cap, { requireDeliveryPolicy: true }));
  for (const operation of cap.operations || []) {
    if (!operation.request?.contentType || !validObjectSchema(operation.response?.bodySchema)) errors.push(`operation ${operation.id} lacks content type or structured response schema`);
    for (const location of ['path', 'query', 'header']) if (operation.request?.[location]?.length && !validObjectSchema(operation.request?.[`${location}Schema`])) errors.push(`operation ${operation.id} lacks ${location} schema`);
    if (operation.request?.body?.length && !validObjectSchema(operation.request?.bodySchema)) errors.push(`operation ${operation.id} lacks body schema`);
    if (!operation.authorization || !operation.errors?.length || !operation.idempotency || !operation.concurrency || !operation.acceptanceExample) errors.push(`operation ${operation.id} lacks authorization, errors, idempotency, concurrency, or acceptance semantics`);
    if (!operation.ruleIds?.length || operation.ruleIds.some((ruleId) => !cap.ruleIds.includes(ruleId))) errors.push(`operation ${operation.id} is not bound to its capability rules`);
    const resourceTransfer = operation.resourceTransfer;
    if (operation.assetTransfer) errors.push(`operation ${operation.id} uses unsupported assetTransfer instead of resourceTransfer`);
    if (operation.request?.contentType === 'multipart/form-data' && (!resourceTransfer?.fileField || !resourceTransfer?.responseIdPath || resourceTransfer?.interaction !== 'file-selection')) errors.push(`transfer operation ${operation.id} lacks a structured file-selection resource transfer contract`);
    if (operation.providerContract && (!operation.providerContract.requiredCapability || !operation.providerContract.parameterMappings?.length || !operation.providerContract.outputConstraints)) errors.push(`operation ${operation.id} has an incomplete provider contract`);
    if (operation.providerContract) {
      const bindings = operation.integrationBindings || [];
      for (const mapping of operation.providerContract.parameterMappings || []) if (!bindings.some((binding) => binding.source === mapping.source && binding.target === mapping.target && binding.required === mapping.required)) errors.push(`operation ${operation.id} provider parameter mapping is not an integration binding: ${mapping.source}`);
    }
    if (operation.providerContract && !operation.integrationVerification) errors.push(`provider operation ${operation.id} has no integrated verification contract`);
    if (operation.providerContract?.outputMode !== undefined) {
      const provider = operation.providerContract;
      if (!['independent-items', 'composite-output'].includes(provider.outputMode)) errors.push(`operation ${operation.id} providerContract has an unsupported outputMode: ${provider.outputMode}`);
      else if (provider.outputMode === 'independent-items') {
        if (provider.oneProviderResultPerItem !== true) errors.push(`operation ${operation.id} independent-items provider must set oneProviderResultPerItem to true`);
        if (typeof provider.batchSupportAssumed !== 'boolean') errors.push(`operation ${operation.id} independent-items provider must declare batchSupportAssumed (loop per item when batch support is unconfirmed)`);
        if (!provider.perCallConstraints || typeof provider.perCallConstraints !== 'object' || !Object.keys(provider.perCallConstraints).length) errors.push(`operation ${operation.id} independent-items provider must declare per-call single-item output constraints`);
      }
    }
    const effectEntities = new Set();
    for (const effect of operation.effects || []) {
      if (!entities.has(effect.entityId)) errors.push(`operation ${operation.id} references unknown entity ${effect.entityId}`);
      effectEntities.add(effect.entityId);
    }
    if ((effectEntities.size > 1 || (operation.effects || []).some((effect) => effect.effect === 'associate')) && (!operation.transaction?.boundary || operation.transaction.atomic !== true) && !operation.consistency?.strategy) errors.push(`operation ${operation.id} writes related entities without transaction or consistency strategy`);
    if (operation.transaction?.boundary && !entities.has(operation.transaction.boundary) && !consistencyBoundaryIds.has(operation.transaction.boundary)) errors.push(`operation ${operation.id} references unknown transaction boundary ${operation.transaction.boundary}`);
    if (operation.integrationVerification) {
      const verification = operation.integrationVerification;
      if (!Array.isArray(verification.requiredScenarios) || verification.requiredScenarios.some((item) => typeof item !== 'string' || !item)) errors.push(`operation ${operation.id} has invalid integration verification scenarios`);
      if (!Array.isArray(verification.artifactAssertions) || verification.artifactAssertions.some((item) => !item?.path || !(item.schema || item.type))) errors.push(`operation ${operation.id} has invalid integration artifact assertions`);
      if (verification.endpointPolicy && typeof verification.endpointPolicy.nonLocal !== 'boolean') errors.push(`operation ${operation.id} has invalid integration endpoint policy`);
    }
  }
}
for (const operation of operations.values()) for (const dependency of operation.dataDependencies || []) {
  const source = operations.get(dependency.sourceOperationId);
  if (!source) errors.push(`operation ${operation.id} data dependency references unknown source operation ${dependency.sourceOperationId}`);
  if (!dependency.sourceField || !dependency.targetField || dependency.targetOperationId !== operation.id) errors.push(`operation ${operation.id} has an incomplete data dependency`);
  if (!dependency.requiredOwnership || !dependency.requiredLifecycleStatus || !dependency.consistencyRequirement || dependency.runtimeValueRequired !== true) errors.push(`operation ${operation.id} has an incomplete runtime data lineage contract`);
  if (source && !schemaHasPath(source.response?.bodySchema, dependency.sourceField.replace(/^response\.?/, ''))) errors.push(`operation ${operation.id} data dependency source path does not exist: ${dependency.sourceField}`);
  const targetSchema = operation.request?.bodySchema || operation.request?.querySchema;
  if (!schemaHasPath(targetSchema, dependency.targetField.replace(/^request\.?/, ''))) errors.push(`operation ${operation.id} data dependency target path does not exist: ${dependency.targetField}`);
}
for (const journey of spec.journeys || []) {
  for (const capabilityId of journey.capabilityIds || []) { if (!capabilities.has(capabilityId)) errors.push(`journey ${journey.id} references unknown capability ${capabilityId}`); else if (capabilities.get(capabilityId).specificationStatus !== 'complete') errors.push(`implementation journey ${journey.id} includes non-complete capability ${capabilityId}`); }
  for (const operationId of journey.operationIds || []) if (!operations.has(operationId)) errors.push(`journey ${journey.id} references unknown operation ${operationId}`);
  if (!journey.acceptanceCriteria?.length) errors.push(`journey ${journey.id} has no acceptance criteria`);
}
for (const rule of spec.rules || []) for (const capabilityId of rule.appliesTo || []) if (!capabilities.has(capabilityId)) errors.push(`rule ${rule.id} references unknown capability ${capabilityId}`);
for (const permission of spec.permissions || []) {
  if (!actors.has(permission.actor)) errors.push(`permission ${permission.id} references unknown actor ${permission.actor}`);
  const resourceIds = permission.resourceIds || (entities.has(permission.resource) ? [permission.resource] : []);
  if (!resourceIds.length) errors.push(`permission ${permission.id} has no entity resource binding`);
  for (const entityId of resourceIds) if (!entities.has(entityId)) errors.push(`permission ${permission.id} references unknown entity resource ${entityId}`);
}
for (const entity of spec.entities || []) if (entity.accessScope?.scope === 'owner' && !(spec.permissions || []).some((permission) => permission.actor === entity.accessScope.ownerActor && (permission.resourceIds || []).includes(entity.id))) errors.push(`entity ${entity.id} has no ownership permission binding`);
for (const integration of spec.integrations || []) {
  if (!integration.capabilityIds?.length) errors.push(`integration ${integration.id} has no capability binding`);
  for (const capabilityId of integration.capabilityIds || []) if (!capabilities.has(capabilityId)) errors.push(`integration ${integration.id} references unknown capability ${capabilityId}`);
}
for (const page of mapping.pages || []) {
  if (!page.navigationOnly && !page.capabilityIds?.length) errors.push(`page ${page.pageId} has no capability`);
  for (const id of page.capabilityIds || []) if (!capabilities.has(id)) errors.push(`page ${page.pageId} references unknown capability ${id}`);
}
const blockers = (unresolved.items || []).filter((item) => item.severity === 'blocker' && item.status !== 'resolved');
if (requireApproved && blockers.length) errors.push(`package has ${blockers.length} open blocker(s)`);
const blockedCapabilities = (spec.capabilities || []).filter((item) => item.specificationStatus === 'blocked');
if (requireApproved && blockedCapabilities.length) errors.push(`package has ${blockedCapabilities.length} blocked capability specification(s)`);
if (requireApproved) {
  const inferred = collectEvidence(spec).filter((item) => item.status === 'inferred');
  if (inferred.length) errors.push(`package has ${inferred.length} inferred fact(s); confirm or document them before approval`);
}
const semanticFingerprints = new Map(); const aggregateTriggers = new Map();
for (const cap of capabilities.values()) {
  if (cap.aliasOf) continue;
  const fingerprint = JSON.stringify({ pageScope: cap.pageIds, input: cap.inputSchema, output: cap.outputSchema, processing: cap.capabilityIntent?.processingSemantics ?? cap.closure?.systemBehavior?.summary, effects: cap.entityEffects, failures: cap.failures });
  if (semanticFingerprints.has(fingerprint)) errors.push(`capabilities ${semanticFingerprints.get(fingerprint)} and ${cap.id} have indistinguishable business semantics`);
  else semanticFingerprints.set(fingerprint, cap.id);
  if (cap.aggregateSubmission?.status === 'complete') { const trigger = `${cap.pageIds?.[0]}:${cap.aggregateSubmission.triggerControlId}`; if (aggregateTriggers.has(trigger)) errors.push(`aggregate submit trigger ${trigger} is assigned to multiple capabilities: ${aggregateTriggers.get(trigger)}, ${cap.id}`); else aggregateTriggers.set(trigger, cap.id); }
}

if (isSchema22) {
  // Schema 2.2 authoring integrity. Validate proves structure and consistency of the agent's
  // authored closure; it never judges business meaning (independent review owns that). Every
  // semantic field is evidence-anchored, acceptance examples carry concrete literal values, and
  // every indexed evidence item is referenced or explicitly dispositioned (the bookkeeping gate).
  const evidenceIndex = docs['evidence-index.json'] || {};
  const dispositions = docs['evidence-dispositions.json'] || null;
  const anchorIds = new Set((evidenceIndex.evidence || []).map((item) => item.id));
  if (!Array.isArray(evidenceIndex.evidence) || !evidenceIndex.evidence.length) errors.push('evidence-index.json is missing or empty');
  const inputFieldTypes = new Map();
  for (const cap of capabilities.values()) for (const [field, schema] of Object.entries(cap.inputSchema?.properties || {})) if (!inputFieldTypes.has(field)) inputFieldTypes.set(field, schema);
  for (const cap of capabilities.values()) {
    if (cap.specificationStatus === 'draft-pending-authoring') { errors.push(`capability ${cap.id} is an un-authored skeleton (draft-pending-authoring); the author agent must close its semantics before this package can validate`); continue; }
    if (cap.specificationStatus === 'blocked') continue;
    const closure = cap.closure || {};
    for (const question of ['userInput', 'systemBehavior', 'output', 'resultDestination', 'failures', 'downstreamUse']) {
      const node = closure[question];
      if (!node) { errors.push(`capability ${cap.id} closure does not answer "${question}" (用户提供什么/系统做什么/得到什么/结果写到哪里/失败怎么办/后续如何使用)`); continue; }
      if (question === 'resultDestination') { if (!['region', 'field', 'headless'].includes(node.targetKind)) errors.push(`capability ${cap.id} closure resultDestination has an invalid targetKind`); }
      else if (!String(node.summary || '').trim()) errors.push(`capability ${cap.id} closure "${question}" has no authored summary`);
      if (!Array.isArray(node.evidenceAnchors) || !node.evidenceAnchors.length) errors.push(`capability ${cap.id} closure "${question}" carries no evidenceAnchors`);
      for (const anchor of node.evidenceAnchors || []) if (!anchorIds.has(anchor)) errors.push(`capability ${cap.id} closure "${question}" references an unknown evidence anchor: ${anchor}`);
    }
    for (const anchor of cap.evidenceAnchors || []) if (!anchorIds.has(anchor)) errors.push(`capability ${cap.id} references an unknown evidence anchor: ${anchor}`);
    if (cap.specificationStatus === 'planned') {
      const decision = cap.missingDecision;
      if (!decision || !String(decision.missingBusinessDecision || '').trim() || !String(decision.question || '').trim() || decision.sourceEvidenceUnanswered !== true || !Array.isArray(decision.evidenceAnchors) || !decision.evidenceAnchors.length) errors.push(`planned capability ${cap.id} lacks a missing-decision record citing which business decision the source evidence leaves unanswered`);
      for (const anchor of decision?.evidenceAnchors || []) if (!anchorIds.has(anchor)) errors.push(`planned capability ${cap.id} missing-decision references an unknown evidence anchor: ${anchor}`);
    }
    if (cap.specificationStatus === 'complete') {
      errors.push(...concreteAcceptanceFindings(cap));
      errors.push(...resultDestinationFindings(cap, frontendInventory, inputFieldTypes));
      const mapped = (controlMap.mappings || []).find((item) => item.capabilityId === cap.id);
      if (cap.presentation?.mode !== 'headless' && !mapped?.controlId) errors.push(`complete non-headless capability ${cap.id} has no observed release control binding (control provenance requires a release controlId)`);
    }
  }
  const referenced = collectAnchorReferences(spec);
  const gaps = bookkeepingFindings(evidenceIndex, referenced, dispositions);
  if (gaps.length) errors.push(`evidence bookkeeping is incomplete: ${gaps.length} indexed evidence item(s) are neither referenced nor dispositioned`, ...gaps.slice(0, 60).map((gap) => `  - ${gap.id} [${gap.kind}]: ${gap.reason}`));
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}
const digestFiles = [...files, ...(existsSync(`${dir}/fixtures`) ? walkFiles(`${dir}/fixtures`).map((file) => file.slice(dir.length + 1)) : [])];
const digests = Object.fromEntries(digestFiles.map((file) => [file, sha(readFileSync(`${dir}/${file}`))]));
if (checkLock) {
  if (!existsSync(`${dir}/package-lock.json`)) { console.error('- package-lock.json is missing'); process.exit(1); }
  const lock = readJSON(`${dir}/package-lock.json`);
  const expectedFiles = Object.keys(digests).sort();
  const lockedFiles = Object.keys(lock.digests || {}).sort();
  if (JSON.stringify(expectedFiles) !== JSON.stringify(lockedFiles)) { console.error('- package lock file set mismatch'); process.exit(1); }
  const mismatches = Object.entries(digests).filter(([file, digest]) => lock.digests[file] !== digest).map(([file]) => file);
  if (mismatches.length) { console.error(mismatches.map((file) => `- package lock mismatch: ${file}`).join('\n')); process.exit(1); }
  console.log(`Functional-domain package lock valid (${expectedFiles.length} files)`);
  process.exit(0);
}
writeFileSync(`${dir}/package-lock.json`, `${JSON.stringify({ schemaVersion: '1.0', algorithm: 'sha256', digests }, null, 2)}\n`);
console.log(`Functional-domain package valid (${capabilities.size} capabilities, ${blockers.length} open blockers)`);

function collectEvidence(value, found = []) {
  if (Array.isArray(value)) for (const item of value) collectEvidence(item, found);
  else if (value && typeof value === 'object') {
    if (value.evidence?.status) found.push(value.evidence);
    for (const child of Object.values(value)) collectEvidence(child, found);
  }
  return found;
}
function validObjectSchema(schema) { return schema?.type === 'object' && schema.properties && typeof schema.properties === 'object' && Array.isArray(schema.required); }
function containsUnconstrainedGeneric(schema) { if (!schema || typeof schema !== 'object') return false; if (schema.type === 'object' && schema.additionalProperties === true && !Object.keys(schema.properties || {}).length) return true; return Object.values(schema).some((value) => Array.isArray(value) ? value.some(containsUnconstrainedGeneric) : containsUnconstrainedGeneric(value)); }
function requiresSpecializedBusinessResult(capability) { return ['create', 'update', 'retry', 'external-operation'].includes(capability.synthesisAnalysis?.candidatePattern); }
function resultPresentationFindings(capability, frontend) {
  const findings = []; const producesResult = capability.aggregateSubmission?.finalProduct || (capability.specificationStatus === 'complete' && requiresSpecializedBusinessResult(capability)); const contract = capability.resultPresentation;
  if (producesResult && capability.specificationStatus === 'complete' && !contract) return [`capability ${capability.id} produces a business result without resultPresentation`];
  if (!contract) return findings;
  if (capability.specificationStatus !== 'complete') findings.push(`non-complete capability ${capability.id} must not expose resultPresentation`);
  const page = (frontend.pages || []).find((item) => item.pageId === capability.pageIds?.[0]); const regions = new Set([...(page?.regions || []).map((item) => item.regionId), ...(page?.resultSurfaces || []).map((item) => item.surfaceId)]);
  if (!regions.has(contract.targetRegion)) findings.push(`capability ${capability.id} resultPresentation targets an unrecognized frontend region: ${contract.targetRegion}`);
  if (!['confirmed', 'documented', 'observed'].includes(contract.evidence?.status) || !contract.evidence?.sources?.length) findings.push(`capability ${capability.id} resultPresentation has no reliable source evidence`);
  for (const state of ['processing', 'success', 'failure']) if (!contract.states?.[state]?.regionStatus || !contract.states?.[state]?.elementSemantic) findings.push(`capability ${capability.id} resultPresentation lacks semantic ${state} state`);
  if (contract.states?.success?.requiresBoundElements !== true || contract.states?.success?.elementSemantic === 'status-text') findings.push(`capability ${capability.id} resultPresentation success is only a status message`);
  if (!['immediate', 'poll-until-terminal'].includes(contract.runtimeFlow?.mode) || (contract.runtimeFlow?.mode === 'poll-until-terminal' && (!contract.runtimeFlow.terminalOperationId || !contract.runtimeFlow.terminalStatuses?.length))) findings.push(`capability ${capability.id} resultPresentation has an incomplete runtime flow`);
  const operation = capability.operations?.find((item) => item.id === capability.presentation?.primaryOperationId) || capability.operations?.[0];
  if (!operation || !contract.bindings?.length) findings.push(`capability ${capability.id} resultPresentation has no operation-bound result elements`);
  for (const binding of contract.bindings || []) { if (!binding.id || !binding.element?.semantic || !binding.responsePath?.startsWith('response.')) findings.push(`capability ${capability.id} has an incomplete result binding`); else if (!schemaHasPath(operation?.response?.bodySchema, binding.responsePath.replace(/^response\./, ''))) findings.push(`capability ${capability.id} result binding references an unknown response path: ${binding.responsePath}`); if (!['response-cardinality', 'request-field'].includes(binding.count?.mode) || (binding.count?.mode === 'request-field' && (!binding.count.requestPath || binding.count.fixedValueForbidden !== true))) findings.push(`capability ${capability.id} result binding has no dynamic count contract`); }
  return findings;
}
function hasSpecializedBusinessResult(capability) { const generic = new Set(['id', 'operationId', 'status', 'output', 'result']); const fields = Object.entries(capability.outputSchema?.properties || {}).filter(([field]) => !generic.has(field)); const quality = capability.capabilityIntent?.qualityCriteria || []; const downstream = capability.capabilityIntent?.downstreamUsage || []; const failures = capability.capabilityIntent?.failures || []; const assertions = (capability.acceptanceExamples || []).flatMap((example) => example.then || []).map((item) => item.assertion); return fields.some(([, schema]) => !isNameWrappedGenericResult(schema)) && quality.length >= 2 && downstream.length > 0 && failures.length >= 3 && assertions.some((item) => String(item).startsWith('response.')) && quality.every((criterion) => assertions.includes(`quality.${String(criterion).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}`)); }
function isNameWrappedGenericResult(schema) { if (schema?.type !== 'object') return false; const keys = Object.keys(schema.properties || {}); return keys.length > 0 && keys.every((key) => ['kind', 'references', 'quality'].includes(key)) && keys.includes('kind') && keys.includes('references'); }
function aggregateSubmissionFindings(capability, entityIds, spec) { const findings = []; const aggregate = capability.aggregateSubmission; if (aggregate.status === 'planned') { if (capability.specificationStatus !== 'planned' || capability.operations?.length || capability.inputSchema || capability.acceptanceExamples?.length) findings.push(`aggregate capability ${capability.id} with insufficient evidence must remain planned without operation, schema, or acceptance fixture`); return findings; } const operations = capability.operations || []; if (operations.length !== 1) findings.push(`aggregate capability ${capability.id} must have exactly one final submit operation`); const operation = operations[0]; const declaredFields = aggregate.sections.flatMap((section) => section.fields.map((field) => field.id)); const boundFields = aggregate.configurationAggregate?.sections?.flatMap((section) => section.fieldIds || []) || []; const schemaFields = Object.keys(operation?.request?.bodySchema?.properties || {}); for (const field of declaredFields) if (!schemaFields.includes(field) || !boundFields.includes(field)) findings.push(`aggregate capability ${capability.id} schema or configuration aggregate omits section field ${field}`); const quantityField = aggregate.finalProduct?.quantity?.sourceField; if (quantityField && !schemaFields.includes(quantityField)) findings.push(`aggregate capability ${capability.id} quantity source field is absent from the aggregate request`); if (!aggregate.triggerControlId || operation?.aggregateSubmission?.triggerControlId !== aggregate.triggerControlId) findings.push(`aggregate capability ${capability.id} has no single evidence-bound primary submit action`); if (!aggregate.finalProduct?.type || !aggregate.finalProduct?.quantity || !aggregate.finalProduct?.lifecycle?.length || !aggregate.finalProduct?.downstreamUsage?.length) findings.push(`aggregate capability ${capability.id} has incomplete final product semantics`); if (!entityIds.has(aggregate.configurationAggregate?.entityId)) findings.push(`aggregate capability ${capability.id} has no configuration aggregate root entity`); if (!operation?.effects?.some((effect) => effect.entityId === aggregate.configurationAggregate?.entityId)) findings.push(`aggregate capability ${capability.id} final submit does not persist its configuration aggregate`); for (const itemId of aggregate.sectionItemIds || []) { const leaf = (spec.architecture?.leafClassifications || []).find((item) => item.leafId === itemId && item.pageId === capability.pageIds?.[0]); if (leaf?.classification !== 'input-field' || (spec.capabilities || []).some((item) => item.synthesisAnalysis?.sourceArchitectureLeafId === itemId)) findings.push(`aggregate section ${itemId} was emitted as a capability instead of an input partition`); } return findings; }
function schemaHasPath(schema, path) { let current = schema; for (const part of String(path).replace(/\[\]$/g, '').split('.').filter(Boolean)) { current = current?.properties?.[part] || (current?.type === 'array' ? current.items?.properties?.[part] : null); if (!current) return false; } return true; }
function sha(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function walkFiles(path) { return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walkFiles(`${path}/${entry.name}`) : [`${path}/${entry.name}`]).sort(); }

// Schema 2.2 authoring-integrity helpers (structure only; never business meaning).
function isSymbolicValue(value) { return typeof value === 'string' && (/^runtime-value/i.test(value) || /^<.+>$/.test(value)); }
function concreteAcceptanceFindings(cap) {
  const findings = []; const examples = cap.acceptanceExamples || []; const required = cap.inputSchema?.required || [];
  for (const example of examples) if ([...collectStringValues(example)].some(isSymbolicValue)) { findings.push(`capability ${cap.id} acceptance example contains a symbolic runtime-value placeholder instead of a concrete literal value`); break; }
  const concrete = examples.some((example) => {
    const given = example.given || {}; const givenOk = required.every((field) => given[field] !== undefined && !isSymbolicValue(given[field]));
    const thenOk = (example.then || []).some((entry) => entry && typeof entry === 'object' && String(entry.path || '').startsWith('response.') && entry.equals !== undefined && !isSymbolicValue(entry.equals));
    return givenOk && thenOk;
  });
  if (!concrete) findings.push(`capability ${cap.id} has no acceptance example with concrete literal given inputs and a concrete expected response value`);
  return findings;
}
function resultDestinationFindings(cap, frontend, inputFieldTypes) {
  const findings = []; const destination = cap.closure?.resultDestination; if (!destination) return findings;
  if (destination.targetKind === 'headless') { if (cap.presentation?.mode !== 'headless') findings.push(`capability ${cap.id} declares a headless result destination but is not a headless capability`); return findings; }
  for (const state of ['processing', 'success', 'failure']) if (!destination.states?.[state]?.elementSemantic) findings.push(`capability ${cap.id} resultDestination lacks a semantic ${state} state`);
  if (destination.targetKind === 'region') {
    const page = (frontend.pages || []).find((item) => item.pageId === cap.pageIds?.[0]);
    const regions = new Set([...(page?.regions || []).map((item) => item.regionId), ...(page?.resultSurfaces || []).map((item) => item.surfaceId)]);
    if (!regions.has(destination.targetRegion)) findings.push(`capability ${cap.id} resultDestination targets an unrecognized release region: ${destination.targetRegion}`);
    if (!(destination.bindings || []).length) findings.push(`capability ${cap.id} region resultDestination has no response-bound result elements`);
    for (const binding of destination.bindings || []) if (!binding.responsePath?.startsWith('response.') || !schemaHasPath(cap.outputSchema, binding.responsePath.replace(/^response\./, ''))) findings.push(`capability ${cap.id} result binding references an unknown response path: ${binding.responsePath}`);
    // Cross-enforcement (Issue-A family: a conditional gate must not be evadable by omitting the whole
    // contract). An independent external-item collection MUST carry an itemContract — either declared
    // explicitly by a provider that emits independent items, or implied by a quantity-driven collection
    // produced through a provider. Omitting the itemContract cannot silently deactivate the runtime gate.
    const emitsIndependentItems = (cap.operations || []).some((operation) => operation.providerContract?.outputMode === 'independent-items');
    const bindsArrayCollection = (destination.bindings || []).some((binding) => binding.responsePath?.startsWith('response.') && schemaNodeAtPath(cap.outputSchema, binding.responsePath.replace(/^response\./, ''))?.type === 'array');
    const quantityDrivenProviderCollection = Boolean(cap.finalProduct?.quantity || cap.aggregateSubmission?.finalProduct?.quantity) && bindsArrayCollection && (cap.operations || []).some((operation) => operation.providerContract);
    if (!destination.itemContract && (emitsIndependentItems || quantityDrivenProviderCollection)) findings.push(`capability ${cap.id} produces a quantity-driven independent external-item collection but omits resultDestination.itemContract — the independence contract cannot be omitted`);
    if (destination.itemContract) findings.push(...itemContractFindings(cap, destination));
  } else if (destination.targetKind === 'field') {
    if (!destination.targetFieldId || !inputFieldTypes.has(destination.targetFieldId)) findings.push(`capability ${cap.id} field-assist resultDestination targets an unknown input field: ${destination.targetFieldId}`);
    if (!['replace', 'append', 'suggest'].includes(destination.writeBehavior)) findings.push(`capability ${cap.id} field-assist resultDestination has an invalid writeBehavior`);
    const responsePath = String(destination.responsePath || '').replace(/^response\./, '');
    if (!destination.responsePath?.startsWith('response.') || !schemaHasPath(cap.outputSchema, responsePath)) findings.push(`capability ${cap.id} field-assist responsePath does not exist in the output schema: ${destination.responsePath}`);
    else { const targetType = inputFieldTypes.get(destination.targetFieldId)?.type; const sourceType = schemaTypeAtPath(cap.outputSchema, responsePath); if (targetType && sourceType && !typesCompatible(sourceType, targetType)) findings.push(`capability ${cap.id} field-assist output type (${JSON.stringify(sourceType)}) is incompatible with target field ${destination.targetFieldId} (${JSON.stringify(targetType)})`); }
  }
  return findings;
}
function schemaTypeAtPath(schema, path) { let current = schema; for (const part of String(path).replace(/\[\]$/g, '').split('.').filter(Boolean)) { current = current?.properties?.[part] || (current?.type === 'array' ? current.items?.properties?.[part] : null); if (!current) return null; } return current?.type || null; }
function schemaNodeAtPath(schema, path) { let current = schema; for (const part of String(path).replace(/\[\]$/g, '').split('.').filter(Boolean)) { current = current?.properties?.[part] || (current?.type === 'array' ? current.items?.properties?.[part] : null); if (!current) return null; } return current; }
// Quantity integrity + independent-media item contract (net-new; hung under the result contract of a
// collection-producing capability). Validate proves the contract is structurally complete and its
// quantity chain and item fields point at real schema paths; PI's runner enforces the runtime facts
// (non-default value, request/response/visible/provider-call count agreement, per-item uniqueness).
function itemContractFindings(cap, destination) {
  const findings = []; const contract = destination.itemContract;
  if (contract.mode !== 'independent-media') { findings.push(`capability ${cap.id} itemContract has an unsupported mode: ${contract.mode}`); return findings; }
  for (const flag of ['uniqueIdRequired', 'uniqueUrlRequired', 'uniqueFileRequired', 'compositeMediaForbidden']) if (contract[flag] !== true) findings.push(`capability ${cap.id} independent-media itemContract must set ${flag} to true`);
  const binding = (destination.bindings || []).find((item) => item.responsePath?.startsWith('response.'));
  const collection = binding ? schemaNodeAtPath(cap.outputSchema, binding.responsePath.replace(/^response\./, '')) : null;
  if (collection?.type !== 'array') { findings.push(`capability ${cap.id} independent-media itemContract must bind to an array collection response`); return findings; }
  // Items are either media-URL strings (the value is the media resource) or objects that name their
  // own id and url fields. Either way the runtime proves per-item uniqueness by fetching the URLs.
  const itemType = Array.isArray(collection.items?.type) ? collection.items.type.find((entry) => entry !== 'null') : collection.items?.type;
  if (itemType === 'object') { for (const [flag, field] of [['idField', contract.idField], ['urlField', contract.urlField]]) if (!field || !collection.items.properties?.[field]) findings.push(`capability ${cap.id} itemContract ${flag} does not exist in the collection item schema: ${field}`); }
  else if (itemType === 'string') { if (contract.idField || contract.urlField) findings.push(`capability ${cap.id} string-collection itemContract must not name idField/urlField (the item value is itself the media URL)`); }
  else findings.push(`capability ${cap.id} independent-media collection items must be media-URL strings or objects`);
  if (!binding?.count || binding.count.mode !== 'request-field' || binding.count.fixedValueForbidden !== true || binding.count.nonDefaultValueRequired !== true) findings.push(`capability ${cap.id} independent-media collection lacks a dynamic, non-default quantity contract (count.mode request-field, fixedValueForbidden, nonDefaultValueRequired)`);
  const finalProduct = cap.finalProduct || cap.aggregateSubmission?.finalProduct;
  const countField = String(binding?.count?.requestPath || '').replace(/^request\./, '');
  if (finalProduct?.quantity) {
    if (finalProduct.quantity.nonDefaultValueRequired !== true) findings.push(`capability ${cap.id} finalProduct.quantity must set nonDefaultValueRequired to match its independent-media count contract`);
    if (finalProduct.quantity.sourceField && countField && finalProduct.quantity.sourceField !== countField) findings.push(`capability ${cap.id} quantity chain is inconsistent: result count requestPath (${countField}) and finalProduct.quantity.sourceField (${finalProduct.quantity.sourceField}) differ`);
  }
  return findings;
}
function typesCompatible(source, target) { const norm = (type) => (Array.isArray(type) ? type : [type]).filter((item) => item && item !== 'null'); const sourceTypes = norm(source); const targetTypes = norm(target); return sourceTypes.some((item) => targetTypes.includes(item)); }
