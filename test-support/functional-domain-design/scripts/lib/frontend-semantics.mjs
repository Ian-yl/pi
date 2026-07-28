import { readFileSync, readdirSync } from 'node:fs';
import { extname } from 'node:path';
import { digestJSON, interactiveControls, sha } from './visual-release.mjs';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.html', '.vue', '.svelte', '.css', '.scss', '.sass', '.less']);

export function extractFrontendSemantics(visual) {
  const sources = walk(visual.publicationRoot)
    .filter((file) => SOURCE_EXTENSIONS.has(extname(file)))
    .map((file) => ({ path: file.slice(visual.publicationRoot.length + 1), text: readFileSync(file, 'utf8') }));
  const sourceText = sources.map((item) => item.text).join('\n');
  const pages = visual.pages.map((pageId) => {
    const inventory = visual.inventories[pageId] || {};
    const items = inventory.items || [];
    const controls = interactiveControls(inventory).map((control) => enrichControl(pageId, control, items, sourceText));
    return {
      pageId,
      route: visual.routes[pageId],
      regions: extractRegions(items),
      controls,
      resultSurfaces: items.filter(isResultSurface).map((item) => semanticItem(pageId, item)),
      visibleStates: extractVisibleStates(items, sourceText),
      evidence: evidence('observed', [`frontend-page:${pageId}`, `visual-release:${visual.releaseDigest}`]),
    };
  });
  const interactions = extractInteractions(sources, pages, visual.releaseDigest);
  const assetAnalysis = extractAssetRoles(visual.publicationRoot, sources, pages, visual.releaseDigest);
  return {
    inventory: {
      schemaVersion: '1.0',
      release: { releaseDigest: visual.releaseDigest, payloadManifestDigest: visual.manifest.payloadManifestDigest, sourceTreeDigest: visual.sourceTreeDigest, suiteGateDigest: visual.suiteGateDigest },
      pages,
      sourceSummary: sources.map((item) => ({ path: item.path, sha256: sha(Buffer.from(item.text)), bytes: Buffer.byteLength(item.text) })),
    },
    interactions: { schemaVersion: '1.0', releaseDigest: visual.releaseDigest, interactions },
    assets: { schemaVersion: '1.0', releaseDigest: visual.releaseDigest, assets: assetAnalysis.assets },
    unresolved: assetAnalysis.unresolved,
  };
}

function extractAssetRoles(root, sources, pages, releaseDigest) {
  const assets = []; const unresolved = []; const inventoryItems = pages.flatMap((page) => [...(page.resultSurfaces || []), ...(page.controls || [])]);
  for (const file of walk(root).filter((item) => !SOURCE_EXTENSIONS.has(extname(item)) && !['.json', '.map'].includes(extname(item)))) {
    const relativePath = file.slice(root.length + 1); const basename = relativePath.split('/').at(-1); const references = sources.flatMap((source) => referenceContexts(source, relativePath, basename));
    if (!references.length && !inventoryItems.some((item) => String(item.sourceAsset || item.selector || '').includes(basename))) continue;
    const context = references.map((item) => item.context).join(' '); const businessEvidence = /result|output|preview|history|record|product|material|upload|thumbnail|sample|fixture|结果|预览|历史|商品|素材|上传|样例/i.test(context); const decorativeEvidence = /logo|icon|background|decoration|ornament|avatar-shell|品牌|图标|背景|装饰/i.test(context) && !businessEvidence;
    const role = decorativeEvidence ? 'decorative' : 'business-sample'; const classificationStatus = decorativeEvidence || businessEvidence ? 'evidence-backed' : 'defaulted-fail-closed';
    const replacement = role === 'business-sample' ? (/upload|input|素材|上传/i.test(context) ? 'user-input' : /result|output|history|record|结果|历史/i.test(context) ? 'api-data' : 'empty-state') : null;
    const asset = { id: `asset-${sha(Buffer.from(relativePath)).slice(0, 16)}`, path: relativePath, digest: sha(readFileSync(file)), bytes: readFileSync(file).length, role, classificationStatus, ...(replacement ? { requiredReplacement: replacement } : {}), evidence: { status: classificationStatus === 'evidence-backed' ? 'observed' : 'inferred', sources: [...new Set([...references.map((item) => `frontend-source:${item.file}`), `visual-release:${releaseDigest}`])], rationale: decorativeEvidence ? 'Referenced only as visual chrome and carries no observed business-data meaning.' : businessEvidence ? 'Referenced in a business input, result, history, material, or sample context.' : 'No reliable decorative evidence exists; classified as business-sample by fail-closed policy.', candidateHint: /^(?:stage-|th-|up-)/i.test(basename) ? 'sample-name-pattern' : null } };
    assets.push(asset);
    if (classificationStatus === 'defaulted-fail-closed') unresolved.push({ id: `unresolved-asset-role-${asset.id}`, severity: 'minor', status: 'open', disposition: 'replace-business-sample', question: `Static asset ${relativePath} has no reliable decorative or business role evidence and is treated as business-sample`, relatedIds: [asset.id], sources: asset.evidence.sources });
  }
  const virtualReferences = new Map();
  for (const source of sources) {
    for (const match of source.text.matchAll(/(?:https?:\/\/[^\s"'`)]+|data:[^\s"')]+(?:;base64,[A-Za-z0-9+/=]+)?)/g)) {
      const value = match[0]; const key = value.startsWith('data:') ? `data:${sha(dataBytes(value))}` : value;
      const lineStart = source.text.lastIndexOf('\n', match.index) + 1; const lineEnd = source.text.indexOf('\n', match.index + value.length);
      const item = virtualReferences.get(key) || { value, references: [] };
      item.references.push({ file: source.path, context: source.text.slice(lineStart, lineEnd < 0 ? source.text.length : lineEnd) }); virtualReferences.set(key, item);
    }
  }
  for (const { value, references } of virtualReferences.values()) {
    const context = references.map((item) => item.context).join(' '); const classification = classifyAssetContext(context); const bytes = value.startsWith('data:') ? dataBytes(value) : Buffer.from(value);
    const asset = { id: `asset-${sha(Buffer.from(value)).slice(0, 16)}`, path: value, sourceType: value.startsWith('data:') ? 'data-uri' : 'remote-url', ...(value.startsWith('http') ? { sourceUrl: value } : {}), digest: sha(bytes), bytes: bytes.length, role: classification.role, classificationStatus: classification.status, ...(classification.replacement ? { requiredReplacement: classification.replacement } : {}), evidence: { status: classification.status === 'evidence-backed' ? 'observed' : 'inferred', sources: [...new Set([...references.map((item) => `frontend-source:${item.file}`), `visual-release:${releaseDigest}`])], rationale: classification.rationale } };
    assets.push(asset);
    if (classification.status === 'defaulted-fail-closed') unresolved.push({ id: `unresolved-asset-role-${asset.id}`, severity: 'minor', status: 'open', disposition: 'replace-business-sample', question: `${asset.sourceType} asset has no reliable decorative or business role evidence and is treated as business-sample`, relatedIds: [asset.id], sources: asset.evidence.sources });
  }
  return { assets, unresolved };
}
function classifyAssetContext(context) {
  const business = /result|output|preview|history|record|product|material|upload|thumbnail|sample|fixture|结果|预览|历史|商品|素材|上传|样例/i.test(context); const decorative = /logo|icon|background|decoration|ornament|avatar-shell|品牌|图标|背景|装饰/i.test(context) && !business;
  const role = decorative ? 'decorative' : 'business-sample'; const status = decorative || business ? 'evidence-backed' : 'defaulted-fail-closed'; const replacement = role === 'business-sample' ? (/upload|input|素材|上传/i.test(context) ? 'user-input' : /result|output|history|record|结果|历史/i.test(context) ? 'api-data' : 'empty-state') : null;
  return { role, status, replacement, rationale: decorative ? 'Referenced only as visual chrome and carries no observed business-data meaning.' : business ? 'Referenced in a business input, result, history, material, or sample context.' : 'No reliable decorative evidence exists; classified as business-sample by fail-closed policy.' };
}
function dataBytes(value) { const match = String(value).match(/^data:([^;,]+)?(;base64)?,(.*)$/s); if (!match) return Buffer.from(String(value)); return match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3])); }
function referenceContexts(source, relativePath, basename) {
  const result = [];
  for (const needle of [relativePath, basename]) {
    let offset = source.text.indexOf(needle);
    while (needle && offset >= 0) {
      const lineStart = source.text.lastIndexOf('\n', offset) + 1;
      const lineEnd = source.text.indexOf('\n', offset + needle.length);
      const tagStart = source.text.lastIndexOf('<', offset);
      const tagEnd = source.text.indexOf('>', offset + needle.length);
      const inSingleTag = tagStart >= lineStart && tagEnd >= 0 && tagEnd <= (lineEnd < 0 ? source.text.length : lineEnd);
      const previousTagStart = inSingleTag ? source.text.lastIndexOf('<', tagStart - 1) : -1;
      const contextStart = previousTagStart >= lineStart ? previousTagStart : inSingleTag ? tagStart : lineStart;
      result.push({ file: source.path, context: source.text.slice(contextStart, inSingleTag ? tagEnd + 1 : lineEnd < 0 ? source.text.length : lineEnd) });
      offset = source.text.indexOf(needle, offset + needle.length);
    }
  }
  return result;
}

function enrichControl(pageId, control, items, sourceText) {
  const item = items.find((candidate) => candidate.auditId === control.referenceId || candidate.id === control.referenceId || candidate.selector === control.selector) || {};
  const context = nearestContext(item, items);
  const text = clean(control.text || item.text || item.ariaLabel || item.placeholder);
  const sourceFragment = findSourceFragment(sourceText, text || item.placeholder || item.attrs?.dataVrId);
  // Per-control attributes come from the control's OWN element (its data-vr-id tag), not a wide character
  // window, so a neighbor's type/value/options never bleed onto this control. The structured inventory
  // attrs remain the first source of truth; the own element only fills what the inventory did not capture.
  const ownFragment = ownElement(sourceText, control.referenceId || item.auditId || item.id) || sourceFragment;
  return {
    controlId: control.referenceId || `observed-${pageId}-${control.referenceIndex}`,
    stableId: control.referenceId || null,
    pageId,
    kind: control.kind || item.kind || item.tag,
    nativeType: item.attrs?.type || extractAttribute(ownFragment, 'type'),
    fieldName: item.attrs?.name || extractAttribute(ownFragment, 'name') || null,
    formId: item.formId || item.attrs?.form || context?.formId || (['form'].includes(context?.tag || context?.kind) ? context.auditId || context.id : null),
    submissionScopeId: item.submissionScopeId || item.attrs?.dataSubmissionScope || context?.submissionScopeId || null,
    submissionRole: explicitSubmissionRole(item, sourceFragment),
    semanticRole: item.semanticRole || item.attrs?.dataSemanticRole || null,
    architectureItemId: item.architectureItemId || null,
    sourceModuleId: item.sourceModuleId || null,
    capabilityId: item.capabilityId || item.attrs?.dataCapabilityId || null,
    selector: control.selector || item.selector || null,
    label: text || clean(context?.text),
    placeholder: clean(item.placeholder),
    required: evidenceRequired(item, context),
    multiple: item.attrs?.multiple === true || /multiple|多图|多个/.test(ownFragment),
    accept: item.attrs?.accept || extractAttribute(ownFragment, 'accept'),
    defaultValue: extractDefault(ownFragment),
    options: extractSelectOptions(ownFragment),
    region: context ? { id: context.auditId || context.id, label: clean(context.text), selector: context.selector, semanticRole: context.semanticRole || context.attrs?.dataSemanticRole || null } : null,
    domPath: item.domPath || null,
    hierarchy: String(item.domPath || '').split('>').filter(Boolean),
    observedHandler: extractHandler(sourceFragment),
    sourceReference: sourceFragment ? { type: 'source-fragment', digest: sha(Buffer.from(sourceFragment)), excerpt: sourceFragment.slice(0, 300) } : null,
    evidence: evidence('observed', [`frontend-page:${pageId}`, `frontend-control:${control.referenceId || control.referenceIndex}`]),
  };
}

function extractInteractions(sources, pages, releaseDigest) {
  const controls = pages.flatMap((page) => page.controls);
  const result = [];
  for (const source of sources) {
    const patterns = [
      { kind: 'network', regex: /(?:fetch|axios\.(?:get|post|put|patch|delete))\s*\(([^\n;]{1,500})/g },
      { kind: 'submit', regex: /onSubmit\s*=\s*\{([^}]{1,600})\}/g },
      { kind: 'click', regex: /onClick\s*=\s*\{([^}]{1,600})\}/g },
      { kind: 'change', regex: /onChange\s*=\s*\{([^}]{1,600})\}/g },
    ];
    for (const pattern of patterns) for (const match of source.text.matchAll(pattern.regex)) {
      const excerpt = match[0];
      const nearby = source.text.slice(Math.max(0, match.index - 220), Math.min(source.text.length, match.index + excerpt.length + 220));
      const control = controls.find((item) => item.label && nearby.includes(item.label)) || null;
      result.push({
        id: `interaction-${result.length + 1}`,
        kind: pattern.kind,
        pageId: control?.pageId || inferPage(nearby, pages),
        controlId: control?.controlId || null,
        event: pattern.kind === 'network' ? 'request' : pattern.kind,
        submissionRole: pattern.kind === 'submit' || control?.submissionRole === 'primary-submit' ? 'primary-submit' : null,
        handlerSummary: clean(excerpt),
        stateReads: extractIdentifiers(excerpt, /\b(?:value|files|active|status|count|zoom|selected|input|data)\b/g),
        stateWrites: [...excerpt.matchAll(/set([A-Z][A-Za-z0-9_]*)\s*\(/g)].map((item) => lowerFirst(item[1])),
        network: pattern.kind === 'network' ? extractNetwork(excerpt) : null,
        source: { file: source.path, offset: match.index, digest: sha(Buffer.from(excerpt)) },
        evidence: evidence('observed', [`frontend-source:${source.path}`, `visual-release:${releaseDigest}`]),
      });
    }
  }
  return result;
}

function extractRegions(items) {
  return items.filter((item) => ['section', 'form', 'main', 'aside', 'container'].includes(item.kind) || ['section', 'form', 'main', 'aside'].includes(item.tag))
    .filter((item) => item.auditId || item.text || item.className)
    .map((item) => ({ regionId: item.auditId || item.id, kind: item.tag || item.kind, label: clean(item.text), selector: item.selector, parentPath: item.domPath }));
}
// Visible states are the processing/success/failure/empty surfaces a closure resolves its states against.
// When the state text sits inside a released region item, the state is associated with that region so the
// author can bind it to a result destination; otherwise it is recorded as a page-level observation.
function extractVisibleStates(items, sourceText) {
  const checks = [
    ['loading', /loading|加载中|处理中|提交中|generating|生成中/i],
    ['empty', /empty|暂无|空状态|尚无|no [a-z' ]*(?:result|history|data|item)|nothing/i],
    ['success', /success|成功|已完成|已提交|done|completed/i],
    ['error', /error|失败|异常|failed|余额不足/i],
  ];
  const states = [];
  for (const [id, regex] of checks) {
    const region = items.find((item) => (item.auditId || item.id) && regex.test(item.text || ''));
    if (region) states.push({ id, observed: true, regionId: region.auditId || region.id, source: 'region-text' });
    else if (regex.test(sourceText)) states.push({ id, observed: true, regionId: null, source: 'page-source' });
  }
  return states;
}
function semanticItem(pageId, item) { return { surfaceId: item.auditId || item.id, pageId, kind: item.kind, selector: item.selector, label: clean(item.text), sourceAsset: item.attrs?.src || null }; }
function isResultSurface(item) { return /result|preview|output|history|结果|预览|历史/i.test(`${item.auditId || ''} ${item.className || ''} ${item.text || ''}`); }
function nearestContext(item, items) { const path = String(item.domPath || ''); return [...items].filter((candidate) => candidate !== item && candidate.domPath && path.startsWith(candidate.domPath) && (candidate.text || candidate.auditId)).sort((a, b) => String(b.domPath).length - String(a.domPath).length)[0]; }
function evidenceRequired(item, context) { const text = `${item.text || ''} ${item.placeholder || ''} ${context?.text || ''}`; if (/非必填|可选|optional/i.test(text)) return false; if (/必填|必选|required/i.test(text) || item.attrs?.required === true) return true; return null; }
function findSourceFragment(text, needle) { if (!needle) return ''; const index = text.indexOf(String(needle)); return index < 0 ? '' : text.slice(Math.max(0, index - 350), Math.min(text.length, index + String(needle).length + 500)); }
// The control's own element: the single tag carrying its data-vr-id, plus the <option> block for a <select>.
// Attribute reads restricted to this string never pick up a neighboring control's type, value, or options.
function ownElement(sourceText, controlId) {
  if (!controlId) return '';
  const marker = new RegExp(`data-vr-id=["']?${String(controlId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?`);
  const found = marker.exec(sourceText);
  if (!found) return '';
  const open = sourceText.lastIndexOf('<', found.index);
  const close = sourceText.indexOf('>', found.index);
  if (open < 0 || close < 0) return '';
  const tagName = sourceText.slice(open + 1).match(/^\s*([a-zA-Z0-9-]+)/)?.[1]?.toLowerCase();
  if (tagName === 'select') { const end = sourceText.indexOf('</select>', close); if (end >= 0) return sourceText.slice(open, end + '</select>'.length); }
  return sourceText.slice(open, close + 1);
}
function extractAttribute(fragment, name) { return fragment.match(new RegExp(`${name}=["']([^"']+)["']`))?.[1] || null; }
function extractDefault(fragment) { return fragment.match(/(?:value|defaultValue)=["']([^"']*)["']/)?.[1] || null; }
function extractSelectOptions(fragment) { return [...new Set([...String(fragment).matchAll(/<option[^>]*>([^<]{1,80})<\/option>/gi)].map((match) => clean(match[1])).filter(Boolean))].slice(0, 40); }
function extractHandler(fragment) { if (/onChange/.test(fragment)) return 'change'; if (/onSubmit/.test(fragment)) return 'submit'; if (/onClick/.test(fragment)) return 'click'; return null; }
function explicitSubmissionRole(item, fragment) { const role = item.submissionRole || item.attrs?.dataSubmissionRole; if (role) return role; return String(item.attrs?.type || extractAttribute(fragment, 'type')).toLowerCase() === 'submit' ? 'primary-submit' : null; }
function extractNetwork(fragment) { const url = fragment.match(/["'`]([^"'`]+)["'`]/)?.[1] || null; const method = fragment.match(/method\s*:\s*["']([A-Z]+)["']/i)?.[1]?.toUpperCase() || (/axios\.(get|post|put|patch|delete)/.exec(fragment)?.[1]?.toUpperCase()) || 'GET'; const fields = [...fragment.matchAll(/\b([A-Za-z_$][\w$]*)\s*:/g)].map((item) => item[1]).filter((item) => !['method', 'headers', 'body'].includes(item)); return { method, url, requestFields: [...new Set(fields)] }; }
function inferPage(text, pages) { return pages.find((page) => text.includes(page.pageId))?.pageId || null; }
function extractIdentifiers(text, regex) { return [...new Set([...text.matchAll(regex)].map((item) => item[0]))]; }
function lowerFirst(value) { return value[0].toLowerCase() + value.slice(1); }
function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function evidence(status, sources) { return { status, sources }; }
function walk(root) { return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${root}/${entry.name}`) : [`${root}/${entry.name}`]).sort(); }

export function semanticDigest(value) { return digestJSON(value); }
