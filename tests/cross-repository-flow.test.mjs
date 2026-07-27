import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('FDD schema 2.2 authoring flows through reviewed handoff to verified PI implementation', () => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'cross-repository-flow-'));
  try {
    const generated = spawnSync(process.execPath, [path.join(root, 'assets/golden-simulated/generate.mjs'), '--output', output], { encoding: 'utf8' });
    assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`);

    const functionalManifest = read(`${output}/functional-domain/manifest.json`);
    const functionalReceipt = read(`${output}/functional-domain/review-receipt.json`);
    const planningManifest = read(`${output}/functional-domain/planning-manifest.json`);
    assert.equal(functionalManifest.schemaVersion, '2.2');
    assert.equal(functionalManifest.status, 'approved');
    assert.equal(planningManifest.status, 'approved');
    assert.equal(functionalReceipt.contractVersion, 'functional-domain/2.2');
    assert.notEqual(functionalReceipt.authorAgentId, functionalReceipt.reviewerAgentId);
    for (const file of ['evidence-index.json', 'evidence-dispositions.json']) assert.equal(existsSync(`${output}/functional-domain/${file}`), true);

    const handoffManifest = read(`${output}/implementation-handoff/handoff-manifest.json`);
    const handoffReceipt = read(`${output}/implementation-handoff/handoff-review-receipt.json`);
    assert.equal(handoffManifest.status, 'approved');
    assert.equal(handoffReceipt.contractVersion, 'implementation-handoff/2.2');
    assert.notEqual(handoffReceipt.authorAgentId, handoffReceipt.reviewerAgentId);

    const inputLock = read(`${output}/implementation/input-lock.json`);
    for (const file of ['evidence-index.json', 'evidence-dispositions.json']) {
      assert.equal(existsSync(`${output}/implementation/inputs/functional-${file}`), true);
      assert.ok(inputLock.digests[`functional/${file}`]);
    }
    const designManifest = read(`${output}/functional-domain/design-manifest.json`);
    assert.equal(existsSync(`${output}/implementation/inputs/functional-design-manifest.json`), true);
    assert.ok(inputLock.digests['functional/design-manifest.json']);
    for (const image of designManifest.images) {
      assert.equal(existsSync(`${output}/implementation/inputs/functional-${image.path}`), true);
      assert.ok(inputLock.digests[`functional/${image.path}`]);
    }

    const verified = spawnSync(process.execPath, [path.join(root, 'scripts/verify-implementation.mjs'), `${output}/implementation`, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
    assert.match(verified.stdout, /Implementation valid/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

function read(file) { return JSON.parse(readFileSync(file, 'utf8')); }
