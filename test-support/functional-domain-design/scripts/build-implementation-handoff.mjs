#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { hashDirectory, interactiveControls, packageDigest, readJSON, sha, verifyVisualRelease } from './lib/visual-release.mjs';
import { presentationFindings } from './lib/presentation.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.functional || !args.output || !args['author-agent']) usage();
const functionalDir = resolve(args.functional); const output = resolve(args.output);
const manifest = readJSON(`${functionalDir}/manifest.json`); const spec = readJSON(`${functionalDir}/functional-spec.json`); const functionalLock = readJSON(`${functionalDir}/package-lock.json`);
if (manifest.status !== 'approved' || !existsSync(`${functionalDir}/review-receipt.json`)) throw new Error('functional package is not approved');
if (manifest.schemaVersion !== '2.3') throw new Error('implementation handoff can be built only from functional-domain schema 2.3');
const semanticFiles = ['frontend-semantic-inventory.json', 'observed-interactions.json', 'control-capability-map.json', 'asset-role-inventory.json'];
const functionalFiles = ['manifest.json', 'planning-manifest.json', 'planning-artifacts.json', 'capability-definitions.json', ...semanticFiles, 'functional-spec.json', 'page-function-map.json', 'unresolved-items.json', 'planning-review-receipt.json', 'review-receipt.json'];
for (const file of functionalFiles) if (!functionalLock.digests?.[file] || sha(readFileSync(`${functionalDir}/${file}`)) !== functionalLock.digests[file]) throw new Error(`functional package lock mismatch: ${file}`);
const inputMode = manifest.inputMode;
if (!['release-backed', 'design-led'].includes(inputMode)) throw new Error('functional package inputMode is invalid');
if (inputMode === 'release-backed' && !args['visual-release']) throw new Error('release-backed handoff requires --visual-release');
if (inputMode === 'design-led' && args['visual-release']) throw new Error('design-led handoff does not accept --visual-release; rebuild the FDD package in release-backed mode to use an immutable release baseline');
const functionalPackageDigest = packageDigest(functionalLock); const visual = inputMode === 'release-backed' ? verifyVisualRelease(args['visual-release']) : null;
if (visual && (manifest.visualReleaseDigest !== visual.releaseDigest || spec.visualSource?.releaseDigest !== visual.releaseDigest)) throw new Error('functional package visual release digest mismatch');
const capabilityStatus = new Map((spec.capabilities || []).map((item) => [item.id, item]));
for (const journey of (spec.journeys || []).filter((item) => item.core)) {
  const planned = (journey.capabilityIds || []).filter((id) => capabilityStatus.get(id)?.specificationStatus === 'planned');
  if (planned.length) throw new Error(planned.map((id) => `core journey ${journey.id} includes planned capability ${id} (${capabilityStatus.get(id)?.missingDecision?.missingBusinessDecision || capabilityStatus.get(id)?.planningReason || 'missing business decision'}); a core journey cannot be handed off with an unimplementable step`).join('\n'));
}
const uiPlan = (spec.capabilities || []).map((capability) => {
  const destination = capability.closure?.resultDestination; const resultContract = capability.specificationStatus === 'complete' ? capability.resultPresentation || (destination?.targetKind === 'region' ? { targetRegion: destination.targetRegion, bindings: destination.bindings, states: destination.states, runtimeFlow: destination.runtimeFlow } : null) : null;
  const presentation = resultContract ? { ...capability.presentation, surface: { ...(capability.presentation.surface || {}), contentContract: { ...(capability.presentation.surface?.contentContract || {}), resultContract } } } : capability.presentation;
  const findings = presentationFindings(capability.id, presentation, capability, { requireDeliveryPolicy: true });
  if (findings.length) throw new Error(findings.join('\n'));
  return { capabilityId: capability.id, specificationStatus: capability.specificationStatus, presentation, deliveryPolicy: capability.deliveryPolicy || { requiredForCompletion: true, allowedIncompleteState: 'planned' }, planningReason: capability.planningReason || null, missingDecisions: capability.missingDecisions || [], aliasOf: capability.aliasOf || null };
});
const semanticInventory = readJSON(`${functionalDir}/frontend-semantic-inventory.json`);
const visualControls = visual
  ? visual.pages.flatMap((pageId) => interactiveControls(visual.inventories[pageId]).map((control) => ({ pageId, ...control })))
  : (semanticInventory.pages || []).flatMap((page) => (page.controls || []).map((control) => ({ pageId: page.pageId, referenceId: control.referenceId || control.controlId, ...control })));
const operations = (spec.capabilities || []).flatMap((capability) => (capability.operations || []).map((operation) => {
  const normalized = { ...operation, capabilityId: capability.id, ruleIds: operation.ruleIds || capability.ruleIds || [] };
  if (normalized.assetTransfer) throw new Error(`operation ${normalized.id} uses unsupported assetTransfer; schema 2.3 requires resourceTransfer`);
  return normalized;
}));
mkdirSync(output, { recursive: true });
if (visual) { cpSync(visual.manifestPath, `${output}/release-manifest.json`); cpSync(`${visual.root}/payload/evidence/payload/suite-gate.json`, `${output}/suite-gate.json`); cpSync(`${visual.root}/payload/approval.json`, `${output}/visual-approval.json`); cpSync(visual.publicationRoot, `${output}/web`, { recursive: true }); }
cpSync(`${functionalDir}/functional-spec.json`, `${output}/functional-spec.json`);
for (const file of semanticFiles) cpSync(`${functionalDir}/${file}`, `${output}/${file}`);
const webDigest = visual ? hashDirectory(`${output}/web`) : null;
if (visual) writeJSON(`${output}/visual-source.json`, { schemaVersion: '1.0', sourceType: 'ai-restore-release', releaseManifest: 'release-manifest.json', suiteGate: 'suite-gate.json', approval: 'visual-approval.json', releaseDigest: visual.releaseDigest, suiteGateDigest: visual.suiteGateDigest, pageIds: visual.pages, routes: visual.routes, sourceTreeDigest: visual.sourceTreeDigest });
else writeJSON(`${output}/design-source.json`, { schemaVersion: '1.0', sourceType: 'finalized-design', designManifestDigest: spec.visualSource.designManifestDigest, pageIds: spec.visualSource.pageIds, routes: spec.visualSource.routes || {}, functionalDesignManifest: 'design-manifest.json' });
writeJSON(`${output}/frontend-manifest.json`, visual
  ? { schemaVersion: '1.0', status: 'visual-baseline', pages: Object.fromEntries(visual.pages.map((pageId) => [pageId, { route: visual.routes[pageId], status: 'baseline' }])), sourceTreeDigest: webDigest }
  : { schemaVersion: '1.0', status: 'implementation-required', pages: Object.fromEntries((semanticInventory.pages || []).map((page) => [page.pageId, { route: page.route || null, status: 'design-contract' }])), sourceTreeDigest: null });
writeJSON(`${output}/visual-controls.json`, { schemaVersion: '1.0', role: 'optional-reference', controls: visualControls });
writeJSON(`${output}/ui-implementation-plan.json`, { schemaVersion: '1.0', capabilities: uiPlan });
writeJSON(`${output}/api-contract.json`, { schemaVersion: '1.0', operations });
writeJSON(`${output}/domain-bindings.json`, { schemaVersion: semanticFiles.length ? '1.1' : '1.0', functionalPackageDigest, capabilityIds: (spec.capabilities || []).map((item) => item.id), completeCapabilityIds: (spec.capabilities || []).filter((item) => item.specificationStatus === 'complete').map((item) => item.id), plannedCapabilityIds: (spec.capabilities || []).filter((item) => item.specificationStatus === 'planned').map((item) => item.id), ruleIds: (spec.rules || []).map((item) => item.id), ...(semanticFiles.length ? { semanticArtifacts: semanticFiles } : {}) });
writeJSON(`${output}/runtime-contract.json`, { schemaVersion: '1.0', command: spec.runtime?.command || 'npm start', healthUrl: spec.runtime?.healthUrl || 'http://127.0.0.1:${PORT}/health', requiredEnvironment: spec.runtime?.requiredEnvironment || ['PORT'] });
writeJSON(`${output}/handoff-manifest.json`, { schemaVersion: '1.0', packageType: 'implementation-handoff', inputMode, status: 'draft', authorAgentId: args['author-agent'], functionalProjectId: manifest.projectId, functionalPackageDigest, ...(visual ? { visualReleaseDigest: visual.releaseDigest, sourceDirectory: basename(visual.root) } : { designManifestDigest: spec.visualSource.designManifestDigest, sourceDirectory: 'functional-domain/designs' }) });
if (manifest.schemaVersion === '2.3') {
  const anchorPages = (semanticInventory.pages || []).map((page) => {
    const seen = new Set(); const anchors = [];
    const add = (id, kind, source) => { const key = `${kind}:${id}`; if (!id || seen.has(key)) return; seen.add(key); anchors.push({ id, kind, source }); };
    for (const region of page.regions || []) add(region.regionId, 'region', 'frontend-semantic-inventory');
    for (const surface of page.resultSurfaces || []) add(surface.surfaceId, 'region', 'frontend-semantic-inventory');
    for (const control of visualControls.filter((item) => item.pageId === page.pageId)) add(control.referenceId, 'control', 'visual-controls');
    return { pageId: page.pageId, anchors };
  });
  writeJSON(`${output}/handoff-anchor-manifest.json`, { schemaVersion: '1.0', pages: anchorPages });
}
console.log(`Implementation handoff generated (${uiPlan.length} UI intents, ${operations.length} operations) -> ${output}`);
function writeJSON(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function parseArgs(values) { const result = {}; for (let i = 0; i < values.length; i++) if (values[i].startsWith('--')) result[values[i].slice(2)] = values[++i]; return result; }
function usage() { console.error('Usage: build-implementation-handoff.mjs --functional <approved-package> [--visual-release <ai-restore-release>] --output <handoff> --author-agent <id>'); process.exit(2); }
