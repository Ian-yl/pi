#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { bindVisualRelease, verifyVisualRelease } from './lib/visual-release.mjs';
import { extractFrontendSemantics } from './lib/frontend-semantics.mjs';
import { buildEvidenceIndex } from './lib/evidence-index.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.output || !args['author-agent'] || !args['visual-release']) usage();
if (args.schema && args.schema !== '2.2') throw new Error('only functional-domain schema 2.2 is supported');
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
const synthesisInputDigest = digest({ pageDocument, system, product, visualReleaseDigest: visual.releaseDigest, decisions: decisionsDocument });
const systemBySource = new Map((system.nodes || []).filter((item) => item.sourceModuleId).map((item) => [`${item.sourcePageId}:${item.sourceModuleId}`, item]));
const visualAlignment = assessVisualAlignment(pages, visual, product);
const unresolved = [...visualAlignment.findings, ...(frontend.unresolved || [])];
const leafClassifications = pages.flatMap((page) => (page.modules || []).flatMap((module) => (module.children || []).map((item) => classifyArchitectureLeaf(page, module, item))));
const skeletons = [];
const skeletonControlMap = [];

for (const page of pages) for (const module of page.modules || []) for (const item of module.children || []) {
  const classification = classifyArchitectureLeaf(page, module, item);
  if (!['business-capability', 'operation'].includes(classification.classification) && !classification.embeddedOperations.length) continue;
  const name = cleanName(item.name);
  const id = `cap-${page.id}-${item.id}`;
  const systemNode = systemBySource.get(`${page.id}:${item.id}`);
  const anchors = [...new Set([
    `page:${page.id}`,
    `page-module:${module.id}`,
    `page-module:${item.id}`,
    ...(String(item.name || '').includes('#') ? [`annotation:${item.id}`] : []),
    ...(systemNode ? [`system-node:${systemNode.id}`] : []),
  ])];
  const control = findArchitectureControl(page.id, item.id);
  skeletons.push({
    id,
    name,
    pageIds: [page.id],
    actor: 'user',
    specificationStatus: 'draft-pending-authoring',
    synthesisAnalysis: {
      classifierRole: 'candidate-hint',
      candidateClassification: classification.classification,
      candidatePattern: candidatePattern(name, control),
      confidence: 'unassessed',
      sourceModuleId: item.id,
      sourceContainerModuleId: module.id,
      sourceArchitectureLeafId: item.id,
      embeddedOperationHints: classification.embeddedOperations,
      observedTriggerControlId: control?.controlId || null,
      note: 'Candidate hint only; the author agent must close semantics from anchored evidence.',
    },
    evidenceAnchors: anchors,
  });
  skeletonControlMap.push({ capabilityId: id, pageId: page.id, controlId: null, observedTriggerControlId: control?.controlId || null, mappingType: 'pending-authoring', fieldBindings: [], primaryOperationId: null, evidence: { status: 'designed', sources: anchors } });
}

for (const decision of decisions) unresolved.push({ id: `decision-${decision.id}`, severity: 'minor', status: 'open', disposition: 'authoring-input', question: `Apply user decision ${decision.id} during domain authoring`, relatedIds: [decision.targetId].filter(Boolean), sources: [`user-decision:${decision.id}`] });

const spec = {
  schemaVersion: '2.2',
  project: { id: projectId, name: product.name, brief: product.brief, goals: product.goals || [], users: product.users || [], needs: product.needs || [], problemStatement: product.brief || product.goals?.[0], evidence: { status: 'documented', sources: ['product-context:brief', 'product-context:goals', 'product-context:users', 'product-context:needs'] } },
  architecture: { pageVersion: pageDocument.version || 1, systemVersion: system.version || 1, sources: ['page architecture', 'system architecture', 'product context', 'immutable frontend release', ...(decisions.length ? ['user business decisions'] : [])], visualAlignment, leafClassifications },
  domains: [], entities: [], valueObjects: [], relationships: [], consistencyBoundaries: [], capabilities: skeletons, journeys: [], rules: [], permissions: [], integrations: [],
  visualSource: { sourceType: 'ai-restore-release', releaseDigest: visual.releaseDigest, suiteGateDigest: visual.suiteGateDigest, pageIds: visual.pages, routes: visual.routes, sourceTreeDigest: visual.sourceTreeDigest },
};
const semanticArtifacts = ['frontend-semantic-inventory.json', 'observed-interactions.json', 'control-capability-map.json', 'asset-role-inventory.json'];
const groups = ['capabilities', 'entities', 'valueObjects', 'relationships', 'consistencyBoundaries', 'journeys', 'rules', 'permissions', 'integrations'];

mkdirSync(output, { recursive: true });
writeJSON(`${output}/evidence-index.json`, buildEvidenceIndex({ pageDocument, system, product, observedInteractions: frontend.interactions, releaseDigest: visual.releaseDigest, synthesisInputDigest }));
writeJSON(`${output}/evidence-dispositions.json`, { schemaVersion: '1.0', dispositions: [] });
writeJSON(`${output}/frontend-semantic-inventory.json`, frontend.inventory);
writeJSON(`${output}/observed-interactions.json`, frontend.interactions);
writeJSON(`${output}/control-capability-map.json`, { schemaVersion: '1.0', releaseDigest: visual.releaseDigest, mappings: skeletonControlMap });
writeJSON(`${output}/asset-role-inventory.json`, frontend.assets);
writeJSON(`${output}/planning-manifest.json`, { schemaVersion: '2.2', packageType: 'fdd-bmad-planning', status: 'authoring-pending', authorAgentId: args['author-agent'], synthesisInputDigest, inputDigests: { pageArchitecture: digest(pageDocument), systemArchitecture: digest(system), productContext: digest(product), visualRelease: visual.releaseDigest, userDecisions: decisionsDocument ? digest(decisionsDocument) : null }, artifacts: ['evidence-index.json', 'evidence-dispositions.json', 'planning-artifacts.json', 'capability-definitions.json', ...semanticArtifacts] });
writeJSON(`${output}/planning-artifacts.json`, { schemaVersion: '2.2', method: 'skeleton-index', evidencePriority: ['confirmed', 'documented', 'observed', 'designed', 'inferred', 'blocked'], phases: [
  { id: 'project-understanding', status: 'completed', outputs: { project: spec.project, evidenceIndex: 'evidence-index.json', frontendSemanticInventory: 'frontend-semantic-inventory.json' } },
  { id: 'requirements-analysis', status: 'authoring-pending', outputs: { capabilitySkeletonIds: skeletons.map((item) => item.id), architectureLeafClassifications: leafClassifications, observedInteractions: 'observed-interactions.json' } },
  { id: 'domain-design', status: 'authoring-pending', outputs: {} },
  { id: 'independent-domain-review', status: 'pending', outputs: {} },
] });
writeJSON(`${output}/capability-definitions.json`, { schemaVersion: '2.2', generatedBy: 'functional-domain-design/skeleton', ...Object.fromEntries(groups.map((group) => [group, spec[group] || []])) });
writeJSON(`${output}/manifest.json`, { schemaVersion: '2.2', packageType: 'functional-domain', projectId, projectName: product.name, status: 'draft', authoringStatus: 'pending', authorAgentId: args['author-agent'], sourceDirectory: basename(input), sourceContract: { requiredFiles: ['page architecture JSON', 'system architecture JSON', 'product context JSON', 'AI Restore release'], optionalFiles: decisions.length ? ['user business decisions JSON'] : [] }, planning: { manifest: 'planning-manifest.json', artifacts: 'planning-artifacts.json', capabilityDefinitions: 'capability-definitions.json' }, evidenceIndex: 'evidence-index.json', semanticArtifacts, capabilitySummary: { total: skeletons.length, complete: 0, planned: 0, draftPendingAuthoring: skeletons.length, blockedCapabilities: 0, openBlockers: unresolved.filter((item) => item.severity === 'blocker').length } });
writeJSON(`${output}/functional-spec.json`, spec);
writeJSON(`${output}/page-function-map.json`, { schemaVersion: '2.2', pages: pages.map((page) => ({ pageId: page.id, title: page.title, navigationOnly: page.parentId === null, capabilityIds: skeletons.filter((item) => item.pageIds.includes(page.id)).map((item) => item.id) })) });
writeJSON(`${output}/unresolved-items.json`, { schemaVersion: '2.2', items: unresolved });
bindVisualRelease(output, args['visual-release']);
console.log(`Scaffolded schema 2.2 skeleton (${skeletons.length} capability shells pending authoring, ${visualAlignment.matchedPageIds.length} aligned pages) -> ${output}`);

function classifyArchitectureLeaf(page, module, item) {
  const name = cleanName(item.name); const moduleName = cleanName(module.name); let classification;
  if (module.submissionRole === 'input-section' || item.submissionRole === 'input-section') classification = 'input-field';
  else if (item.submissionRole === 'primary-submit') classification = 'business-capability';
  else if (/上传|upload|attach|import/i.test(name)) classification = 'operation';
  else if (/模块导航|页面导航|入口/.test(moduleName)) classification = 'navigation';
  else if (/功能列表|能力列表|菜单/.test(moduleName)) classification = /历史|记录/.test(name) ? 'operation' : 'business-capability';
  else if (/创作结果|结果展示|结果/.test(moduleName)) classification = /下载|重新生成|重试/.test(name) ? 'operation' : /点击|放大|缩小|切换/.test(name) ? 'local-control' : 'display-requirement';
  else if (hasOperationSignal(name, item)) classification = 'operation';
  else if (/状态|进度|成功|失败|空状态|加载/.test(name)) classification = 'state';
  else classification = 'input-field';
  return { pageId: page.id, moduleId: module.id, leafId: item.id, name, classification, embeddedOperations: extractEmbeddedOperations(item), evidence: [`page:${page.id}`, `page-module:${module.id}`, `page-module:${item.id}`] };
}
function candidatePattern(name, control) { if (/上传|upload|attach|import/i.test(name) || control?.kind === 'file') return 'upload'; if (/下载|download|export/i.test(name)) return 'download'; if (/历史|记录|history|list/i.test(name)) return 'history'; if (/查询|查看|search|query/i.test(name)) return 'query'; if (/重新|重试|retry|regenerate/i.test(name)) return 'retry'; if (/删除|delete|移除|remove/i.test(name)) return 'delete'; if (/更新|编辑|修改|update|edit/i.test(name)) return 'update'; if (/新建|创建|提交|保存|create|submit|save/i.test(name)) return 'create'; return 'unclassified'; }
function hasOperationSignal(name, item) { return /新建|创建|提交|保存|上传|下载|删除|更新|查询|重试|取消|发送|执行|create|submit|save|upload|download|delete|update|query|retry|cancel|send|execute/i.test(name) || ['action', 'command', 'operation'].includes(item.kind || item.type); }
function extractEmbeddedOperations(item) { const annotation = String(item.name || '').split('#').slice(1).join('#'); const labels = []; for (const pattern of [/有(?:一|个)?([^，,。]{1,40}?)按钮/g, /可以一键([^，,。]{1,40})/g, /根据([^，,。]{1,40}?)生成([^，,。]{1,40})/g]) for (const match of annotation.matchAll(pattern)) labels.push(match[0].replace(/^可以/, '').trim()); return [...new Set(labels)].map((label) => ({ label, evidence: `page-module:${item.id}` })); }
function findArchitectureControl(pageId, itemId) { const page = frontend.inventory.pages.find((entry) => entry.pageId === pageId); return (page?.controls || []).find((control) => control.architectureItemId === itemId || control.sourceModuleId === itemId) || null; }
function assessVisualAlignment(architecturePages, release, context) { const architecturePageIds = architecturePages.map((page) => page.id); const visualPageIds = release.pages || []; const matchedPageIds = architecturePageIds.filter((id) => visualPageIds.includes(id)); const missingArchitecturePageIds = architecturePageIds.filter((id) => !visualPageIds.includes(id)); const unexpectedVisualPageIds = visualPageIds.filter((id) => !architecturePageIds.includes(id)); const routeMismatches = matchedPageIds.filter((id) => !release.routes[id] || !String(release.routes[id]).includes(id)); const findings = []; if (!matchedPageIds.length) findings.push({ id: 'visual-release-product-mismatch', severity: 'blocker', status: 'open', question: 'The immutable frontend release has no page identity in common with the architecture', relatedIds: [...architecturePageIds, ...visualPageIds], sources: ['page-architecture:nodes', `visual-release:${release.releaseDigest}`] }); for (const pageId of missingArchitecturePageIds) findings.push({ id: `visual-release-missing-page-${pageId}`, severity: 'blocker', status: 'open', question: `Architecture page ${pageId} is absent from the immutable frontend release`, relatedIds: [pageId], sources: [`page:${pageId}`, `visual-release:${release.releaseDigest}`] }); for (const pageId of routeMismatches) findings.push({ id: `visual-release-route-mismatch-${pageId}`, severity: 'blocker', status: 'open', question: `Frontend route for ${pageId} does not preserve the architecture page identity`, relatedIds: [pageId], sources: [`frontend-page:${pageId}`, `visual-release:${release.releaseDigest}`] }); if (unexpectedVisualPageIds.length && matchedPageIds.length) findings.push({ id: 'visual-release-extra-pages', severity: 'blocker', status: 'open', question: 'The immutable frontend release contains pages not declared by the architecture', relatedIds: unexpectedVisualPageIds, sources: ['page-architecture:nodes', `visual-release:${release.releaseDigest}`] }); return { status: findings.some((item) => item.severity === 'blocker') ? 'blocked' : 'aligned', productId: context.projectId || null, suiteId: release.manifest.suiteId || null, architecturePageIds, visualPageIds, matchedPageIds, missingArchitecturePageIds, unexpectedVisualPageIds, routeMismatches, coverage: architecturePageIds.length ? matchedPageIds.length / architecturePageIds.length : 0, findings }; }
function normalizeDecisions(value) { if (!value) return []; const items = Array.isArray(value) ? value : value.decisions || value.items || []; return items.map((item, index) => ({ id: item.id || `decision-${index + 1}`, ...item })); }
function cleanName(value = '') { return String(value).split('#')[0].trim(); }
function stableId(value) { return [...String(value)].reduce((hash, char) => Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0, 2166136261).toString(16); }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function readKnownJSON(dir, names) { for (const name of names) { try { return JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } } throw new Error(`missing required architecture JSON: ${names.join(' or ')}`); }
function writeJSON(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function parseArgs(values) { const result = {}; for (let index = 0; index < values.length; index++) if (values[index].startsWith('--')) result[values[index].slice(2)] = values[++index]; return result; }
function usage() { console.error('Usage: scaffold-package.mjs --input <three-json-directory> --visual-release <ai-restore-release> --output <package-dir> --author-agent <stable-agent-id> [--decisions <user-business-decisions.json>]'); process.exit(2); }
