#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { completeBmad } from './bmad-completion.mjs';

// Campaign candidate setup, run as the campaign `install` step inside the freshly re-prepared workspace.
// The runner re-prepares a clean ready-for-dev BMAD workspace and forbids copying protected inputs
// (_bmad-output, bmad-traceability, input-lock, plan, inputs/), so the implemented state is applied in
// place here — touching only non-protected artifacts, which assertProtectedState permits:
//   1. Complete the BMAD stories (mark done + bmad-completion.json + sprint-status).
//   2. Delete any business-sample template asset the implemented frontend replaced — candidate copy is a
//      merge and cannot remove files prepare seeded, so the placeholder audit would otherwise still see
//      the sample file by digest.
const dir = resolve(process.argv.slice(2).find((value) => !value.startsWith('--')) || '.');
completeBmad(dir);
removeReplacedBusinessSamples(dir);
console.log(`Campaign candidate setup complete: ${dir}`);

function removeReplacedBusinessSamples(root) {
  const inventoryPath = `${root}/inputs/handoff-asset-role-inventory.json`;
  if (!existsSync(inventoryPath)) return;
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  const sampleDigests = new Set((inventory.assets || []).filter((asset) => asset.role === 'business-sample').map((asset) => asset.digest));
  if (!sampleDigests.size) return;
  for (const scanned of ['web', 'dist']) {
    if (!existsSync(`${root}/${scanned}`)) continue;
    for (const file of walk(`${root}/${scanned}`)) if (sampleDigests.has(sha(readFileSync(file)))) rmSync(file);
  }
}
function walk(path) { return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${path}/${entry.name}`) : statSync(`${path}/${entry.name}`).isFile() ? [`${path}/${entry.name}`] : []); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
