#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assetReferenceFindings } from './lib/asset-references.mjs';

const dirArg = process.argv.slice(2).find((value) => !value.startsWith('--'));
if (!dirArg) { console.error('Usage: audit-placeholders.mjs <implementation-dir>'); process.exit(2); }
const dir = resolve(dirArg);
const resolution = readJSON(`${dir}/placeholder-resolution.json`);
const plan = readJSON(`${dir}/implementation-plan.json`);
const runtime = readJSON(`${dir}/frontend-runtime-report.json`);
const functionalManifest = existsSync(`${dir}/inputs/functional-manifest.json`) ? readJSON(`${dir}/inputs/functional-manifest.json`) : {}; const assetInventoryRequired = functionalManifest.schemaVersion === '2.3'; const assetInventoryPath = `${dir}/inputs/handoff-asset-role-inventory.json`;
const assetInventory = existsSync(assetInventoryPath) ? readJSON(assetInventoryPath) : { assets: [] };
const allowed = new Set(['replaced-by-api-data', 'replaced-by-user-input', 'converted-to-empty-state', 'retained-as-static-decoration', 'retained-as-explicit-demo-fixture']);
const errors = [];
if (assetInventoryRequired && !existsSync(assetInventoryPath)) errors.push('locked asset role inventory is missing from placeholder audit inputs');
if (resolution.status !== 'implemented') errors.push('placeholder resolution is not implemented — resolve every pending business sample before finalization');
if (!Array.isArray(resolution.runtimeFallbacks) || resolution.runtimeFallbacks.length) errors.push('production runtime has undeclared or mock fallbacks');
const items = resolution.items || [];
const runtimeCases = new Map((runtime.cases || []).map((item) => [item.id, item]));
for (const unit of (plan.units || []).filter((item) => item.type === 'ui-data')) {
  for (const capabilityId of unit.capabilityIds || []) if (!items.some((item) => item.capabilityId === capabilityId)) errors.push(`frontend data capability has no placeholder resolution: ${capabilityId}`);
}
for (const item of items) {
  if (!item.id || (!item.capabilityId && !item.assetId) || !allowed.has(item.resolution)) errors.push(`placeholder item has invalid identity or resolution: ${item.id || 'unknown'}`);
  if (item.resolution === 'pending') errors.push(`placeholder resolution is pending: ${item.id}`);
  if (item.resolution === 'retained-as-static-decoration' && item.businessRole !== 'decoration') errors.push(`retained static asset is not classified as decoration: ${item.id}`);
  if (item.resolution === 'retained-as-explicit-demo-fixture' && resolution.environment === 'production') errors.push(`demo fixture is retained in production: ${item.id}`);
  if (['replaced-by-api-data', 'converted-to-empty-state'].includes(item.resolution) && (!item.states || !['empty', 'loading', 'error', 'success'].every((state) => item.states[state] === true))) errors.push(`placeholder resolution lacks complete runtime states: ${item.id}`);
  if (item.capabilityId && (!item.evidenceId || !runtimeCases.has(item.evidenceId))) errors.push(`placeholder resolution has no browser evidence: ${item.id}`);
}
const scannedFiles = ['web', 'dist'].flatMap((root) => existsSync(`${dir}/${root}`) ? walk(`${dir}/${root}`) : []);
const scannedDigests = new Map(scannedFiles.map((file) => [sha(readFileSync(file)), file]));
const runtimeText = JSON.stringify(runtime);
for (const asset of assetInventory.assets || []) {
  const resolutionItem = items.find((item) => item.assetId === asset.id && item.sourceDigest === asset.digest);
  if (!resolutionItem) { errors.push(`asset has no digest-bound placeholder resolution: ${asset.id}`); continue; }
  if (asset.role === 'business-sample') {
    const references = assetReferenceFindings(scannedFiles, runtime, asset);
    if (references.length) errors.push(`business-sample asset remains referenced by implementation or runtime evidence: ${asset.id} (${references.map((item) => item.kind).join(', ')}) — replace it with API data, user input, or the declared empty state`);
    const expected = ({ 'api-data': 'replaced-by-api-data', 'user-input': 'replaced-by-user-input', 'empty-state': 'converted-to-empty-state' })[asset.requiredReplacement];
    if (resolutionItem.resolution !== expected) errors.push(`business-sample asset does not use its required replacement: ${asset.id}`);
  } else if (asset.role === 'decorative') {
    const virtual = ['remote-url', 'data-uri'].includes(asset.sourceType);
    if ((!virtual && !scannedDigests.has(asset.digest)) || (virtual && !assetReferenceFindings(scannedFiles, runtime, asset).length)) errors.push(`decorative asset was removed or changed instead of being preserved: ${asset.id}`);
  }
}
if (errors.length) { console.error(errors.map((item) => `- ${item}`).join('\n')); process.exit(1); }
const digest = createHash('sha256').update(readFileSync(`${dir}/placeholder-resolution.json`)).digest('hex');
writeFileSync(`${dir}/placeholder-audit-report.json`, `${JSON.stringify({ schemaVersion: '1.0', generatedBy: 'project-implementation/audit-placeholders', resolutionDigest: digest, checkedItems: items.length, status: 'passed' }, null, 2)}\n`);
console.log(`Placeholder audit passed (${items.length} items)`);
function readJSON(path) { if (!existsSync(path) || statSync(path).size === 0) throw new Error(`missing ${path}`); return JSON.parse(readFileSync(path, 'utf8')); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function walk(path) { return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${path}/${entry.name}`) : statSync(`${path}/${entry.name}`).isFile() ? [`${path}/${entry.name}`] : []); }
