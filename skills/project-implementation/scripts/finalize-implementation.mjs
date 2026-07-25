#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (!args.dir) usage();
const dir = resolve(args.dir);
const plan = readJSON(`${dir}/implementation-plan.json`);
const api = readJSON(`${dir}/inputs/handoff-api-contract.json`);
const runtime = readJSON(`${dir}/inputs/handoff-runtime-contract.json`);
const uiPlan = readJSON(`${dir}/inputs/handoff-ui-implementation-plan.json`);
const requiresFrontendRuntime = (uiPlan.capabilities || []).some((item) => item.presentation?.mode !== 'headless');
const integrationEvidence = exists(`${dir}/integration-evidence.json`)
  ? readJSON(`${dir}/integration-evidence.json`)
  : { schemaVersion: '1.0', verificationLevel: 'simulated', reason: 'No campaign-controlled external integration observation was supplied. Candidate runtime events establish simulated evidence only.' };
const verificationLevel = integrationEvidence.verificationLevel || 'simulated';
if (!exists(`${dir}/integration-evidence.json`)) writeJSON(`${dir}/integration-evidence.json`, integrationEvidence);
mkdirSync(`${dir}/evidence`, { recursive: true });
if (existsSync(`${dir}/unit-test-report.json`)) rmSync(`${dir}/unit-test-report.json`);
if (existsSync(`${dir}/operation-events.json`)) rmSync(`${dir}/operation-events.json`);

const backend = run(args.test || 'npm test', 'backend-tests.txt');
const frontend = requiresFrontendRuntime ? run(args.build || 'npm run build', 'frontend-build.txt') : { status: 'passed', command: 'not applicable: all presentations are headless' };
const browser = requiresFrontendRuntime ? runNode('run-browser-e2e.mjs', 'browser-runtime-runner.txt') : { status: 'passed', command: 'not applicable: all presentations are headless' };
const placeholders = requiresFrontendRuntime && browser.status === 'passed' ? runNode('audit-placeholders.mjs', 'placeholder-audit.txt', [dir]) : { status: requiresFrontendRuntime ? 'failed' : 'passed', command: 'not applicable: all presentations are headless' };
const frontendRuntime = requiresFrontendRuntime && placeholders.status === 'passed' ? runNode('verify-frontend-runtime.mjs', 'frontend-runtime-verification.txt', [dir]) : { status: requiresFrontendRuntime ? 'failed' : 'passed', command: 'not applicable: all presentations are headless' };
const commandCases = [
  { id: 'backend-contract-tests', status: backend.status, command: backend.command, evidence: ['evidence/backend-tests.txt'] },
  ...(requiresFrontendRuntime ? [{ id: 'frontend-production-build', status: frontend.status, command: frontend.command, evidence: ['evidence/frontend-build.txt'] }] : []),
  ...(requiresFrontendRuntime ? [
    { id: 'frontend-browser-runtime', status: browser.status, command: browser.command, evidence: ['evidence/browser-runtime-runner.txt', 'browser-e2e-report.json', 'frontend-runtime-report.json'] },
    { id: 'frontend-placeholder-audit', status: placeholders.status, command: placeholders.command, evidence: ['evidence/placeholder-audit.txt', 'placeholder-audit-report.json'] },
    { id: 'frontend-runtime-verification', status: frontendRuntime.status, command: frontendRuntime.command, evidence: ['evidence/frontend-runtime-verification.txt'] }
  ] : [])
];
const unitReport = exists(`${dir}/unit-test-report.json`) ? readJSON(`${dir}/unit-test-report.json`) : { cases: [] };
const operationReceipts = runNode('build-operation-receipts.mjs', 'operation-receipts.txt', [dir]);
const browserUnitIds = new Set((plan.units || []).filter((unit) => String(unit.type).startsWith('ui-')).map((unit) => unit.id));
const unitCases = (Array.isArray(unitReport.cases) ? unitReport.cases : []).filter((item) => !item.unitIds?.some((id) => browserUnitIds.has(id)));
const browserUnitCases = [...browserUnitIds].map((unitId) => ({ id: `runtime-${unitId}`, status: frontendRuntime.status, unitIds: [unitId], evidence: ['frontend-runtime-report.json', 'browser-e2e-report.json', 'placeholder-audit-report.json'] }));
const mappedCases = [...unitCases, ...browserUnitCases];
const cases = [...commandCases, ...mappedCases];
writeJSON(`${dir}/test-report.json`, { schemaVersion: '1.0', generatedAt: new Date().toISOString(), cases });

const units = (plan.units || []).map((unit) => {
  const matched = mappedCases.filter((item) => item.status === 'passed' && item.unitIds?.length === 1 && item.unitIds[0] === unit.id);
  return { id: unit.id, status: backend.status === 'passed' && matched.length ? 'succeeded' : 'failed', testIds: matched.map((item) => item.id) };
});
const testsPassed = units.every((unit) => unit.status === 'succeeded') && operationReceipts.status === 'passed' && browser.status === 'passed' && placeholders.status === 'passed' && frontendRuntime.status === 'passed';
const hasPlannedCapabilities = (uiPlan.capabilities || []).some((item) => item.specificationStatus === 'planned');
writeJSON(`${dir}/implementation-manifest.json`, { schemaVersion: '1.0', projectId: plan.projectId, status: testsPassed ? verificationLevel : 'failed', verificationLevel, deliveryStatus: testsPassed ? (hasPlannedCapabilities ? 'delivered-with-planned-capabilities' : 'implemented') : 'failed', units });

const paths = {};
const schemas = {};
for (const operation of api.operations || []) {
  paths[operation.path] ||= {};
  const method = operation.method.toLowerCase();
  const requestSchemaName = `${schemaName(operation.id)}Request`;
  const responseSchemaName = `${schemaName(operation.id)}Response`;
  schemas[requestSchemaName] = shapeSchema(operation.request || {});
  const discriminator = operation.request?.discriminator;
  if (discriminator?.property && discriminator.value !== undefined) {
    schemas[requestSchemaName].properties ||= {};
    schemas[requestSchemaName].properties[discriminator.property] = { type: 'string', enum: [String(discriminator.value)] };
    schemas[requestSchemaName].required = [...new Set([...(schemas[requestSchemaName].required || []), discriminator.property])];
  }
  schemas[responseSchemaName] = shapeSchema(operation.response || {});
  const variant = { operationId: operation.id, capabilityId: operation.capabilityId, ruleIds: operation.ruleIds || [], request: operation.request || {}, requestSchema: `#/components/schemas/${requestSchemaName}`, responseSchema: `#/components/schemas/${responseSchemaName}`, effects: operation.effects || [], errors: operation.errors || [] };
  if (!paths[operation.path][method]) {
    const grouped = (api.operations || []).filter((item) => item.path === operation.path && item.method.toLowerCase() === method);
    const parameters = ['path', 'query', 'header'].flatMap((location) => [...new Set(grouped.flatMap((item) => item.request?.[location] || []))].map((name) => ({ name, in: location, required: location === 'path', schema: { type: 'string' } })));
    paths[operation.path][method] = {
      operationId: operation.id,
      'x-capability-id': operation.capabilityId,
      'x-rule-ids': operation.ruleIds || [],
      'x-operation-variants': [variant],
      parameters,
      responses: {}
    };
  } else {
    paths[operation.path][method]['x-operation-variants'].push(variant);
  }
}
for (const methods of Object.values(paths)) for (const operation of Object.values(methods)) {
  const variants = operation['x-operation-variants'];
  if (variants.length > 1) {
    const discriminators = variants.map((item) => item.request?.discriminator);
    if (discriminators.some((item) => !item?.property || item.value === undefined)) throw new Error(`shared HTTP operation ${variants.map((item) => item.operationId).join(', ')} requires request discriminators`);
    const property = discriminators[0].property;
    if (discriminators.some((item) => item.property !== property) || new Set(discriminators.map((item) => String(item.value))).size !== variants.length) throw new Error(`shared HTTP operation ${variants.map((item) => item.operationId).join(', ')} has ambiguous request discriminators`);
  }
  const bodyVariants = variants.filter((item) => item.request?.body || item.request?.schema);
  if (bodyVariants.length) {
    const schema = { oneOf: bodyVariants.map((item) => ({ $ref: item.requestSchema })) };
    if (variants.length > 1) schema.discriminator = { propertyName: variants[0].request.discriminator.property, mapping: Object.fromEntries(variants.map((item) => [String(item.request.discriminator.value), item.requestSchema])) };
    operation.requestBody = { required: bodyVariants.some((item) => item.request?.bodyRequired === true), content: { 'application/json': { schema } } };
  }
  operation.responses['200'] = { description: 'Successful contract response', content: { 'application/json': { schema: { oneOf: variants.map((item) => ({ $ref: item.responseSchema })) } } } };
  const errors = variants.flatMap((item) => item.errors || []);
  for (const error of errors) {
    const code = typeof error === 'object' ? error.code : error;
    const status = String(typeof error === 'object' && error.status ? error.status : errorStatus(code));
    operation.responses[status] ||= { description: 'Contract error', content: { 'application/json': { schema: { type: 'object', required: ['error'], properties: { error: { type: 'string', enum: [] } } } } } };
    const values = operation.responses[status].content['application/json'].schema.properties.error.enum;
    if (!values.includes(code)) values.push(code);
  }
  operation['x-data-effects'] = variants.flatMap((item) => item.effects || []);
}
writeJSON(`${dir}/openapi.json`, { openapi: '3.1.0', info: { title: `Project ${plan.projectId} API`, version: '1.0.0' }, paths, components: { schemas } });
writeJSON(`${dir}/startup.json`, { schemaVersion: '1.0', command: args.start || runtime.command || 'npm start', cwd: runtime.cwd || '.', healthUrl: runtime.healthUrl || 'http://127.0.0.1:${PORT}/health', requiredEnvironment: runtime.requiredEnvironment || ['PORT'] });

if (backend.status !== 'passed' || frontend.status !== 'passed' || !testsPassed) process.exit(1);
console.log(`Implementation finalized (${units.length} tested units, verification=${verificationLevel}).`);

function run(command, evidenceFile) {
  const result = spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  writeFileSync(`${dir}/evidence/${evidenceFile}`, `$ ${command}\n${result.stdout || ''}${result.stderr || ''}`);
  return { command, status: result.status === 0 ? 'passed' : 'failed' };
}
function runNode(script, evidenceFile, values = ['--dir', dir]) {
  const command = `node ${resolve(import.meta.dirname, script)} ${values.join(' ')}`;
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, script), ...values], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  writeFileSync(`${dir}/evidence/${evidenceFile}`, `$ ${command}\n${result.stdout || ''}${result.stderr || ''}`);
  return { command, status: result.status === 0 ? 'passed' : 'failed' };
}
function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function exists(path) { return existsSync(path); }
function writeJSON(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function parseArgs(values) { const result = {}; for (let i = 0; i < values.length; i++) if (values[i].startsWith('--')) { result[values[i].slice(2)] = values[i + 1]; i++; } return result; }
function usage() { console.error('Usage: finalize-implementation.mjs --dir <implementation-dir> [--test "npm test"] [--build "npm run build"] [--start "npm start"]'); process.exit(2); }
function schemaName(value) { return String(value).replace(/[^a-zA-Z0-9]+(.)/g, (_, next) => next.toUpperCase()).replace(/^[^a-zA-Z_]/, '_$&'); }
function shapeSchema(value) {
  if (value?.schema && typeof value.schema === 'object') return value.schema;
  const properties = {};
  const required = [];
  for (const [location, fields] of Object.entries(value || {})) {
    if (!Array.isArray(fields)) continue;
    for (const field of fields) { properties[field] ||= {}; required.push(field); }
    if (location === 'body' && fields.length === 1 && typeof fields[0] === 'object') return fields[0];
  }
  for (const field of value?.fields || []) { properties[field] ||= {}; required.push(field); }
  return { type: 'object', properties, ...(required.length ? { required: [...new Set(required)] } : {}), additionalProperties: true };
}
function errorStatus(code = '') { if (/NOT_FOUND/.test(code)) return 404; if (/UNAVAILABLE|TIMEOUT|RATE_LIMIT/.test(code)) return 503; if (/CONFLICT|STALE/.test(code)) return 409; if (/UNAUTHORIZED/.test(code)) return 401; if (/FORBIDDEN/.test(code)) return 403; return 400; }
