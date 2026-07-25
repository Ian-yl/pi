import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, '../scripts/audit-placeholders.mjs');

test('placeholder audit uses asset digests, rejects pending work, and preserves decoration', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asset-audit-'));
  try {
    const decorative = Buffer.from('decorative-icon'); const sample = Buffer.from('business-sample'); mkdirSync(`${root}/web/assets`, { recursive: true }); mkdirSync(`${root}/inputs`, { recursive: true }); writeFileSync(`${root}/web/assets/icon-renamed.png`, decorative);
    write(root, 'implementation-plan.json', { units: [] }); write(root, 'frontend-runtime-report.json', { cases: [] }); write(root, 'inputs/handoff-asset-role-inventory.json', { assets: [{ id: 'decorative', path: 'assets/icon.png', digest: sha(decorative), role: 'decorative' }, { id: 'sample', path: 'assets/stage.png', digest: sha(sample), role: 'business-sample', requiredReplacement: 'api-data' }] });
    const resolved = { schemaVersion: '1.1', status: 'implemented', environment: 'production', runtimeFallbacks: [], items: [{ id: 'placeholder-decorative', assetId: 'decorative', sourceDigest: sha(decorative), classification: 'decorative', resolution: 'retained-as-static-decoration', businessRole: 'decoration' }, { id: 'placeholder-sample', assetId: 'sample', sourceDigest: sha(sample), classification: 'business-sample', requiredReplacement: 'api-data', resolution: 'replaced-by-api-data', states: { empty: true, loading: true, error: true, success: true } }] }; write(root, 'placeholder-resolution.json', resolved);
    assert.equal(run(root).status, 0);
    writeFileSync(`${root}/web/assets/renamed-result.bin`, sample); assert.match(run(root).stderr, /business-sample asset remains referenced/); rmSync(`${root}/web/assets/renamed-result.bin`);
    for (const [name, content] of [
      ['remote.js', `const sample = 'https://cdn.example/assets/stage.png'`],
      ['inline.js', `const sample = 'data:image/png;base64,${sample.toString('base64')}'`],
      ['raw.js', `const sample = '${sample.toString('base64')}'`],
      ['style.css', `.result { background-image: url('assets/stage.png') }`],
      ['dynamic.js', `const sample = 'assets/' + 'stage.png'`],
    ]) { writeFileSync(`${root}/web/${name}`, content); assert.match(run(root).stderr, /business-sample asset remains referenced/, name); rmSync(`${root}/web/${name}`); }
    write(root, 'placeholder-resolution.json', { ...resolved, status: 'pending', items: resolved.items.map((item) => item.assetId === 'sample' ? { ...item, resolution: 'pending' } : item) }); assert.match(run(root).stderr, /pending/);
    write(root, 'placeholder-resolution.json', resolved); rmSync(`${root}/web/assets/icon-renamed.png`); assert.match(run(root).stderr, /decorative asset was removed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function run(root) { return spawnSync('node', [script, root], { encoding: 'utf8' }); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function write(root, file, value) { writeFileSync(`${root}/${file}`, `${JSON.stringify(value, null, 2)}\n`); }
