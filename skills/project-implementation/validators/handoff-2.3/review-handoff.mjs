#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { digestJSON, hashDirectory, readJSON, sha } from './lib/visual-release.mjs';
import { presentationFindings } from './lib/presentation.mjs';
import { primarySubmitFindings } from './lib/primary-submit.mjs';
import { treeDigest } from './lib/validator-tree.mjs';

const args = parseArgs(process.argv.slice(2)); if (!args.handoff || !args['reviewer-agent']) usage();
const dir = resolve(args.handoff); const specPreview = readJSON(`${dir}/functional-spec.json`); if (specPreview.schemaVersion !== '2.3') throw new Error('only implementation-handoff schema 2.3 is supported'); const semanticFiles = ['frontend-semantic-inventory.json', 'observed-interactions.json', 'control-capability-map.json', 'asset-role-inventory.json']; const files = ['handoff-manifest.json', 'visual-source.json', 'release-manifest.json', 'suite-gate.json', 'visual-approval.json', 'frontend-manifest.json', 'functional-spec.json', ...semanticFiles, 'handoff-anchor-manifest.json', 'visual-controls.json', 'ui-implementation-plan.json', 'api-contract.json', 'domain-bindings.json', 'runtime-contract.json'];
for (const file of files) if (!existsSync(`${dir}/${file}`)) throw new Error(`handoff is missing ${file}`);
const manifest = readJSON(`${dir}/handoff-manifest.json`); const visual = readJSON(`${dir}/visual-source.json`); const release = readJSON(`${dir}/release-manifest.json`); const frontend = readJSON(`${dir}/frontend-manifest.json`); const spec = readJSON(`${dir}/functional-spec.json`); const plan = readJSON(`${dir}/ui-implementation-plan.json`); const api = readJSON(`${dir}/api-contract.json`); const gate = readJSON(`${dir}/suite-gate.json`); const approval = readJSON(`${dir}/visual-approval.json`); const bindings = readJSON(`${dir}/domain-bindings.json`);
const errors = [];
if (manifest.authorAgentId === args['reviewer-agent']) errors.push('handoff author and reviewer must differ');
const releaseCopy = { ...release }; delete releaseCopy.releaseDigest;
if (digestJSON(releaseCopy) !== release.releaseDigest || visual.releaseDigest !== release.releaseDigest || manifest.visualReleaseDigest !== release.releaseDigest) errors.push('handoff visual release digest mismatch');
if (gate.pass !== true || gate.gateDigest !== release.gateDigest || visual.suiteGateDigest !== release.gateDigest) errors.push('handoff Suite Gate is invalid');
if (approval.approvalDigest !== release.approvalDigest) errors.push('handoff visual approval digest mismatch');
const semanticInventory = semanticFiles.length ? readJSON(`${dir}/frontend-semantic-inventory.json`) : {}; const interactions = semanticFiles.length ? readJSON(`${dir}/observed-interactions.json`) : {}; const controlMap = semanticFiles.length ? readJSON(`${dir}/control-capability-map.json`) : {};
const assetInventory = semanticFiles.includes('asset-role-inventory.json') ? readJSON(`${dir}/asset-role-inventory.json`) : { assets: [] };
if (semanticFiles.length && (semanticInventory.release?.releaseDigest !== release.releaseDigest || interactions.releaseDigest !== release.releaseDigest || controlMap.releaseDigest !== release.releaseDigest)) errors.push('handoff frontend semantics are not bound to the visual release');
if (semanticFiles.includes('asset-role-inventory.json') && (assetInventory.releaseDigest !== release.releaseDigest || (assetInventory.assets || []).some((item) => !['decorative', 'business-sample'].includes(item.role) || !item.digest || (item.role === 'business-sample' && !item.requiredReplacement)))) errors.push('handoff asset roles are unclassified or not release-bound');
const copiedSourceDigest = hashDirectory(`${dir}/web`); if (frontend.sourceTreeDigest !== copiedSourceDigest || visual.sourceTreeDigest !== copiedSourceDigest) errors.push('handoff web source tree digest mismatch');
const capabilities = new Map((spec.capabilities || []).map((item) => [item.id, item])); const capabilityIds = new Set(capabilities.keys()); const ruleIds = new Set((spec.rules || []).map((item) => item.id));
errors.push(...primarySubmitFindings(spec, semanticInventory, interactions, controlMap));
const coreCapabilityIds = new Set((spec.journeys || []).filter((journey) => journey.core === true).flatMap((journey) => journey.capabilityIds || []));
if (bindings.functionalPackageDigest !== manifest.functionalPackageDigest || JSON.stringify([...capabilityIds].sort()) !== JSON.stringify([...(bindings.capabilityIds || [])].sort())) errors.push('handoff domain bindings mismatch');
const rawPlanIds = (plan.capabilities || []).map((item) => item.capabilityId); const planned = new Map((plan.capabilities || []).map((item) => [item.capabilityId, item.presentation]));
if (new Set(rawPlanIds).size !== rawPlanIds.length || JSON.stringify([...rawPlanIds].sort()) !== JSON.stringify([...capabilityIds].sort())) errors.push('UI capability plan must be an exact one-to-one set with the functional capabilities');
for (const capabilityId of capabilityIds) {
  const presentation = planned.get(capabilityId);
  errors.push(...presentationFindings(capabilityId, presentation, capabilities.get(capabilityId), { requireDeliveryPolicy: true }));
  if (presentation?.mode !== 'headless' && presentation?.targetPageId && !Object.hasOwn(frontend.pages || {}, presentation.targetPageId)) errors.push(`capability ${capabilityId} target page is absent from the visual release: ${presentation.targetPageId}`);
  const capability = capabilities.get(capabilityId); const mapping = (controlMap.mappings || []).find((item) => item.capabilityId === capabilityId);
  const uiContract = (plan.capabilities || []).find((item) => item.capabilityId === capabilityId);
  if (uiContract?.specificationStatus !== capability.specificationStatus) errors.push(`capability ${capabilityId} handoff status differs from the functional package`);
  if (capability.specificationStatus === 'planned' && (uiContract.deliveryPolicy?.requiredForCompletion !== false || uiContract.deliveryPolicy?.uiBehavior !== 'show-planned-state' || !uiContract.planningReason)) errors.push(`planned capability ${capabilityId} has no explicit planned delivery contract`);
  if (capability.specificationStatus === 'planned' && presentation?.mode === 'headless') errors.push(`planned capability ${capabilityId} cannot be headless`);
  if (capability.specificationStatus === 'planned' && (coreCapabilityIds.has(capabilityId) || capability.deliveryPolicy?.requiredForCompletion === true)) errors.push(`core capability ${capabilityId} cannot remain planned in an approved handoff`);
  if (semanticFiles.length && presentation?.mode !== 'headless' && !mapping) errors.push(`capability ${capabilityId} has no locked control mapping`);
  if (presentation?.primaryOperationId && !(capability.operations || []).some((operation) => operation.id === presentation.primaryOperationId)) errors.push(`capability ${capabilityId} primary operation is absent`);
  const destination = capability.closure?.resultDestination; const expectedResult = capability.specificationStatus === 'complete' ? capability.resultPresentation || (destination?.targetKind === 'region' ? { targetRegion: destination.targetRegion, bindings: destination.bindings, states: destination.states, runtimeFlow: destination.runtimeFlow } : null) : null;
  if (expectedResult && JSON.stringify(presentation?.surface?.contentContract?.resultContract) !== JSON.stringify(expectedResult)) errors.push(`capability ${capabilityId} result presentation contract was not preserved in the handoff`);
}
for (const capabilityId of planned.keys()) if (!capabilityIds.has(capabilityId)) errors.push(`UI implementation plan references unknown capability ${capabilityId}`);
const operationIds = new Set((api.operations || []).map((item) => item.id)); if (operationIds.size !== (api.operations || []).length) errors.push('API contract contains duplicate operation IDs');
const expectedOperationIds = new Set((spec.capabilities || []).filter((capability) => capability.specificationStatus === 'complete').flatMap((capability) => capability.operations || []).map((operation) => operation.id));
if (JSON.stringify([...operationIds].sort()) !== JSON.stringify([...expectedOperationIds].sort())) errors.push('handoff API operation set differs from the complete functional operation set');
const routes = new Map();
for (const operation of api.operations || []) {
  if (!operation.id || !operation.method || !operation.path) errors.push('API operation lacks id, method, or path');
  if (!capabilityIds.has(operation.capabilityId)) errors.push(`operation ${operation.id} references unknown capability ${operation.capabilityId}`);
  if (capabilities.get(operation.capabilityId)?.specificationStatus !== 'complete') errors.push(`operation ${operation.id} belongs to a non-complete capability`);
  for (const ruleId of operation.ruleIds || []) if (!ruleIds.has(ruleId)) errors.push(`operation ${operation.id} references unknown rule ${ruleId}`);
  if (!operation.request || typeof operation.request !== 'object' || !operation.request.contentType || !operation.response || typeof operation.response !== 'object' || !operation.response.bodySchema) errors.push(`operation ${operation.id} has incomplete request or response schema`);
  if (!operation.authorization || !operation.errors?.length || !operation.effects?.length) errors.push(`operation ${operation.id} lacks authorization, errors, or entity effects`);
  if (operation.request?.contentType === 'multipart/form-data' && (!operation.resourceTransfer?.fileField || !operation.resourceTransfer?.responseIdPath)) errors.push(`multipart operation ${operation.id} has no resourceTransfer contract`);
  const writes = !['GET', 'HEAD'].includes(String(operation.method).toUpperCase()); if (writes && (!operation.effects?.length || !operation.errors?.length)) errors.push(`write operation ${operation.id} lacks effects or errors`);
  const key = `${String(operation.method).toUpperCase()} ${operation.path}`; routes.set(key, [...(routes.get(key) || []), operation]);
}
for (const [route, group] of routes) if (group.length > 1) { const ds = group.map((item) => item.request?.discriminator); if (ds.some((item) => !item?.property || item.value === undefined) || new Set(ds.map((item) => `${item?.property}:${item?.value}`)).size !== group.length) errors.push(`shared HTTP operation ${route} has ambiguous dispatch`); }
if (errors.length) { if (!args['replay-only']) writeJSON(`${dir}/handoff-review-rejection.json`, { schemaVersion: '1.0', status: 'rejected', findings: errors }); console.error(errors.map((item) => `- ${item}`).join('\n')); process.exit(1); }
if (args['trusted-replay-only']) { console.log(`Trusted implementation handoff ${spec.schemaVersion} review passed`); process.exit(0); }
const trustedReviewerPath = resolve(import.meta.dirname, `../validators/handoff-${spec.schemaVersion}/review-handoff.mjs`);
const replay = spawnSync(process.execPath, [trustedReviewerPath, '--handoff', dir, '--reviewer-agent', args['reviewer-agent'], '--trusted-replay-only', 'true'], { encoding: 'utf8' });
if (replay.status !== 0) { console.error(replay.stderr || replay.stdout); process.exit(replay.status ?? 1); }
const receipt = { schemaVersion: '1.4', contractVersion: `implementation-handoff/${spec.schemaVersion}`, trustedReviewerId: `fdd-handoff-reviewer-${spec.schemaVersion}`, validatorDigest: treeDigest(resolve(trustedReviewerPath, '..')), status: 'approved', authorAgentId: manifest.authorAgentId, reviewerAgentId: args['reviewer-agent'], functionalPackageDigest: manifest.functionalPackageDigest, visualReleaseDigest: manifest.visualReleaseDigest, reviewedAt: new Date().toISOString() };
writeJSON(`${dir}/handoff-review-receipt.json`, receipt); manifest.status = 'approved'; manifest.approval = { reviewerAgentId: args['reviewer-agent'], reviewedAt: receipt.reviewedAt }; writeJSON(`${dir}/handoff-manifest.json`, manifest);
const protectedFiles = [...files, 'handoff-review-receipt.json']; const digests = Object.fromEntries(protectedFiles.map((file) => [file, sha(readFileSync(`${dir}/${file}`))])); digests.web = hashDirectory(`${dir}/web`);
writeJSON(`${dir}/handoff-lock.json`, { schemaVersion: '1.0', algorithm: 'sha256', functionalPackageDigest: manifest.functionalPackageDigest, visualReleaseDigest: manifest.visualReleaseDigest, sourceTreeDigest: digests.web, digests });
console.log(`Implementation handoff approved by ${args['reviewer-agent']}`);
function writeJSON(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function parseArgs(values) { const result = {}; for (let i = 0; i < values.length; i++) if (values[i].startsWith('--')) result[values[i].slice(2)] = values[++i]; return result; }
function usage() { console.error('Usage: review-implementation-handoff.mjs --handoff <dir> --reviewer-agent <id>'); process.exit(2); }
