import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Regression negatives for quantity integrity and independent collection items. They are anchored to
// the neutral submission golden's generic collection capability and use generic language (collection
// item / resource / count); they assume no content type. The gates themselves are contract-driven.
const root = path.resolve(import.meta.dirname, '..');
const golden = path.join(root, 'assets/golden-simulated/current/implementation');
const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha = (value) => createHash('sha256').update(Buffer.from(value)).digest('hex');
const verifyFrontend = (dir) => spawnSync('node', [path.join(root, 'scripts/verify-frontend-runtime.mjs'), dir], { encoding: 'utf8' });

// Mutate the trusted runner's recorded item-independence evidence and re-seal the receipt digest, so
// each test isolates the item-integrity gate rather than the report-tamper gate.
function withMutatedEvidence(mutate) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-collection-'));
  cpSync(golden, dir, { recursive: true });
  const report = readJSON(path.join(dir, 'frontend-runtime-report.json'));
  mutate(report.cases.find((item) => item.observed?.itemIndependence).observed.itemIndependence);
  writeFileSync(path.join(dir, 'frontend-runtime-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const receipt = readJSON(path.join(dir, 'browser-e2e-report.json'));
  receipt.runtimeCasesDigest = sha(JSON.stringify(report.cases));
  writeFileSync(path.join(dir, 'browser-e2e-report.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return dir;
}
function rejects(dir, pattern) { const result = verifyFrontend(dir); rmSync(dir, { recursive: true, force: true }); assert.notEqual(result.status, 0, 'expected verification to fail'); assert.match(`${result.stdout}${result.stderr}`, pattern); }

test('the golden collection capability passes item integrity before mutation', () => {
  assert.equal(verifyFrontend(golden).status, 0, verifyFrontend(golden).stderr);
});

test('N1: a control-default quantity submitted as an explicit choice is rejected (non-default gate)', () => {
  rejects(withMutatedEvidence((evidence) => { evidence.nonDefault = false; }), /control default value|non-default/i);
});

test('N2: a collection whose length differs from the requested count is rejected (quantity chain)', () => {
  rejects(withMutatedEvidence((evidence) => { evidence.count = 1; }), /collection length differs from the requested quantity/);
});

test('N3: collection items resolving to the same resource are rejected (per-item uniqueness)', () => {
  rejects(withMutatedEvidence((evidence) => { evidence.uniqueDigests = evidence.count - 1; }), /do not all fetch a distinct resource/);
});

test('N3b: collection items reusing a resource locator are rejected (unique-URL requirement)', () => {
  rejects(withMutatedEvidence((evidence) => { evidence.uniqueUrls = evidence.count - 1; }), /do not all resolve to unique resource locators/);
});

test('N5: collection items not each individually resolved in the live app are rejected (interaction correspondence)', () => {
  rejects(withMutatedEvidence((evidence) => { evidence.revealed = evidence.count - 1; }), /do not each resolve their own resource on interaction/);
});

test('N4: a simulated-level workspace cannot claim integrated-level completion', () => {
  const result = spawnSync('node', [path.join(root, 'scripts/verify-implementation.mjs'), golden, '--require-level', 'integrated'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /below required integrated/);
});

test('N4b: a capability carrying an external providerContract caps at simulated-verified without integrated evidence', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-part4-'));
  cpSync(golden, dir, { recursive: true });
  rmSync(path.join(dir, 'implementation-lock.json'), { force: true });
  const result = spawnSync('node', [path.join(root, 'scripts/verify-implementation.mjs'), dir, '--require-level', 'simulated'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const completion = readJSON(path.join(dir, 'capability-completion-report.json'));
  const api = readJSON(path.join(dir, 'inputs/handoff-api-contract.json'));
  const externalCapabilityId = api.operations.find((operation) => operation.providerContract).capabilityId;
  const external = completion.capabilities.find((capability) => capability.capabilityId === externalCapabilityId);
  assert.equal(external.status, 'simulated-verified', 'external-provider capability must not be terminally implemented on simulated evidence alone');
  assert.equal(external.requiresIntegrated, true);
  assert.equal(completion.productStatus, 'simulated-verified');
  rmSync(dir, { recursive: true, force: true });
});
