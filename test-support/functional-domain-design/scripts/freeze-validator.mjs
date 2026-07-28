#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { localImportClosure, treeDigest } from './lib/validator-tree.mjs';

const args = parseArgs(process.argv.slice(2)); const version = args.version; const kind = args.kind || 'validator';
if (!version || !['validator', 'handoff'].includes(kind)) { console.error('Usage: freeze-validator.mjs --version <version> [--kind validator|handoff] [--check]'); process.exit(2); }
const root = resolve(import.meta.dirname, '..'); const scripts = `${root}/scripts`;
// A frozen snapshot is the deterministic local import closure of one entry script. The handoff reviewer is
// frozen under its own name (review-handoff.mjs) so the registry and receipts pin a stable entrypoint.
const plan = kind === 'handoff'
  ? { entry: `${scripts}/review-implementation-handoff.mjs`, target: `${root}/validators/handoff-${version}`, entryName: 'review-handoff.mjs', label: `handoff-${version}` }
  : { entry: `${scripts}/validate-package.mjs`, target: `${root}/validators/fdd-${version}`, entryName: null, label: `fdd-${version}` };
const entryRel = relative(scripts, plan.entry);
const stagingRoot = mkdtempSync(`${tmpdir()}/fdd-validator-freeze-`); const staging = `${stagingRoot}/${plan.label}`;
try {
  for (const file of localImportClosure(plan.entry, scripts)) { const rel = relative(scripts, file); const path = plan.entryName && rel === entryRel ? plan.entryName : rel; mkdirSync(dirname(`${staging}/${path}`), { recursive: true }); cpSync(file, `${staging}/${path}`); }
  if (args.check) { if (!existsSync(plan.target) || treeDigest(plan.target) !== treeDigest(staging)) { console.error(`validator snapshot ${plan.label} differs from deterministic generator output`); process.exit(1); } console.log(`Validator snapshot ${plan.label} matches generator output`); }
  else { rmSync(plan.target, { recursive: true, force: true }); mkdirSync(dirname(plan.target), { recursive: true }); cpSync(staging, plan.target, { recursive: true }); console.log(`Frozen ${plan.label} (${basename(plan.target)})`); }
} finally { rmSync(stagingRoot, { recursive: true, force: true }); }

function parseArgs(values) { const result = {}; for (let index = 0; index < values.length; index++) if (values[index].startsWith('--')) { const key = values[index].slice(2); result[key] = values[index + 1]?.startsWith('--') || values[index + 1] === undefined ? true : values[++index]; } return result; }
