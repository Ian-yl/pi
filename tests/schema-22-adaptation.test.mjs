import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const golden = path.join(root, 'assets/golden-simulated/current');
const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));
const prepare = path.join(root, 'scripts/prepare-implementation.mjs');
const verify = path.join(root, 'scripts/verify-implementation.mjs');

test('the golden simulated flow is a schema 2.2 functional package that verifies end to end', () => {
  assert.equal(readJSON(path.join(golden, 'functional-domain/manifest.json')).schemaVersion, '2.2');
  const result = spawnSync('node', [verify, path.join(golden, 'implementation'), '--require-level', 'simulated'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

// A schema 2.2 package that declares the semantic-file contract but is missing one of those files
// must fail closed.
test('schema 2.2 prepare rejects a functional package missing a declared semantic file (no fail-open)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fail-open-'));
  try {
    cpSync(path.join(golden, 'functional-domain'), path.join(dir, 'fn'), { recursive: true });
    cpSync(path.join(golden, 'implementation-handoff'), path.join(dir, 'ho'), { recursive: true });
    assert.equal(readJSON(path.join(dir, 'fn/manifest.json')).schemaVersion, '2.2');
    rmSync(path.join(dir, 'fn/asset-role-inventory.json'));
    const result = spawnSync('node', [prepare, '--functional', path.join(dir, 'fn'), '--handoff', path.join(dir, 'ho'), '--output', path.join(dir, 'out')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'a 2.2 package missing a declared semantic file must be rejected');
    assert.match(`${result.stdout}${result.stderr}`, /asset-role-inventory\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('schema 2.2 verify rejects a prepared workspace whose declared semantic input was removed (no fail-open)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fail-open-verify-'));
  try {
    cpSync(path.join(golden, 'implementation'), dir, { recursive: true });
    rmSync(path.join(dir, 'inputs/functional-asset-role-inventory.json'));
    const result = spawnSync('node', [verify, dir, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'a 2.2 workspace missing a declared semantic input must be rejected');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('schema 2.2 prepare rejects a functional package missing evidence dispositions', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'missing-evidence-'));
  try {
    cpSync(path.join(golden, 'functional-domain'), path.join(dir, 'fn'), { recursive: true });
    cpSync(path.join(golden, 'implementation-handoff'), path.join(dir, 'ho'), { recursive: true });
    rmSync(path.join(dir, 'fn/evidence-dispositions.json'));
    const result = spawnSync(process.execPath, [prepare, '--functional', path.join(dir, 'fn'), '--handoff', path.join(dir, 'ho'), '--output', path.join(dir, 'out')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /evidence-dispositions\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('schema 2.2 verify rejects removal of a locked evidence input', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'removed-evidence-'));
  try {
    cpSync(path.join(golden, 'implementation'), dir, { recursive: true });
    rmSync(path.join(dir, 'inputs/functional-evidence-index.json'));
    const result = spawnSync(process.execPath, [verify, dir, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /functional\/evidence-index\.json|input lock/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
