#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { schemaFindings } from './lib/json-schema.mjs';

const dir = resolve(process.argv[2] || '.');
const eventsPath = `${dir}/operation-events.json`;
if (!existsSync(eventsPath)) { console.error('operation test command did not produce operation-events.json'); process.exit(1); }
const api = readJSON(`${dir}/inputs/handoff-api-contract.json`); const raw = readJSON(eventsPath);
const events = raw.events || []; const receipts = [];
for (const operation of api.operations || []) {
  const matching = events.filter((event) => event.operationId === operation.id); const findings = [];
  if (!matching.length) findings.push('no captured operation event');
  const success = matching.find((event) => methodPathContentType(event, operation) && successStatus(event.response?.status, operation));
  if (!success) findings.push('no matching successful request and response event');
  else {
    for (const [location, schema] of [['path', operation.request?.pathSchema], ['query', operation.request?.querySchema], ['header', operation.request?.headerSchema], ['body', operation.request?.bodySchema]]) findings.push(...schemaFindings(success.request?.[location] ?? {}, schema, `request.${location}`));
    findings.push(...schemaFindings(success.response?.body, operation.response?.bodySchema || operation.response?.schema, 'response.body'));
  }
  if (!matching.some((event) => event.authorization?.checked === true)) findings.push('authorization was not observed');
  for (const error of operation.errors || []) { const code = typeof error === 'object' ? error.code : error; if (!matching.some((event) => event.errorCode === code)) findings.push(`declared error was not observed: ${code}`); }
  for (const effect of operation.effects || []) if (!matching.some((event) => (event.effects || []).some((item) => item.entityId === effect.entityId && item.effect === effect.effect && item.observed === true && Object.hasOwn(item, 'before') && Object.hasOwn(item, 'after')))) findings.push(`effect was not observed: ${effect.entityId}/${effect.effect}`);
  if ((operation.transaction || operation.consistency) && !matching.some((event) => event.transaction?.observed === true || event.consistency?.observed === true)) findings.push('transaction or consistency behavior was not observed');
  receipts.push({ operationId: operation.id, status: findings.length ? 'failed' : 'passed', eventIds: matching.map((event) => event.id), findings });
}
const output = { schemaVersion: '1.0', generatedBy: 'project-implementation/build-operation-receipts', trustLevel: 'self-reported-runtime-events', sourceDigest: sha(readFileSync(eventsPath)), receipts };
writeFileSync(`${dir}/operation-receipts.json`, `${JSON.stringify(output, null, 2)}\n`);
if (receipts.some((item) => item.status !== 'passed')) { console.error(receipts.flatMap((item) => item.findings.map((finding) => `${item.operationId}: ${finding}`)).join('\n')); process.exit(1); }

function methodPathContentType(event, operation) { return String(event.request?.method).toUpperCase() === String(operation.method).toUpperCase() && event.request?.route === operation.path && String(event.request?.contentType || '') === String(operation.request?.contentType || 'application/json'); }
function successStatus(status, operation) { return operation.successStatuses?.length ? operation.successStatuses.map(Number).includes(Number(status)) : Number(status) >= 200 && Number(status) < 300; }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
