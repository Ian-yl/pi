#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, posix, resolve } from 'node:path';
import { digestJSON, hashDirectory as hashHandoffTree, releaseDigest } from './lib/handoff.mjs';
import { treeDigest } from './lib/validator-tree.mjs';

const args = parseArgs(process.argv.slice(2));
const handoffArg = args.handoff;
if (!args.functional || !handoffArg || !args.output) usage();
const functionalDir = resolve(args.functional);
const handoffDir = resolve(handoffArg);
const output = resolve(args.output);
if (existsSync(output) && readdirSync(output).length) throw new Error('implementation output directory must not exist or must be empty');
const functionalManifestPreview = readJSON(`${functionalDir}/manifest.json`);
const SCHEMA_23_SEMANTIC_FILES = ['frontend-semantic-inventory.json', 'observed-interactions.json', 'control-capability-map.json', 'asset-role-inventory.json'];
const semanticFiles = functionalManifestPreview.schemaVersion === '2.3' ? SCHEMA_23_SEMANTIC_FILES : [];
const evidenceFiles = ['evidence-index.json', 'evidence-dispositions.json'];
const requiredFunctionalFiles = ['manifest.json', 'planning-manifest.json', 'planning-artifacts.json', 'capability-definitions.json', 'design-manifest.json', ...evidenceFiles, ...semanticFiles, 'functional-spec.json', 'page-function-map.json', 'unresolved-items.json', 'planning-review-receipt.json', 'review-receipt.json'];
const functionalPackageLockPreview = readJSON(`${functionalDir}/package-lock.json`);
const protectedFunctionalFiles = lockedPackageFiles(functionalPackageLockPreview);
const formalFunctionalFiles = [...protectedFunctionalFiles, 'package-lock.json'];
const protectedHandoffFiles = ['handoff-manifest.json', 'visual-source.json', 'release-manifest.json', 'suite-gate.json', 'visual-approval.json', 'frontend-manifest.json', 'functional-spec.json', ...semanticFiles, ...(functionalManifestPreview.schemaVersion === '2.3' ? ['handoff-anchor-manifest.json'] : []), 'visual-controls.json', 'ui-implementation-plan.json', 'api-contract.json', 'domain-bindings.json', 'runtime-contract.json', 'handoff-review-receipt.json'];
const formalHandoffFiles = [...protectedHandoffFiles, 'handoff-lock.json'];
const functionalJsonFiles = [...requiredFunctionalFiles, 'package-lock.json'];
const f = Object.fromEntries(functionalJsonFiles.filter((file) => existsSync(`${functionalDir}/${file}`)).map((file) => [file, readJSON(`${functionalDir}/${file}`)]));
const front = Object.fromEntries(formalHandoffFiles.filter((file) => existsSync(`${handoffDir}/${file}`)).map((file) => [file, readJSON(`${handoffDir}/${file}`)]));
const errors = [];
if (functionalManifestPreview.schemaVersion !== '2.3') errors.push('project implementation accepts only functional-domain schema 2.3');
if (functionalManifestPreview.schemaVersion === '2.3' && JSON.stringify(functionalManifestPreview.semanticArtifacts) !== JSON.stringify(SCHEMA_23_SEMANTIC_FILES)) errors.push('schema 2.3 semanticArtifacts must equal the fixed semantic artifact contract');

for (const file of requiredFunctionalFiles) if (!protectedFunctionalFiles.includes(file)) errors.push(`functional package lock is missing required file ${file}`);
for (const file of formalFunctionalFiles) if (!existsSync(`${functionalDir}/${file}`)) errors.push(`functional package is missing ${file}`);
for (const file of formalHandoffFiles) if (!front[file]) errors.push(`implementation handoff is missing ${file}`);
const manifest = f['manifest.json'] || {};
const spec = f['functional-spec.json'] || {};
const receipt = f['review-receipt.json'];
const trustedFunctionalValidators = new Map([
  ['fdd-validator-2.3.0', { contractVersion: 'functional-domain/2.3', entry: resolve(import.meta.dirname, '../validators/fdd-2.3.0/validate-package.mjs') }],
]);
const planningManifest = f['planning-manifest.json'] || {}; const planningArtifacts = f['planning-artifacts.json'] || {}; const definitions = f['capability-definitions.json'] || {}; const planningReceipt = f['planning-review-receipt.json'];
if (manifest.status !== 'approved') errors.push('functional package is not approved');
if (receipt) {
  if (receipt.status !== 'approved') errors.push('functional review receipt is not approved');
  if (!manifest.authorAgentId || receipt.authorAgentId !== manifest.authorAgentId) errors.push('functional review receipt author mismatch');
  if (!receipt.reviewerAgentId || receipt.reviewerAgentId === manifest.authorAgentId) errors.push('functional review must use a distinct reviewer agent');
  if (manifest.approval?.reviewerAgentId !== receipt.reviewerAgentId) errors.push('functional manifest approval reviewer mismatch');
  const trustedValidator = receipt.trustedValidatorId ? trustedFunctionalValidators.get(receipt.trustedValidatorId) : null;
  if (receipt.contractVersion && (!trustedValidator || trustedValidator.contractVersion !== receipt.contractVersion || !existsSync(trustedValidator.entry) || receipt.validatorDigest !== treeDigest(resolve(trustedValidator.entry, '..')))) errors.push('functional approval does not reference the immutable trusted repository validator');
  if (receipt.contractVersion !== 'functional-domain/2.3') errors.push('schema 2.3 functional approval contract is missing');
}
if (planningManifest.packageType !== 'fdd-bmad-planning' || planningManifest.status !== 'approved' || planningArtifacts.method !== 'bmad-planning') errors.push('FDD planning BMAD artifacts are incomplete or unapproved; return the package to FDD');
if (!planningReceipt || planningReceipt.workflow !== 'fdd-bmad-planning' || planningReceipt.status !== 'approved' || planningReceipt.authorAgentId !== manifest.authorAgentId || planningReceipt.reviewerAgentId !== receipt?.reviewerAgentId) errors.push('FDD planning independent review is missing or inconsistent; return the package to FDD');
for (const group of ['capabilities', 'entities', 'valueObjects', 'relationships', 'consistencyBoundaries', 'journeys', 'rules', 'permissions', 'integrations']) if (JSON.stringify(definitions[group] || []) !== JSON.stringify(spec[group] || [])) errors.push(`FDD planning definitions differ from approved domain contract: ${group}; return the package to FDD`);
const functionalSchema = f['manifest.json'].schemaVersion;
if (functionalSchema !== '2.3' || [f['functional-spec.json'], f['page-function-map.json'], f['unresolved-items.json']].some((doc) => doc.schemaVersion !== '2.3')) errors.push('functional package schema must be consistently 2.3');
if (f['package-lock.json']) verifyFunctionalLock(functionalDir, f['package-lock.json'], errors);
if (receipt?.contractVersion && !errors.length) { const trustedValidator = trustedFunctionalValidators.get(receipt.trustedValidatorId); const replay = spawnSync(process.execPath, [trustedValidator.entry, functionalDir, '--require-approved', '--trusted-validator-internal', '--check-lock'], { encoding: 'utf8' }); if (replay.status !== 0) errors.push(`trusted functional ${receipt.contractVersion} validation failed: ${replay.stderr || replay.stdout}`); }
const handoffManifest = front['handoff-manifest.json'] || {}; const handoffReceipt = front['handoff-review-receipt.json']; const visualSource = front['visual-source.json']; const releaseManifest = front['release-manifest.json']; const handoffLock = front['handoff-lock.json'];
const trustedHandoffReviewers = new Map([
  ['implementation-handoff/2.3', { id: 'fdd-handoff-reviewer-2.3', entry: resolve(import.meta.dirname, '../validators/handoff-2.3/review-handoff.mjs') }],
]);
const suiteGate = front['suite-gate.json']; const visualApproval = front['visual-approval.json'];
const functionalPackageDigest = f['package-lock.json'] ? digestJSON(f['package-lock.json']) : null;
if (handoffManifest.status !== 'approved') errors.push('implementation handoff is not approved');
if (handoffReceipt) {
  if (handoffReceipt.status !== 'approved') errors.push('handoff review receipt is not approved');
  if (handoffReceipt.authorAgentId !== handoffManifest.authorAgentId) errors.push('handoff review receipt author mismatch');
  if (!handoffReceipt.reviewerAgentId || handoffReceipt.reviewerAgentId === handoffManifest.authorAgentId) errors.push('handoff review must use a distinct reviewer agent');
  const trustedReviewer = handoffReceipt.contractVersion ? trustedHandoffReviewers.get(handoffReceipt.contractVersion) : null;
  if (handoffReceipt.contractVersion && (!trustedReviewer || handoffReceipt.trustedReviewerId !== trustedReviewer.id || !existsSync(trustedReviewer.entry) || handoffReceipt.validatorDigest !== treeDigest(resolve(trustedReviewer.entry, '..')))) errors.push('handoff approval does not reference the immutable trusted repository reviewer');
  if (handoffReceipt.contractVersion !== 'implementation-handoff/2.3') errors.push('schema 2.3 handoff approval contract is missing');
}
if (handoffManifest.functionalPackageDigest !== functionalPackageDigest || handoffReceipt?.functionalPackageDigest !== functionalPackageDigest || handoffLock?.functionalPackageDigest !== functionalPackageDigest) errors.push('handoff functional package digest mismatch');
if (releaseManifest && releaseDigest(releaseManifest) !== releaseManifest.releaseDigest) errors.push('ai-restore release manifest digest mismatch');
if (visualSource) {
  if (visualSource.sourceType !== 'ai-restore-release' || visualSource.releaseDigest !== releaseManifest?.releaseDigest || handoffManifest.visualReleaseDigest !== visualSource.releaseDigest || handoffReceipt?.visualReleaseDigest !== visualSource.releaseDigest || handoffLock?.visualReleaseDigest !== visualSource.releaseDigest) errors.push('handoff visual release digest mismatch');
  if (visualSource.suiteGateDigest !== releaseManifest?.gateDigest) errors.push('handoff Suite Gate digest mismatch');
  if (suiteGate?.pass !== true || suiteGate?.gateDigest !== releaseManifest?.gateDigest) errors.push('handoff Suite Gate is not a passing release Gate');
  if (visualApproval?.approvalDigest !== releaseManifest?.approvalDigest) errors.push('handoff visual approval digest mismatch');
  if (existsSync(`${handoffDir}/web`) && visualSource.sourceTreeDigest !== hashHandoffTree(`${handoffDir}/web`)) errors.push('handoff visual source tree digest mismatch');
  if (spec.visualSource?.releaseDigest !== visualSource.releaseDigest || manifest.visualReleaseDigest !== visualSource.releaseDigest) errors.push('functional package visual release digest mismatch');
}
if (handoffLock) verifyHandoffLock(handoffDir, handoffLock, errors);
if (handoffReceipt?.contractVersion && !errors.length) { const trustedReviewer = trustedHandoffReviewers.get(handoffReceipt.contractVersion); const replay = spawnSync(process.execPath, [trustedReviewer.entry, '--handoff', handoffDir, '--reviewer-agent', handoffReceipt.reviewerAgentId, '--trusted-replay-only', 'true'], { encoding: 'utf8' }); if (replay.status !== 0) errors.push(`trusted handoff ${handoffReceipt.contractVersion} review failed: ${replay.stderr || replay.stdout}`); }
if ((f['unresolved-items.json'].items || []).some((item) => item.severity === 'blocker' && item.status !== 'resolved')) errors.push('functional package has an unresolved blocker');
const pageMap = new Map((f['page-function-map.json'].pages || []).map((page) => [page.pageId, page]));
const capabilities = new Map((spec.capabilities || []).map((item) => [item.id, item]));
const entities = new Map((spec.entities || []).map((item) => [item.id, item]));
const relationships = new Map((spec.relationships || []).map((item) => [item.id, item]));
const consistencyBoundaries = new Map((spec.consistencyBoundaries || []).map((item) => [item.id, item]));
const rules = new Set((spec.rules || []).map((item) => item.id));
const pages = (front['frontend-manifest.json'] || {}).pages || {};
const operations = new Map(((front['api-contract.json'] || {}).operations || (front['api-contract.json'] || {}).endpoints || []).map((item) => [item.id || item.operationId, item]));
const rawUiContracts = (front['ui-implementation-plan.json'] || {}).capabilities || [];
const rawUiCapabilityIds = rawUiContracts.map((item) => item.capabilityId);
const uiContracts = new Map(rawUiContracts.map((item) => [item.capabilityId, item]));
const uiPlan = new Map([...uiContracts].map(([capabilityId, item]) => [capabilityId, item.presentation]));
const integrationCapabilityIds = new Set((spec.integrations || []).flatMap((integration) => integration.capabilityIds || []));
const permissionCapabilityIds = new Set((spec.permissions || []).flatMap((permission) => permission.capabilityIds || []));
const contractCompletionItems = [...capabilities.values()].filter((capability) => capability.specificationStatus === 'complete' && capabilityRequiresServerOperation(capability, integrationCapabilityIds, permissionCapabilityIds) && !(capability.operations || []).length).map((capability) => ({ capabilityId: capability.id, reason: 'complete server-required capability has no operation', requiredAction: 'FDD agent authors the operation contract, independent review approves it, then rebuild and review the handoff before PI prepare is retried' }));
if (contractCompletionItems.length) {
  writeJSON(`${output}.contract-completion.json`, { schemaVersion: '1.0', generatedBy: 'project-implementation/prepare-implementation', status: 'requires-fdd-contract-completion', sourceFunctionalPackage: functionalDir, items: contractCompletionItems });
  errors.push(`approved input requires contract completion for ${contractCompletionItems.map((item) => item.capabilityId).join(', ')}; return the generated work item to the FDD agent and use only a newly reviewed and locked package/handoff`);
}
if (new Set(rawUiCapabilityIds).size !== rawUiCapabilityIds.length || JSON.stringify([...rawUiCapabilityIds].sort()) !== JSON.stringify([...capabilities.keys()].sort())) errors.push('UI capability plan must be an exact one-to-one set with the functional capabilities');
if (front['functional-spec.json'] && sha(readFileSync(`${handoffDir}/functional-spec.json`)) !== sha(readFileSync(`${functionalDir}/functional-spec.json`))) errors.push('handoff functional spec does not match approved package');
if (!Array.isArray(spec.relationships) || !Array.isArray(spec.consistencyBoundaries)) errors.push('functional package has no formal relationship and consistency contracts');
for (const entity of entities.values()) if (!entity.identity?.fields?.length || typeof entity.aggregateRoot !== 'boolean' || !entity.constraints || !entity.accessScope) errors.push(`entity ${entity.id} has an incomplete persistence contract`);
for (const relation of relationships.values()) if (!entities.has(relation.fromEntityId) || !entities.has(relation.toEntityId) || !relation.cardinality || !relation.associationKey?.fromFields?.length || !relation.associationKey?.toFields?.length || !relation.ownership || typeof relation.required !== 'boolean' || !relation.onDelete || !relation.invariants?.length) errors.push(`relationship ${relation.id} has an incomplete contract`);

for (const [pageId, mapping] of pageMap) {
  for (const capabilityId of mapping.capabilityIds || []) {
    if (!capabilities.has(capabilityId)) errors.push(`page ${pageId} references unknown capability ${capabilityId}`);
    if (!uiPlan.has(capabilityId)) errors.push(`capability ${capabilityId} has no UI implementation intent`);
  }
}
for (const [id, operation] of operations) {
  if (!id) errors.push('API operation without id');
  if (!capabilities.has(operation.capabilityId)) errors.push(`operation ${id} references unknown capability ${operation.capabilityId}`);
  if (capabilities.get(operation.capabilityId)?.specificationStatus === 'planned') errors.push(`planned capability ${operation.capabilityId} must not expose an API operation`);
  for (const ruleId of operation.ruleIds || []) if (!rules.has(ruleId)) errors.push(`operation ${id} references unknown rule ${ruleId}`);
  const writes = !['GET', 'HEAD'].includes(String(operation.method || '').toUpperCase());
  if (writes && !operation.effects?.length) errors.push(`write operation ${id} has no effects`);
  if (writes && !operation.errors?.length) errors.push(`write operation ${id} has no error contract`);
  if (operation.request?.contentType === 'multipart/form-data' && (!operation.resourceTransfer?.fileField || !operation.resourceTransfer?.responseIdPath)) errors.push(`multipart operation ${id} has no resourceTransfer contract`);
  const effectEntities = new Set((operation.effects || []).map((effect) => effect.entityId));
  for (const entityId of effectEntities) if (!entities.has(entityId)) errors.push(`operation ${id} references unknown entity ${entityId}`);
  if ((effectEntities.size > 1 || (operation.effects || []).some((effect) => effect.effect === 'associate')) && (!operation.transaction?.boundary || operation.transaction.atomic !== true) && !operation.consistency?.strategy) errors.push(`operation ${id} has no transaction or consistency strategy for related writes`);
}
for (const [capabilityId, capability] of capabilities) {
  const contract = uiContracts.get(capabilityId);
  const functionalStatus = capability.specificationStatus || 'complete';
  const handoffStatus = contract?.specificationStatus || 'complete';
  if (handoffStatus !== functionalStatus) errors.push(`capability ${capabilityId} handoff status differs from the functional contract`);
  if (functionalStatus === 'planned' && ((capability.operations || []).length || (capability.entityEffects || []).length || capability.writesState || (capability.inputs || []).length || capability.inputSchema || (capability.outcomes || []).length || capability.outputSchema || (capability.acceptanceExamples || []).length || capability.deliveryPolicy?.requiredForCompletion !== false || capability.deliveryPolicy?.uiBehavior !== 'show-planned-state' || !capability.planningReason)) errors.push(`planned capability ${capabilityId} exposes implementation semantics or lacks its planned delivery contract`);
  if (functionalStatus === 'planned' && capability.presentation?.mode === 'headless') errors.push(`planned capability ${capabilityId} cannot be headless`);
}
for (const journey of spec.journeys || []) {
  for (const capabilityId of journey.capabilityIds || []) if (capabilities.get(capabilityId)?.specificationStatus !== 'complete') errors.push(`implementation journey ${journey.id} includes non-complete capability ${capabilityId}`);
  if (!journey.acceptanceCriteria?.length && !journey.success) errors.push(`journey ${journey.id} has no acceptance contract`);
}
if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}

mkdirSync(output, { recursive: true });
mkdirSync(`${output}/inputs`, { recursive: true });
for (const file of formalFunctionalFiles) { const target = `${output}/inputs/functional-${file}`; mkdirSync(dirname(target), { recursive: true }); cpSync(`${functionalDir}/${file}`, target); }
for (const file of formalHandoffFiles) cpSync(`${handoffDir}/${file}`, `${output}/inputs/handoff-${file}`);
if (existsSync(`${handoffDir}/web`)) cpSync(`${handoffDir}/web`, `${output}/web`, {
  recursive: true,
  filter: (source) => !['node_modules', 'dist'].includes(source.split(/[\\/]/).at(-1)),
});

const inputDigests = {};
for (const file of formalFunctionalFiles) inputDigests[`functional/${file}`] = sha(readFileSync(`${functionalDir}/${file}`));
for (const file of formalHandoffFiles) inputDigests[`handoff/${file}`] = sha(readFileSync(`${handoffDir}/${file}`));
const fddPlanningDigest = digestJSON({ manifest: planningManifest, artifacts: planningArtifacts, definitions, review: planningReceipt });
writeJSON(`${output}/input-lock.json`, { schemaVersion: '1.1', algorithm: 'sha256', bmadRequired: true, sources: { functionalPackageDigest, fddPlanningDigest, visualReleaseDigest: visualSource.releaseDigest, handoffPackageDigest: digestJSON(handoffLock) }, implementationFrontendDigest: existsSync(`${output}/web`) ? hashHandoffTree(`${output}/web`) : null, digests: inputDigests });

const units = [];
for (const entity of spec.entities || []) units.push({ id: `persistence-${entity.id}`, type: 'persistence', entityIds: [entity.id], dependsOn: [], acceptance: ['migration applies to a clean database', 'entity effects are observable'] });
for (const relation of spec.relationships || []) units.push({ id: `relationship-${relation.id}`, type: 'relation-migration', relationshipIds: [relation.id], entityIds: [relation.fromEntityId, relation.toEntityId], dependsOn: [`persistence-${relation.fromEntityId}`, `persistence-${relation.toEntityId}`], acceptance: ['association key and cardinality are enforced', `delete behavior is ${relation.onDelete}`, 'relationship invariants have dedicated tests'] });
for (const boundary of spec.consistencyBoundaries || []) units.push({ id: `consistency-${boundary.id}`, type: 'consistency', consistencyBoundaryIds: [boundary.id], entityIds: boundary.entityIds || [], dependsOn: (spec.relationships || []).filter((relation) => (boundary.entityIds || []).includes(relation.fromEntityId) && (boundary.entityIds || []).includes(relation.toEntityId)).map((relation) => `relationship-${relation.id}`), acceptance: [`${boundary.strategy} consistency boundary is verified`, 'rollback or convergence behavior is tested'] });
for (const capability of (spec.capabilities || []).filter((item) => item.specificationStatus !== 'planned')) units.push({ id: `capability-${capability.id}`, type: 'capability', capabilityIds: [capability.id], dependsOn: (capability.entityEffects || []).map((effect) => `persistence-${effect.entityId}`), acceptance: capability.acceptanceCriteria || [] });
for (const [capabilityId, presentation] of uiPlan) if (presentation.mode !== 'headless') {
  const uiContract = uiContracts.get(capabilityId);
  if (uiContract.specificationStatus === 'planned') {
    units.push({ id: `planned-capability-${capabilityId}`, type: 'ui-planned-state', capabilityIds: [capabilityId], presentation, deliveryPolicy: uiContract.deliveryPolicy, dependsOn: [], acceptance: ['the declared entry is reachable by a real user interaction', 'activation replaces the active workspace with capability-specific planned content', 'the visible state identifies this capability and says 功能待实现', 'activation emits no business API request and renders no fabricated success result'] });
    continue;
  }
  units.push({ id: `presentation-${capabilityId}`, type: 'ui-presentation', capabilityIds: [capabilityId], presentation, dependsOn: [`capability-${capabilityId}`], acceptance: ['runtime DOM contains one visible presentation binding', 'functional and visual regression evidence is recorded'] });
  const activationDependency = presentation.activation ? `activation-${capabilityId}` : `presentation-${capabilityId}`;
  if (presentation.activation) units.push({ id: `activation-${capabilityId}`, type: 'ui-activation', capabilityIds: [capabilityId], activation: presentation.activation, deliveryPolicy: uiContract.deliveryPolicy, dependsOn: [`presentation-${capabilityId}`], acceptance: ['browser activation sets the declared active capability', 'development planned state is explicit and final completion is implemented'] });
  if (presentation.surface) units.push({ id: `surface-${capabilityId}`, type: 'ui-surface', capabilityIds: [capabilityId], surface: presentation.surface, aliasOf: uiContract.aliasOf, dependsOn: [activationDependency], acceptance: ['runtime content fingerprint matches the domain surface contract', 'workspace content, inputs, operation, empty state, and results belong to the active capability'] });
  if (presentation.surface?.contentContract?.resultContract) units.push({ id: `result-presentation-${capabilityId}`, type: 'ui-result-presentation', capabilityIds: [capabilityId], resultContract: presentation.surface.contentContract.resultContract, dependsOn: [`interaction-${capabilityId}`], acceptance: ['the successful operation response is rendered in the declared semantic region', 'rendered element values and cardinality match the runtime response', 'processing, success, and failure region states are observable without pixel assertions'] });
  const surfaceDependency = presentation.surface ? `surface-${capabilityId}` : activationDependency;
  units.push({ id: `interaction-${capabilityId}`, type: 'ui-interaction', capabilityIds: [capabilityId], presentation, dependsOn: [surfaceDependency], acceptance: [presentation.mode === 'display-only' ? 'data-render trigger updates the runtime DOM' : 'runtime event produces the declared server request or client state change'] });
  units.push({ id: `frontend-state-${capabilityId}`, type: 'ui-state', capabilityIds: [capabilityId], presentation, dependsOn: [`interaction-${capabilityId}`], acceptance: ['applicable idle, loading, empty, error, disabled, and success states are browser-tested'] });
  units.push({ id: `frontend-data-${capabilityId}`, type: 'ui-data', capabilityIds: [capabilityId], presentation, dependsOn: [`frontend-state-${capabilityId}`], acceptance: ['business content comes from an operation, user input, authenticated context, or explicit empty state', 'visual placeholders have an approved resolution'] });
}
for (const rule of spec.rules || []) units.push({ id: `rule-${rule.id}`, type: 'rule', ruleIds: [rule.id], dependsOn: (rule.appliesTo || []).map((id) => `capability-${id}`), acceptance: rule.statement ? [rule.statement] : [...(rule.conditions || []).map((item) => `condition: ${item}`), ...(rule.assertions || []).map((item) => `assertion: ${item}`)] });
for (const [id, operation] of operations) {
  const effectEntityIds = new Set((operation.effects || []).map((effect) => effect.entityId));
  const relationDependencies = [...relationships.values()].filter((relation) => effectEntityIds.has(relation.fromEntityId) || effectEntityIds.has(relation.toEntityId)).map((relation) => `relationship-${relation.id}`);
  const consistencyDependencies = [...consistencyBoundaries.values()].filter((boundary) => operation.transaction?.boundary === boundary.id || operation.transaction?.boundary === boundary.aggregateRootEntityId || (boundary.entityIds || []).filter((entityId) => effectEntityIds.has(entityId)).length > 1).map((boundary) => `consistency-${boundary.id}`);
  units.push({ id: `operation-${id}`, type: 'api', operationIds: [id], capabilityIds: [operation.capabilityId], ruleIds: operation.ruleIds || [], dependsOn: [...new Set([...(operation.effects || []).map((effect) => `persistence-${effect.entityId}`), ...relationDependencies, ...consistencyDependencies])].filter((value) => units.some((unit) => unit.id === value)), acceptance: ['operation is live', 'response and errors match contract', 'declared effects and transaction behavior are verified'] });
  const resourceTransfer = operation.resourceTransfer;
  if (resourceTransfer) {
    units.push({ id: `resource-transfer-${id}`, type: 'resource-transfer', operationIds: [id], capabilityIds: [operation.capabilityId], dependsOn: [`operation-${id}`], acceptance: ['the declared client transfer reaches the application operation', 'the response returns the declared resource reference and integrity metadata'] });
    units.push({ id: `resource-validation-${id}`, type: 'resource-validation', operationIds: [id], dependsOn: [`resource-transfer-${id}`], acceptance: ['declared media, size, count, purpose, integrity, ownership, and rejection constraints are tested'] });
    units.push({ id: `resource-persistence-${id}`, type: 'resource-persistence', operationIds: [id], entityIds: (operation.effects || []).map((item) => item.entityId), dependsOn: [`resource-validation-${id}`], acceptance: ['validated resource metadata and storage reference persist under the declared ownership scope'] });
  }
  if (operation.dataDependencies?.length) {
    const sourceOperationId = operation.dataDependencies.find((item) => item.sourceOperationId)?.sourceOperationId;
    const sourceDependency = sourceOperationId && operations.get(sourceOperationId)?.resourceTransfer ? [`resource-persistence-${sourceOperationId}`] : [`operation-${sourceOperationId}`].filter((value) => sourceOperationId);
    units.push({ id: `data-dependency-${id}`, type: 'cross-operation-data-flow', operationIds: [id, sourceOperationId].filter(Boolean), capabilityIds: [operation.capabilityId], dependsOn: [`operation-${id}`, ...sourceDependency], acceptance: ['each declared source response value is reused in the target request at runtime', 'hard-coded or independently fabricated correlation values are rejected'] });
    if (operation.integrationBindings?.length) {
      units.push({ id: `integration-binding-${id}`, type: 'integration-binding', operationIds: [id], capabilityIds: [operation.capabilityId], dependsOn: [`data-dependency-${id}`], acceptance: ['integration adapter evidence contains the same runtime-generated value or safe digest', 'unsupported external capability returns the declared operation-specific error'] });
      units.push({ id: `external-effect-${id}`, type: 'external-effect', operationIds: [id], capabilityIds: [operation.capabilityId], dependsOn: [`integration-binding-${id}`], acceptance: ['declared external effects and subsequent observable reads preserve the data lineage'] });
    }
  }
}
for (const journey of spec.journeys || []) {
  const acceptance = journey.acceptanceCriteria || (journey.success ? [journey.success] : []);
  units.push({ id: `journey-${journey.id}`, type: 'e2e', journeyIds: [journey.id], capabilityIds: journey.capabilityIds || [], dependsOn: (journey.operationIds || []).map((id) => `operation-${id}`), acceptance });
  if (journey.dataLineage) units.push({ id: `business-lineage-${journey.id}`, type: 'business-lineage-e2e', journeyIds: [journey.id], operationIds: journey.operationIds || [], capabilityIds: journey.capabilityIds || [], dependsOn: (journey.operationIds || []).filter((id) => operations.get(id)?.dataDependencies?.length).map((id) => operations.get(id)?.integrationBindings?.length ? `external-effect-${id}` : `data-dependency-${id}`), acceptance: ['runtime-generated values cross every declared operation boundary', 'observable results preserve the same lineage through the complete journey'] });
}
writeJSON(`${output}/implementation-plan.json`, { schemaVersion: '1.0', projectId: f['manifest.json'].projectId, status: 'ready', authority: 'approved-functional-domain-only', planningSource: { workflow: 'fdd-bmad-planning', digest: fddPlanningDigest, semanticChangesAllowed: false }, implementationWorkflow: 'pi-implementation-bmad', units });
const fieldBindings = buildFieldBindingPlan();
writeJSON(`${output}/field-binding-plan.json`, { schemaVersion: '1.1', generatedFrom: 'locked-functional-and-handoff-contracts', bindings: fieldBindings });
writeJSON(`${output}/implementation-worklist.json`, { schemaVersion: '1.0', advisory: true, generatedFrom: ['control-capability-map.json', 'frontend-semantic-inventory.json', 'field-binding-plan.json'], items: buildImplementationWorklist(fieldBindings) });
writeJSON(`${output}/implementation-provenance.json`, {
  schemaVersion: '1.0',
  mode: 'from-contract',
  inputLock: 'input-lock.json',
  frontendSource: 'copied from locked implementation handoff visual source',
  backendSource: { status: 'pending' },
  operationSources: [],
});
writeJSON(`${output}/interaction-manifest.json`, { schemaVersion: '1.0', status: 'pending', interactions: [] });
writeJSON(`${output}/control-bindings.json`, { schemaVersion: '1.0', status: 'pending', bindings: [] });
writeJSON(`${output}/frontend-runtime-config.json`, { schemaVersion: '1.1', status: 'pending', start: null, healthUrl: null, e2e: null, evidenceProtocol: { version: 'playwright-computed-render-v1', uploadChallengesEnv: 'FRONTEND_UPLOAD_CHALLENGES', renderObserverSource: `elements => elements.map(element => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return { visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0, tag: element.tagName.toLowerCase(), text: element.textContent.trim(), src: element.currentSrc || element.src || null, href: element.href || null, value: 'value' in element ? element.value : null }; })` } });
const assetRoles = front['asset-role-inventory.json']?.assets || [];
writeJSON(`${output}/placeholder-resolution.json`, { schemaVersion: '1.1', status: 'pending', environment: 'production', items: assetRoles.map((asset) => ({ id: `placeholder-${asset.id}`, assetId: asset.id, sourcePath: asset.path, sourceDigest: asset.digest, classification: asset.role, requiredReplacement: asset.requiredReplacement || null, resolution: asset.role === 'decorative' ? 'retained-as-static-decoration' : 'pending', ...(asset.role === 'decorative' ? { businessRole: 'decoration' } : {}) })), runtimeFallbacks: [] });
const bmad = spawnSync(process.execPath, [resolve(import.meta.dirname, 'export-bmad-stories.mjs'), '--implementation', output], { encoding: 'utf8' });
if (bmad.status !== 0) throw new Error(`BMAD story export failed: ${bmad.stderr || bmad.stdout}`);
const traceability = readJSON(`${output}/bmad-traceability.json`);
writeJSON(`${output}/input-lock.json`, { ...readJSON(`${output}/input-lock.json`), bmad: { contracts: Object.fromEntries((traceability.stories || []).map((story) => [story.unitId, story.contractDigest])) } });
writeJSON(`${output}/bmad-completion.json`, { schemaVersion: '1.0', status: 'pending', records: [] });
console.log(`Implementation workspace ready (${capabilities.size} capabilities, ${operations.size} operations, ${units.length} units) -> ${output}`);

function verifyFunctionalLock(dir, lock, errors) {
  const digests = lock.digests || {};
  for (const file of protectedFunctionalFiles) if (!digests[file]) errors.push(`functional lock is missing digest: ${file}`);
  for (const file of protectedFunctionalFiles) {
    const digest = digests[file];
    if (!digest || !existsSync(`${dir}/${file}`)) continue;
    if (sha(readFileSync(`${dir}/${file}`)) !== digest) errors.push(`functional lock mismatch: ${file}`);
  }
}
function lockedPackageFiles(lock) {
  if (lock.schemaVersion !== '1.0' || lock.algorithm !== 'sha256' || !lock.digests || typeof lock.digests !== 'object') throw new Error('functional package lock is incomplete or unsupported');
  const files = Object.keys(lock.digests).sort();
  for (const file of files) if (!file || posix.isAbsolute(file) || posix.normalize(file) !== file || file === '..' || file.startsWith('../')) throw new Error(`functional package lock contains an unsafe path: ${file}`);
  if (!files.includes('design-manifest.json') || !files.some((file) => file.startsWith('designs/'))) throw new Error('functional package lock does not contain the finalized design closure');
  return files;
}
function buildFieldBindingPlan() {
  const bindings = [];
  for (const capability of capabilities.values()) {
    if (capability.specificationStatus === 'planned') {
      if (capability.presentation?.mode !== 'headless') bindings.push({ id: `binding-${capability.id}-state-planned`, kind: 'planned-state', controlId: `state-${capability.id}-planned`, capabilityId: capability.id, statePath: `capabilities.${capability.id}.states.planned`, operationId: null, requestPath: null, responsePath: null, effectIds: [], required: true });
      continue;
    }
    const capabilityOperations = [...operations.values()].filter((item) => item.capabilityId === capability.id);
    for (const operation of capabilityOperations) {
      const requestFields = requestSchemaFields(operation.request || {}); const responseFields = schemaLeaves(operation.response?.bodySchema || operation.response?.schema || schemaFromFields(operation.response?.fields || []));
      const effectIds = (operation.effects || []).map((item, index) => `${operation.id}:${item.entityId}:${item.effect}:${index}`);
      for (const field of requestFields) {
        const dependency = (operation.dataDependencies || []).find((item) => normalizeRequestPath(item.targetField) === normalizeRequestPath(field.path));
        const source = dependency ? 'prior-operation' : field.location === 'body' ? 'user-input' : 'application-state';
        bindings.push({ id: `binding-${capability.id}-${operation.id}-${slug(field.path)}`, kind: 'input', source, controlId: `input-${capability.id}-${slug(field.path)}`, capabilityId: capability.id, statePath: `capabilities.${capability.id}.inputs.${field.path}`, operationId: operation.id, requestPath: field.path, responsePath: responseFields[0]?.path || null, effectIds, required: field.required, schema: field.schema, ...(dependency ? { sourceOperationId: dependency.sourceOperationId, sourceResponsePath: dependency.sourceField } : {}) });
      }
      bindings.push({ id: `binding-${capability.id}-${operation.id}-command`, kind: 'command', controlId: `command-${capability.id}-${operation.id}`, capabilityId: capability.id, statePath: `capabilities.${capability.id}.status`, operationId: operation.id, requestPath: null, responsePath: responseFields[0]?.path || null, effectIds, required: true });
      for (const field of responseFields) bindings.push({ id: `binding-${capability.id}-${operation.id}-response-${slug(field.path)}`, kind: 'display', controlId: `output-${capability.id}-${slug(field.path)}`, capabilityId: capability.id, statePath: `capabilities.${capability.id}.response.${field.path}`, operationId: operation.id, requestPath: null, responsePath: field.path, effectIds, required: field.required, runtimeValueRequired: functionalSchema === '2.3', elementSemantic: field.schema?.type === 'array' ? 'collection-value' : 'field-value' });
    }
    const resultContract = uiContracts.get(capability.id)?.presentation?.surface?.contentContract?.resultContract;
    const primaryOperationId = uiContracts.get(capability.id)?.presentation?.primaryOperationId || capabilityOperations[0]?.id;
    for (const result of resultContract?.bindings || []) { const resultOperationId = result.operationId || resultContract.runtimeFlow?.terminalOperationId || primaryOperationId; bindings.push({ id: `binding-${capability.id}-result-${slug(result.id)}`, kind: 'result', controlId: `result-${capability.id}-${slug(result.id)}`, capabilityId: capability.id, statePath: `capabilities.${capability.id}.result.${result.id}`, operationId: resultOperationId, requestPath: result.count?.requestPath || null, responsePath: String(result.responsePath).replace(/^response\./, ''), effectIds: (capabilityOperations.find((item) => item.id === resultOperationId)?.effects || []).map((item, index) => `${resultOperationId}:${item.entityId}:${item.effect}:${index}`), required: true, regionId: resultContract.targetRegion, elementSemantic: result.element.semantic, count: result.count, resultStates: resultContract.states, runtimeFlow: resultContract.runtimeFlow }); }
    if (capability.presentation?.mode !== 'headless') for (const state of ['loading', 'success', 'failure', 'empty']) bindings.push({ id: `binding-${capability.id}-state-${state}`, kind: 'state', controlId: `state-${capability.id}-${state}`, capabilityId: capability.id, statePath: `capabilities.${capability.id}.states.${state}`, operationId: capabilityOperations[0]?.id || null, requestPath: null, responsePath: null, effectIds: [], required: true });
  }
  return bindings;
}
function buildImplementationWorklist(bindings) {
  const semanticPages = new Map((front['frontend-semantic-inventory.json']?.pages || []).map((page) => [page.pageId, new Map((page.controls || []).map((control) => [control.controlId, control]))]));
  return (front['control-capability-map.json']?.mappings || []).map((mapping) => {
    const capabilityBindings = bindings.filter((binding) => binding.capabilityId === mapping.capabilityId);
    const anchor = semanticPages.get(mapping.pageId)?.get(mapping.controlId);
    const result = capabilityBindings.find((binding) => binding.kind === 'result');
    return { pageId: mapping.pageId, controlId: mapping.controlId || null, dataVrId: anchor?.stableId || null, capabilityId: mapping.capabilityId, operationId: mapping.primaryOperationId || null, bindingIds: capabilityBindings.map((binding) => binding.id), resultTarget: result?.regionId || null };
  });
}
function requestSchemaFields(request) { return [['path', request.pathSchema], ['query', request.querySchema], ['header', request.headerSchema], ['body', request.bodySchema]].flatMap(([location, schema]) => schemaLeaves(schema).map((item) => ({ ...item, location, path: `${location}.${item.path}` }))); }
function normalizeRequestPath(value) { return String(value || '').replace(/^request\./, 'body.'); }
function schemaLeaves(schema, prefix = '', inheritedRequired = true) { if (!schema || typeof schema !== 'object') return []; if (schema.type === 'object') { const required = new Set(schema.required || []); return Object.entries(schema.properties || {}).flatMap(([key, child]) => schemaLeaves(child, prefix ? `${prefix}.${key}` : key, inheritedRequired && required.has(key))); } if (schema.type === 'array') return [{ path: prefix, required: inheritedRequired, schema }]; return prefix ? [{ path: prefix, required: inheritedRequired, schema }] : []; }
function schemaFromFields(fields) { return { type: 'object', required: fields, properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])) }; }
function slug(value) { return String(value).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase(); }
function capabilityRequiresServerOperation(capability, integrationCapabilityIds, permissionCapabilityIds) { return capability.presentation?.behavior === 'server-operation' || capability.writesState === true || (capability.entityEffects || []).length > 0 || (capability.operations || []).length > 0 || integrationCapabilityIds.has(capability.id) || permissionCapabilityIds.has(capability.id) || (capability.capabilityIntent?.sideEffects || []).length > 0; }
function verifyHandoffLock(dir, lock, errors) {
  const expected = [...protectedHandoffFiles, ...(existsSync(`${dir}/web`) ? ['web'] : [])].sort();
  const actual = Object.keys(lock.digests || {}).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) errors.push('handoff lock file set mismatch');
  for (const file of protectedHandoffFiles) {
    if (!lock.digests?.[file]) { errors.push(`handoff lock is missing digest: ${file}`); continue; }
    if (existsSync(`${dir}/${file}`) && sha(readFileSync(`${dir}/${file}`)) !== lock.digests[file]) errors.push(`handoff lock mismatch: ${file}`);
  }
  if (existsSync(`${dir}/web`) && lock.digests?.web !== hashHandoffTree(`${dir}/web`)) errors.push('handoff lock mismatch: web');
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJSON(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function parseArgs(values) { const result = {}; for (let i = 0; i < values.length; i++) if (values[i].startsWith('--')) { result[values[i].slice(2)] = values[i + 1]; i++; } return result; }
function usage() { console.error('Usage: prepare-implementation.mjs --functional <dir> --handoff <dir> --output <dir>'); process.exit(2); }
