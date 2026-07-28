#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { bindVisualRelease, verifyVisualRelease } from './lib/visual-release.mjs';
import { extractFrontendSemantics } from './lib/frontend-semantics.mjs';
import { buildEvidenceIndex } from './lib/evidence-index.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.output || !args['author-agent'] || !args['visual-release'] || !args.designs) usage();
if (args.schema && args.schema !== '2.3') throw new Error('only functional-domain schema 2.3 is supported');
if (args.profile) throw new Error('product profiles are not supported; author domain semantics from the approved evidence');

const input = resolve(args.input);
const output = resolve(args.output);
const pageDocument = readKnownJSON(input, ['pageTree.json', 'page-architecture.json']);
const system = readKnownJSON(input, ['systemArchitecture.json', 'system-architecture.json']);
const product = readKnownJSON(input, ['product-context.json']);
const visual = verifyVisualRelease(args['visual-release']);
const decisionsDocument = args.decisions ? JSON.parse(readFileSync(resolve(args.decisions), 'utf8')) : null;
const decisions = normalizeDecisions(decisionsDocument);
const pages = pageDocument.nodes || [];
if (!pages.length || !Array.isArray(system.nodes) || !product.name) throw new Error('the three architecture JSON documents are incomplete');

const projectId = product.projectId || `project-${stableId(product.name)}`;
const frontend = extractFrontendSemantics(visual);
mkdirSync(output, { recursive: true });
const designs = buildDesignManifest(resolve(args.designs), output, new Set(pages.map((page) => page.id)));
const designDigest = digest(designs);
const synthesisInputDigest = digest({ pageDocument, system, product, visualReleaseDigest: visual.releaseDigest, decisions: decisionsDocument, designManifest: designs });
const visualAlignment = assessVisualAlignment(pages, visual, product);
const unresolved = [...visualAlignment.findings, ...(frontend.unresolved || [])];

// Schema 2.3: the scaffold synthesizes no capability and classifies no architecture leaf. It seeds the
// control-disposition ledger with every interaction control as `unresolved` (a candidate hint may accompany
// it, but the disposition is the author's), and emits advisory grouping candidates. The author agent reads
// each page's interaction closures, creates one capability per closure, and dispositions every control.
const controlDispositions = [];
for (const page of frontend.inventory.pages || []) for (const control of page.controls || []) {
  controlDispositions.push({
    controlId: control.controlId,
    pageId: page.pageId,
    disposition: 'unresolved',
    candidateDisposition: candidateDisposition(control),
    kind: control.kind || null,
    label: control.label || null,
    regionId: control.region?.id || null,
    evidence: { status: 'observed', sources: [`frontend-page:${page.pageId}`, `frontend-control:${control.controlId}`] },
  });
}
const groupingCandidates = buildGroupingCandidates(frontend);

for (const decision of decisions) unresolved.push({ id: `decision-${decision.id}`, severity: 'minor', status: 'open', disposition: 'authoring-input', question: `Apply user decision ${decision.id} during domain authoring`, relatedIds: [decision.targetId].filter(Boolean), sources: [`user-decision:${decision.id}`] });

const spec = {
  schemaVersion: '2.3',
  project: { id: projectId, name: product.name, brief: product.brief, goals: product.goals || [], users: product.users || [], needs: product.needs || [], problemStatement: product.brief || product.goals?.[0], evidence: { status: 'documented', sources: ['product-context:brief', 'product-context:goals', 'product-context:users', 'product-context:needs'] } },
  architecture: { pageVersion: pageDocument.version || 1, systemVersion: system.version || 1, sources: ['page architecture', 'system architecture', 'product context', 'immutable frontend release', ...(decisions.length ? ['user business decisions'] : [])], visualAlignment },
  domains: [], entities: [], valueObjects: [], relationships: [], consistencyBoundaries: [], capabilities: [], journeys: [], rules: [], permissions: [], integrations: [],
  visualSource: { sourceType: 'ai-restore-release', releaseDigest: visual.releaseDigest, suiteGateDigest: visual.suiteGateDigest, pageIds: visual.pages, routes: visual.routes, sourceTreeDigest: visual.sourceTreeDigest },
};
const semanticArtifacts = ['frontend-semantic-inventory.json', 'observed-interactions.json', 'control-capability-map.json', 'asset-role-inventory.json'];
const planningArtifacts = ['design-manifest.json', 'evidence-index.json', 'evidence-dispositions.json', 'control-dispositions.json', 'planning-artifacts.json', 'capability-definitions.json', ...semanticArtifacts];
const groups = ['capabilities', 'entities', 'valueObjects', 'relationships', 'consistencyBoundaries', 'journeys', 'rules', 'permissions', 'integrations'];

writeJSON(`${output}/evidence-index.json`, buildEvidenceIndex({ pageDocument, system, product, observedInteractions: frontend.interactions, designs, releaseDigest: visual.releaseDigest, synthesisInputDigest }));
writeJSON(`${output}/evidence-dispositions.json`, { schemaVersion: '1.0', dispositions: [] });
writeJSON(`${output}/control-dispositions.json`, { schemaVersion: '1.0', releaseDigest: visual.releaseDigest, dispositions: controlDispositions });
writeJSON(`${output}/grouping-candidates.json`, { schemaVersion: '1.0', releaseDigest: visual.releaseDigest, role: 'advisory-hint', groups: groupingCandidates });
writeJSON(`${output}/frontend-semantic-inventory.json`, frontend.inventory);
writeJSON(`${output}/observed-interactions.json`, frontend.interactions);
writeJSON(`${output}/control-capability-map.json`, { schemaVersion: '1.0', releaseDigest: visual.releaseDigest, mappings: [] });
writeJSON(`${output}/asset-role-inventory.json`, frontend.assets);
writeJSON(`${output}/planning-manifest.json`, { schemaVersion: '2.3', packageType: 'fdd-bmad-planning', status: 'authoring-pending', authorAgentId: args['author-agent'], synthesisInputDigest, inputDigests: { pageArchitecture: digest(pageDocument), systemArchitecture: digest(system), productContext: digest(product), visualRelease: visual.releaseDigest, designs: designDigest, userDecisions: decisionsDocument ? digest(decisionsDocument) : null }, artifacts: planningArtifacts });
writeJSON(`${output}/planning-artifacts.json`, { schemaVersion: '2.3', method: 'evidence-workspace', evidencePriority: ['confirmed', 'documented', 'observed', 'designed', 'inferred', 'blocked'], phases: [
  { id: 'project-understanding', status: 'completed', outputs: { project: spec.project, evidenceIndex: 'evidence-index.json', frontendSemanticInventory: 'frontend-semantic-inventory.json' } },
  { id: 'requirements-analysis', status: 'authoring-pending', outputs: { controlDispositions: 'control-dispositions.json', seededControlCount: controlDispositions.length, groupingCandidates: 'grouping-candidates.json', observedInteractions: 'observed-interactions.json' } },
  { id: 'domain-design', status: 'authoring-pending', outputs: {} },
  { id: 'independent-domain-review', status: 'pending', outputs: {} },
] });
writeJSON(`${output}/capability-definitions.json`, { schemaVersion: '2.3', generatedBy: 'functional-domain-design/evidence-workspace', ...Object.fromEntries(groups.map((group) => [group, spec[group] || []])) });
writeJSON(`${output}/manifest.json`, { schemaVersion: '2.3', packageType: 'functional-domain', projectId, projectName: product.name, status: 'draft', authoringStatus: 'pending', authorAgentId: args['author-agent'], sourceDirectory: basename(input), sourceContract: { requiredFiles: ['page architecture JSON', 'system architecture JSON', 'product context JSON', 'finalized design export directory', 'AI Restore release'], optionalFiles: decisions.length ? ['user business decisions JSON'] : [] }, planning: { manifest: 'planning-manifest.json', artifacts: 'planning-artifacts.json', capabilityDefinitions: 'capability-definitions.json', designManifest: 'design-manifest.json' }, evidenceIndex: 'evidence-index.json', semanticArtifacts, controlDispositions: 'control-dispositions.json', capabilitySummary: { total: 0, complete: 0, planned: 0, blockedCapabilities: 0, openBlockers: unresolved.filter((item) => item.severity === 'blocker').length } });
writeJSON(`${output}/functional-spec.json`, spec);
writeJSON(`${output}/page-function-map.json`, { schemaVersion: '2.3', pages: pages.map((page) => ({ pageId: page.id, title: page.title, navigationOnly: page.nav === true, capabilityIds: [] })) });
writeJSON(`${output}/unresolved-items.json`, { schemaVersion: '2.3', items: unresolved });
bindVisualRelease(output, args['visual-release']);
console.log(`Scaffolded schema 2.3 evidence workspace (${controlDispositions.length} controls seeded unresolved, ${groupingCandidates.length} grouping candidates, ${visualAlignment.matchedPageIds.length} aligned pages) -> ${output}`);

// Candidate disposition is an advisory hint only; the seed stays `unresolved` and the author decides. Derived
// from structured control facts (submission role, kind, semantic role) — never from labels or DOM proximity.
function candidateDisposition(control) {
  const kind = String(control.kind || '').toLowerCase();
  const semanticRole = String(control.semanticRole || '').toLowerCase();
  if (control.submissionRole === 'primary-submit') return 'primary-trigger';
  if (['navigation', 'history-entry'].includes(semanticRole) || kind === 'link') return 'navigation';
  if (['input', 'select', 'textarea', 'checkbox', 'radio'].includes(kind) || control.nativeType === 'file') return 'input';
  if (kind === 'button') return 'secondary-action';
  return 'presentation-only';
}

// Advisory grouping candidates: for each page, pair a candidate primary trigger with the input controls that
// share its container and the page's result surfaces. Computed from structured facts (submission scope/form,
// observed submit, result surfaces); it is a hint, never a decided closure. The author confirms/splits/merges.
function buildGroupingCandidates(frontend) {
  const interactions = frontend.interactions?.interactions || [];
  const groups = [];
  for (const page of frontend.inventory.pages || []) {
    const controls = page.controls || [];
    const observedSubmit = (controlId) => interactions.some((item) => item.pageId === page.pageId && item.controlId === controlId && item.submissionRole === 'primary-submit');
    const triggers = controls.filter((control) => control.submissionRole === 'primary-submit' || observedSubmit(control.controlId));
    for (const trigger of triggers) {
      const scope = trigger.submissionScopeId || trigger.formId || null;
      const inputs = controls.filter((control) => control.controlId !== trigger.controlId && ['input', 'select', 'textarea', 'checkbox', 'radio'].includes(String(control.kind).toLowerCase()) && (!scope || control.submissionScopeId === scope || control.formId === scope));
      groups.push({
        candidateId: `group-${page.pageId}-${trigger.controlId}`,
        pageId: page.pageId,
        candidatePrimaryTrigger: trigger.controlId,
        candidateInputControlIds: inputs.map((control) => control.controlId),
        candidateResultSurfaceIds: (page.resultSurfaces || []).map((surface) => surface.surfaceId),
        basis: [scope ? 'submission-scope' : 'page-scope', trigger.submissionRole === 'primary-submit' ? 'submission-role' : 'observed-submit'],
        note: 'Advisory grouping hint; the author confirms, splits, or merges from evidence. Not a decided closure.',
      });
    }
  }
  return groups;
}

function assessVisualAlignment(architecturePages, release, context) { const architecturePageIds = architecturePages.map((page) => page.id); const navigationOnlyPageIds = architecturePages.filter((page) => page.nav === true).map((page) => page.id); const visualRequiredPageIds = architecturePages.filter((page) => page.nav !== true).map((page) => page.id); const visualPageIds = release.pages || []; const matchedPageIds = visualRequiredPageIds.filter((id) => visualPageIds.includes(id)); const missingArchitecturePageIds = visualRequiredPageIds.filter((id) => !visualPageIds.includes(id)); const unexpectedVisualPageIds = visualPageIds.filter((id) => !architecturePageIds.includes(id)); const routeMismatches = matchedPageIds.filter((id) => !release.routes[id] || !String(release.routes[id]).includes(id)); const findings = []; if (visualRequiredPageIds.length && !matchedPageIds.length) findings.push({ id: 'visual-release-product-mismatch', severity: 'blocker', status: 'open', question: 'The immutable frontend release has no visually required page identity in common with the architecture', relatedIds: [...visualRequiredPageIds, ...visualPageIds], sources: ['page-architecture:nodes', `visual-release:${release.releaseDigest}`] }); for (const pageId of missingArchitecturePageIds) findings.push({ id: `visual-release-missing-page-${pageId}`, severity: 'blocker', status: 'open', question: `Visually required architecture page ${pageId} is absent from the immutable frontend release`, relatedIds: [pageId], sources: [`page:${pageId}`, `visual-release:${release.releaseDigest}`] }); for (const pageId of routeMismatches) findings.push({ id: `visual-release-route-mismatch-${pageId}`, severity: 'blocker', status: 'open', question: `Frontend route for ${pageId} does not preserve the architecture page identity`, relatedIds: [pageId], sources: [`frontend-page:${pageId}`, `visual-release:${release.releaseDigest}`] }); if (unexpectedVisualPageIds.length && (matchedPageIds.length || !visualRequiredPageIds.length)) findings.push({ id: 'visual-release-extra-pages', severity: 'blocker', status: 'open', question: 'The immutable frontend release contains pages not declared by the architecture', relatedIds: unexpectedVisualPageIds, sources: ['page-architecture:nodes', `visual-release:${release.releaseDigest}`] }); return { status: findings.some((item) => item.severity === 'blocker') ? 'blocked' : 'aligned', productId: context.projectId || null, suiteId: release.manifest.suiteId || null, architecturePageIds, navigationOnlyPageIds, visualRequiredPageIds, visualPageIds, matchedPageIds, missingArchitecturePageIds, unexpectedVisualPageIds, routeMismatches, coverage: visualRequiredPageIds.length ? matchedPageIds.length / visualRequiredPageIds.length : 1, findings }; }
function normalizeDecisions(value) { if (!value) return []; const items = Array.isArray(value) ? value : value.decisions || value.items || []; return items.map((item, index) => ({ id: item.id || `decision-${index + 1}`, ...item })); }
function stableId(value) { return [...String(value)].reduce((hash, char) => Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0, 2166136261).toString(16); }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function readKnownJSON(dir, names) { for (const name of names) { try { return JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } } throw new Error(`missing required architecture JSON: ${names.join(' or ')}`); }
function writeJSON(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function parseArgs(values) { const result = {}; for (let index = 0; index < values.length; index++) if (values[index].startsWith('--')) result[values[index].slice(2)] = values[++index]; return result; }
// The design input is a finalized-export directory: one selected design per page (named by page id), with an
// optional designBoard.json recording the selection provenance. Only these upstream-selected exports are
// indexed; exploration proposals never enter. Mechanical only — copy each file, hash it, take the page hint
// from the filename; no pixel is read here (that belongs to the authoring vision-mind).
function buildDesignManifest(designDir, outputDir, pageIds) {
  const boardPath = `${designDir}/designBoard.json`;
  const provenance = existsSync(boardPath) ? { source: 'designBoard.json', selection: JSON.parse(readFileSync(boardPath, 'utf8')) } : { source: 'design-export-directory' };
  mkdirSync(`${outputDir}/designs`, { recursive: true });
  const candidates = readdirSync(designDir).filter((name) => name !== 'designBoard.json');
  const unsupported = candidates.filter((name) => !['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(extname(name).toLowerCase()) || !lstatSync(`${designDir}/${name}`).isFile());
  if (unsupported.length) throw new Error(`design export contains unsupported or non-regular files: ${unsupported.join(', ')}`);
  if (!candidates.length) throw new Error('design export must contain at least one finalized PNG, JPEG, WebP, or SVG image');
  const images = candidates.sort().map((name) => {
    const source = `${designDir}/${name}`; const bytes = readFileSync(source);
    cpSync(`${designDir}/${name}`, `${outputDir}/designs/${name}`);
    const id = name.replace(/\.[^.]+$/, '');
    if (!pageIds.has(id)) throw new Error(`design pageHint does not match an architecture page: ${id}`);
    return { id, path: `designs/${name}`, sha256: createHash('sha256').update(bytes).digest('hex'), pageHint: id };
  });
  const manifest = { schemaVersion: '1.0', generatedBy: 'functional-domain-design/scaffold', provenance, images };
  writeFileSync(`${outputDir}/design-manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
function usage() { console.error('Usage: scaffold-package.mjs --input <three-json-directory> --designs <finalized-design-export-directory> --visual-release <ai-restore-release> --output <package-dir> --author-agent <stable-agent-id> [--decisions <user-business-decisions.json>]'); process.exit(2); }
