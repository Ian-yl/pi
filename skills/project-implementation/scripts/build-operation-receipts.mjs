#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeOperationReceipts } from './lib/operation-receipts.mjs';

const dir = resolve(process.argv[2] || '.');
const eventsPath = `${dir}/operation-events.json`;
if (!existsSync(eventsPath)) { console.error('operation test command did not produce operation-events.json'); process.exit(1); }
const api = readJSON(`${dir}/inputs/handoff-api-contract.json`); const sourceBytes = readFileSync(eventsPath); const raw = JSON.parse(sourceBytes);
const output = computeOperationReceipts(api, raw, sourceBytes); const receipts = output.receipts;
writeFileSync(`${dir}/operation-receipts.json`, `${JSON.stringify(output, null, 2)}\n`);
if (receipts.some((item) => item.status !== 'passed')) { console.error(receipts.flatMap((item) => item.findings.map((finding) => `${item.operationId}: ${finding}`)).join('\n')); process.exit(1); }

function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
