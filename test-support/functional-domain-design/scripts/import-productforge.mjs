#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (!args.db || !args.project || !args.output) usage();

const db = resolve(expandHome(args.db));
const output = resolve(args.output);
const selector = String(args.project);
const escaped = selector.replaceAll("'", "''");
const sql = `select id,name,blob from projects where id='${escaped}' or name='${escaped}' order by case when id='${escaped}' then 0 else 1 end limit 1;`;
const raw = execFileSync('sqlite3', ['-json', db, sql], { encoding: 'utf8' });
const rows = JSON.parse(raw || '[]');
if (rows.length !== 1) throw new Error(`ProductForge project not found: ${selector}`);

const row = rows[0];
const blob = JSON.parse(row.blob);
const pageArchitecture = blob.pageTree;
if (!pageArchitecture?.nodes?.length) throw new Error('project has no pageTree nodes');

const contextCandidates = [
  args.context,
  `~/.productforge/backend-projects/${row.id}/context.json`,
].filter(Boolean);
let systemArchitecture = blob.systemArchitecture || null;
for (const candidate of contextCandidates) {
  try {
    const text = execFileSync('node', ['-e', `const f=require('fs');const x=JSON.parse(f.readFileSync(process.argv[1]));process.stdout.write(JSON.stringify(x.systemArchitecture||x.project?.systemArchitecture||null))`, expandHome(candidate)], { encoding: 'utf8' });
    const parsed = JSON.parse(text);
    if (parsed?.nodes?.length) { systemArchitecture = parsed; break; }
  } catch {}
}
if (!systemArchitecture?.nodes?.length) {
  throw new Error(`project ${row.id} has no system architecture; pass --context <context.json>`);
}

const productContext = {
  projectId: row.id,
  name: row.name,
  productType: blob.productType || 'unknown',
  platforms: blob.platforms || [],
  brief: blob.brief || '',
  goals: blob.goals || [],
  users: blob.users || [],
  needs: blob.needs || [],
};

mkdirSync(output, { recursive: true });
writeJSON(`${output}/page-architecture.json`, pageArchitecture);
writeJSON(`${output}/system-architecture.json`, systemArchitecture);
writeJSON(`${output}/product-context.json`, productContext);
writeJSON(`${output}/source-manifest.json`, {
  schemaVersion: '1.0',
  source: 'productforge-sqlite',
  projectId: row.id,
  projectName: row.name,
  files: ['page-architecture.json', 'system-architecture.json', 'product-context.json'],
});
console.log(`Imported ${row.name} (${row.id}) -> ${output}`);

function writeJSON(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function expandHome(value) { return String(value).replace(/^~(?=\/)/, process.env.HOME || ''); }
function parseArgs(values) {
  const result = {};
  for (let i = 0; i < values.length; i++) {
    if (!values[i].startsWith('--')) continue;
    result[values[i].slice(2)] = values[i + 1];
    i++;
  }
  return result;
}
function usage() {
  console.error('Usage: import-productforge.mjs --db <db> --project <name-or-id> --output <dir> [--context <context.json>]');
  process.exit(2);
}
