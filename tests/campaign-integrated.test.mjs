import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The staged golden intentionally retains one planned capability. Integrated qualification must therefore
// execute the full candidate and then refuse to call the product complete.
test('integrated qualification rejects a candidate that still contains planned capabilities', { timeout: 240000 }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'campaign-integrated-'));
  try {
    const generate = spawnSync('node', [path.resolve(import.meta.dirname, '../assets/golden-simulated/generate.mjs'), '--output', `${root}/golden`], { encoding: 'utf8', timeout: 120000 });
    assert.equal(generate.status, 0, `${generate.stdout}\n${generate.stderr}`);

    const campaign = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/run-validation-campaign.mjs'),
      '--functional', `${root}/golden/functional-domain`,
      '--handoff', `${root}/golden/implementation-handoff`,
      '--candidate', `${root}/golden/implementation`,
      '--output', `${root}/campaign`,
      '--level', 'integrated'], { encoding: 'utf8', timeout: 120000 });
    assert.notEqual(campaign.status, 0, 'formal integrated qualification accepted a planned capability');
    assert.match(`${campaign.stdout}\n${campaign.stderr}`, /implementation-verify failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
