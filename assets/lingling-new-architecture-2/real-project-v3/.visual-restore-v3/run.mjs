#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const installRoot = dirname(fileURLToPath(import.meta.url));
const [command, ...args] = process.argv.slice(2);

if (!command || !/^[a-z0-9-]+$/.test(command)) {
  console.error('Usage: node .visual-restore-v3/run.mjs <tool-name> [...args]');
  process.exit(1);
}

let manifest;
try {
  const manifestPath = join(installRoot, 'runtime-manifest.json');
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('unsafe manifest path');
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1
    || !Array.isArray(manifest.commands)
    || !Array.isArray(manifest.files)
    || !manifest.integrity
    || typeof manifest.integrity !== 'object') {
    throw new Error('unsupported runtime manifest');
  }
} catch (error) {
  console.error(`Invalid Visual Restore runtime manifest: ${error.message}`);
  process.exit(1);
}

if (!manifest.commands.includes(command) || !manifest.files.includes(`${command}.mjs`)) {
  console.error(`Visual Restore tool is not allowed: ${command}`);
  process.exit(1);
}

const script = join(installRoot, 'scripts', `${command}.mjs`);
let scriptStat;
try {
  const scriptsStat = lstatSync(join(installRoot, 'scripts'));
  if (!scriptsStat.isDirectory() || scriptsStat.isSymbolicLink()) throw new Error('unsafe scripts directory');
  scriptStat = lstatSync(script);
} catch {
  console.error(`Missing or unsafe Visual Restore tool: ${command}`);
  process.exit(1);
}
if (!scriptStat.isFile() || scriptStat.isSymbolicLink()) {
  console.error(`Unsafe Visual Restore tool path: ${command}`);
  process.exit(1);
}
const relativeScript = relative(realpathSync(installRoot), realpathSync(script));
if (relativeScript === '..' || relativeScript.startsWith(`..${sep}`) || isAbsolute(relativeScript)) {
  console.error(`Unsafe Visual Restore tool path: ${command}`);
  process.exit(1);
}
const expectedDigest = manifest.integrity[`${command}.mjs`];
const actualDigest = createHash('sha256').update(readFileSync(script)).digest('hex');
if (!/^[a-f0-9]{64}$/.test(expectedDigest || '') || actualDigest !== expectedDigest) {
  console.error(`Visual Restore tool integrity mismatch: ${command}`);
  process.exit(1);
}

const projectRoot = resolve(process.cwd());
const result = spawnSync(process.execPath, [script, ...args], {
  cwd: projectRoot,
  env: { ...process.env, VISUAL_RESTORE_ROOT: projectRoot },
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
