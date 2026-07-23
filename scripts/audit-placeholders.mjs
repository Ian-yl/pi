#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dirArg = process.argv.slice(2).find((value) => !value.startsWith('--'));
if (!dirArg) { console.error('Usage: audit-placeholders.mjs <implementation-dir>'); process.exit(2); }
const dir = resolve(dirArg);
const resolution = readJSON(`${dir}/placeholder-resolution.json`);
const plan = readJSON(`${dir}/implementation-plan.json`);
const runtime = readJSON(`${dir}/frontend-runtime-report.json`);
const allowed = new Set(['replaced-by-api-data', 'replaced-by-user-input', 'converted-to-empty-state', 'retained-as-static-decoration', 'retained-as-explicit-demo-fixture']);
const errors = [];
if (resolution.status !== 'implemented') errors.push('placeholder resolution is not implemented');
if (!Array.isArray(resolution.runtimeFallbacks) || resolution.runtimeFallbacks.length) errors.push('production runtime has undeclared or mock fallbacks');
const items = resolution.items || [];
const runtimeCases = new Map((runtime.cases || []).map((item) => [item.id, item]));
for (const unit of (plan.units || []).filter((item) => item.type === 'ui-data')) {
  for (const capabilityId of unit.capabilityIds || []) if (!items.some((item) => item.capabilityId === capabilityId)) errors.push(`frontend data capability has no placeholder resolution: ${capabilityId}`);
}
for (const item of items) {
  if (!item.id || !item.capabilityId || !allowed.has(item.resolution)) errors.push(`placeholder item has invalid identity or resolution: ${item.id || 'unknown'}`);
  if (item.resolution === 'retained-as-static-decoration' && item.businessRole !== 'decoration') errors.push(`retained static asset is not classified as decoration: ${item.id}`);
  if (item.resolution === 'retained-as-explicit-demo-fixture' && resolution.environment === 'production') errors.push(`demo fixture is retained in production: ${item.id}`);
  if (['replaced-by-api-data', 'converted-to-empty-state'].includes(item.resolution) && (!item.states || !['empty', 'loading', 'error', 'success'].every((state) => item.states[state] === true))) errors.push(`placeholder resolution lacks complete runtime states: ${item.id}`);
  if (!item.evidenceId || !runtimeCases.has(item.evidenceId)) errors.push(`placeholder resolution has no browser evidence: ${item.id}`);
}
if (errors.length) { console.error(errors.map((item) => `- ${item}`).join('\n')); process.exit(1); }
const digest = createHash('sha256').update(readFileSync(`${dir}/placeholder-resolution.json`)).digest('hex');
writeFileSync(`${dir}/placeholder-audit-report.json`, `${JSON.stringify({ schemaVersion: '1.0', generatedBy: 'project-implementation/audit-placeholders', resolutionDigest: digest, checkedItems: items.length, status: 'passed' }, null, 2)}\n`);
console.log(`Placeholder audit passed (${items.length} items)`);
function readJSON(path) { if (!existsSync(path) || statSync(path).size === 0) throw new Error(`missing ${path}`); return JSON.parse(readFileSync(path, 'utf8')); }
