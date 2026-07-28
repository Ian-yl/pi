import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function verifyVisualRelease(directory) {
  const root = resolve(directory);
  const manifestPath = `${root}/release-manifest.json`;
  if (!existsSync(manifestPath)) throw new Error('visual release is missing release-manifest.json');
  const manifest = readJSON(manifestPath);
  const expectedReleaseDigest = digestWithout(manifest, 'releaseDigest');
  if (!isDigest(manifest.releaseDigest) || manifest.releaseDigest !== expectedReleaseDigest) throw new Error('visual release manifest digest mismatch');
  if (digestJSON(manifest.payloadManifest) !== manifest.payloadManifestDigest) throw new Error('visual release payload manifest digest mismatch');
  const declared = new Map((manifest.payloadManifest?.files || []).map((item) => [item.path, item]));
  const payload = `${root}/payload`;
  const actual = walk(payload).map((file) => file.slice(payload.length + 1));
  if (JSON.stringify([...declared.keys()].sort()) !== JSON.stringify(actual)) throw new Error('visual release payload file set mismatch');
  for (const [path, item] of declared) {
    const bytes = readFileSync(`${payload}/${path}`);
    if (bytes.length !== item.size || sha(bytes) !== item.sha256) throw new Error(`visual release payload mismatch: ${path}`);
  }
  const gate = readJSON(`${payload}/evidence/payload/suite-gate.json`);
  if (gate.pass !== true || gate.gateDigest !== manifest.gateDigest) throw new Error('visual release Suite Gate is invalid');
  const approval = readJSON(`${payload}/approval.json`);
  if (approval.approvalDigest !== manifest.approvalDigest) throw new Error('visual release approval digest mismatch');
  const pageResults = readJSON(`${payload}/evidence/payload/page-results.json`);
  const pages = Object.keys(pageResults).sort();
  const routes = {};
  const inventories = {};
  for (const pageId of pages) {
    if (pageResults[pageId]?.ok !== true || pageResults[pageId]?.gate?.pass !== true) throw new Error(`visual release page Gate failed: ${pageId}`);
    const plan = readJSON(`${payload}/publication/pages/${pageId}/restore-plan.json`);
    routes[pageId] = plan.capture?.url;
    inventories[pageId] = readJSON(`${payload}/evidence/payload/pages/${pageId}/visual-inventory.json`);
  }
  const publicationPrefix = 'publication/';
  const publicationFiles = [...declared.values()].filter((item) => item.path.startsWith(publicationPrefix));
  const sourceTreeDigest = digestJSON(publicationFiles.map((item) => ({ path: item.path.slice(publicationPrefix.length), size: item.size, sha256: item.sha256 })));
  return { root, manifest, manifestPath, releaseDigest: manifest.releaseDigest, suiteGateDigest: manifest.gateDigest, pages, routes, inventories, sourceTreeDigest, publicationRoot: `${payload}/publication` };
}

export function interactiveControls(inventory) {
  const kinds = new Set(['button', 'input', 'select', 'textarea', 'checkbox', 'radio', 'link']);
  const controls = (inventory?.items || []).filter((item) => kinds.has(item.kind) || item.role === 'button' || item.attrs?.href);
  return controls.map((item, index) => ({ referenceId: item.auditId || item.attrs?.dataVrId || item.id || null, referenceIndex: index, kind: item.kind, selector: item.selector || null, text: item.text || item.ariaLabel || item.placeholder || '' }));
}

export function bindVisualRelease(packageDir, releaseDir) {
  const dir = resolve(packageDir); const visual = verifyVisualRelease(releaseDir);
  const spec = readJSON(`${dir}/functional-spec.json`); const pageMap = readJSON(`${dir}/page-function-map.json`); const unresolved = readJSON(`${dir}/unresolved-items.json`); const manifest = readJSON(`${dir}/manifest.json`);
  const mappings = (spec.capabilities || []).map((capability) => ({ capabilityId: capability.id, presentation: capability.presentation || null, source: `visual-release:${visual.releaseDigest}` }));
  spec.visualSource = { sourceType: 'ai-restore-release', releaseDigest: visual.releaseDigest, suiteGateDigest: visual.suiteGateDigest, pageIds: visual.pages, routes: visual.routes, sourceTreeDigest: visual.sourceTreeDigest };
  spec.visualMappings = mappings; manifest.visualReleaseDigest = visual.releaseDigest;
  writeFileSync(`${dir}/functional-spec.json`, writeJSONValue(spec)); writeFileSync(`${dir}/unresolved-items.json`, writeJSONValue(unresolved)); writeFileSync(`${dir}/manifest.json`, writeJSONValue(manifest));
  return visual;
}

export function packageDigest(lock) { return digestJSON(lock); }
export function digestJSON(value) { return sha(Buffer.from(canonical(value), 'utf8')); }
export function sha(value) { return createHash('sha256').update(value).digest('hex'); }
export function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function writeJSONValue(value) { return `${JSON.stringify(value, null, 2)}\n`; }
export function hashDirectory(root) {
  const base = resolve(root);
  return digestJSON(walk(base).map((file) => ({ path: file.slice(base.length + 1), size: statSync(file).size, sha256: sha(readFileSync(file)) })));
}
function digestWithout(value, field) { const copy = { ...value }; delete copy[field]; return digestJSON(copy); }
function canonical(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; }
function walk(root) { return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${root}/${entry.name}`) : [`${root}/${entry.name}`]).sort(); }
function isDigest(value) { return /^[a-f0-9]{64}$/.test(String(value || '')); }
