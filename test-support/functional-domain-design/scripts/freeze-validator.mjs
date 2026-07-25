#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import { localImportClosure, treeDigest } from './lib/validator-tree.mjs';

const args = parseArgs(process.argv.slice(2)); const version = args.version;
if (!version) { console.error('Usage: freeze-validator.mjs --version <validator-version> [--check]'); process.exit(2); }
const root = resolve(import.meta.dirname, '..'); const scripts = `${root}/scripts`; const target = `${root}/validators/fdd-${version}`;
const stagingRoot = mkdtempSync(`${tmpdir()}/fdd-validator-freeze-`); const staging = `${stagingRoot}/fdd-${version}`;
try {
  for (const file of localImportClosure(`${scripts}/validate-package.mjs`, scripts)) { const path = relative(scripts, file); mkdirSync(dirname(`${staging}/${path}`), { recursive: true }); cpSync(file, `${staging}/${path}`); }
  if (args.check) { if (!existsSync(target) || treeDigest(target) !== treeDigest(staging)) { console.error(`validator snapshot fdd-${version} differs from deterministic generator output`); process.exit(1); } console.log(`Validator snapshot fdd-${version} matches generator output`); }
  else { rmSync(target, { recursive: true, force: true }); mkdirSync(dirname(target), { recursive: true }); cpSync(staging, target, { recursive: true }); console.log(`Frozen validator fdd-${version} (${basename(target)})`); }
} finally { rmSync(stagingRoot, { recursive: true, force: true }); }

function parseArgs(values) { const result = {}; for (let index = 0; index < values.length; index++) if (values[index].startsWith('--')) { const key = values[index].slice(2); result[key] = values[index + 1]?.startsWith('--') || values[index + 1] === undefined ? true : values[++index]; } return result; }
