#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { treeDigest } from './lib/validator-tree.mjs';
import { hashDirectory, sha } from './lib/visual-release.mjs';

const args = parseArgs(process.argv.slice(2)); if (!args.handoff) usage();
const dir = resolve(args.handoff); const receiptPath = `${dir}/handoff-review-receipt.json`; const lockPath = `${dir}/handoff-lock.json`;
if (!existsSync(receiptPath) || !existsSync(lockPath)) fail('approved handoff has no review receipt or lock');
const receipt = readJSON(receiptPath); const lock = readJSON(lockPath);
const registry = new Map([
  ['fdd-handoff-reviewer-2.3', { contractVersion: 'implementation-handoff/2.3', entry: resolve(import.meta.dirname, '../validators/handoff-2.3/review-handoff.mjs') }],
]);
const trusted = registry.get(receipt.trustedReviewerId);
if (receipt.status !== 'approved' || !receipt.contractVersion || !trusted || trusted.contractVersion !== receipt.contractVersion || receipt.validatorDigest !== treeDigest(resolve(trusted.entry, '..'))) fail('handoff receipt does not pin a trusted reviewer revision');
const replay = spawnSync(process.execPath, [trusted.entry, '--handoff', dir, '--reviewer-agent', receipt.reviewerAgentId, '--trusted-replay-only', 'true'], { encoding: 'utf8' });
if (replay.status !== 0) fail(`trusted handoff replay failed: ${replay.stderr || replay.stdout}`);
const expected = Object.keys(lock.digests || {}).sort(); const actual = expected.filter((file) => file === 'web' ? existsSync(`${dir}/web`) : existsSync(`${dir}/${file}`));
if (JSON.stringify(expected) !== JSON.stringify(actual)) fail('handoff lock file set is incomplete');
for (const file of expected) { const digest = file === 'web' ? hashDirectory(`${dir}/web`) : sha(readFileSync(`${dir}/${file}`)); if (lock.digests[file] !== digest) fail(`handoff lock mismatch: ${file}`); }
console.log(`Implementation handoff valid (${receipt.contractVersion}, ${receipt.trustedReviewerId})`);

function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function fail(message) { console.error(`- ${message}`); process.exit(1); }
function parseArgs(values) { const result = {}; for (let index = 0; index < values.length; index++) if (values[index].startsWith('--')) result[values[index].slice(2)] = values[++index]; return result; }
function usage() { console.error('Usage: validate-implementation-handoff.mjs --handoff <dir>'); process.exit(2); }
