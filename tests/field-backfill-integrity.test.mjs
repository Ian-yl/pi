import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Synthetic coverage for the verify-side field-assist backfill gate. A field-assist capability
// (resultDestination.targetKind:'field') and its runner evidence are hand-authored into a copy of the
// neutral golden, so the gate is exercised (one positive + three negatives) without the golden
// field-assist capability or the release re-signing chain. The gate is contract-driven: it reads
// targetFieldId / writeBehavior / states from the closure and recomputes the written-vs-produced match,
// so these tests exercise the mechanism itself, not a product-specific field.
const root = path.resolve(import.meta.dirname, '..');
const golden = path.join(root, 'assets/golden-simulated/current/implementation');
const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha = (value) => createHash('sha256').update(Buffer.from(value)).digest('hex');
const verifyFrontend = (dir) => spawnSync('node', [path.join(root, 'scripts/verify-frontend-runtime.mjs'), dir], { encoding: 'utf8' });

const states = { processing: { regionStatus: 'busy', elementSemantic: 'progress' }, success: { regionStatus: 'ready', elementSemantic: 'field-value', requiresBoundElements: true }, failure: { regionStatus: 'error', elementSemantic: 'error-message' } };

// Author a field-assist capability plus its runner case into a golden copy, then apply per-test
// mutations. includeCase:false leaves the declared capability with no runner evidence.
function withFieldAssist({ mutateEvidence = () => {}, includeCase = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-field-assist-'));
  cpSync(golden, dir, { recursive: true });
  const specPath = path.join(dir, 'inputs/handoff-functional-spec.json');
  const spec = readJSON(specPath);
  spec.capabilities.push({ id: 'cap-assist-synthetic', name: 'Suggest field value', closure: { resultDestination: { targetKind: 'field', targetFieldId: 'title', responsePath: 'response.suggestion', writeBehavior: 'replace', states } } });
  writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  const reportPath = path.join(dir, 'frontend-runtime-report.json');
  const report = readJSON(reportPath);
  if (includeCase) {
    const evidence = { capabilityId: 'cap-assist-synthetic', targetFieldId: 'title', responsePath: 'response.suggestion', writeBehavior: 'replace', backfillValue: 'A suggested value', responseValue: 'A suggested value', states: { processing: true, success: true, failure: true } };
    mutateEvidence(evidence);
    report.cases.push({ id: 'browser-assist-synthetic', capabilityId: 'cap-assist-synthetic', event: 'click', mode: 'reuse-control', observed: { matchCount: 1, visible: true, enabled: true, fieldBackfill: evidence } });
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const receiptPath = path.join(dir, 'browser-e2e-report.json');
  const receipt = readJSON(receiptPath);
  receipt.runtimeCasesDigest = sha(JSON.stringify(report.cases));
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return dir;
}
function expectReject(dir, pattern) { const result = verifyFrontend(dir); rmSync(dir, { recursive: true, force: true }); assert.notEqual(result.status, 0, 'expected verification to fail'); assert.match(`${result.stdout}${result.stderr}`, pattern); }

test('a compliant field-assist backfill passes the gate (synthetic positive)', () => {
  const dir = withFieldAssist();
  const result = verifyFrontend(dir); rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('B1: a backfilled value that differs from the operation response is rejected (value != response)', () => {
  expectReject(withFieldAssist({ mutateEvidence: (evidence) => { evidence.backfillValue = 'a value the operation never produced'; } }), /does not satisfy the declared replace behavior/);
});

test('B2: a result that only updates status text without writing the field is rejected (no field write)', () => {
  expectReject(withFieldAssist({ mutateEvidence: (evidence) => { evidence.backfillValue = ''; } }), /wrote no value into the target field/);
});

test('B3: a declared targetKind:field capability with no runner backfill evidence is rejected (declared but unproven)', () => {
  expectReject(withFieldAssist({ includeCase: false }), /no runner backfill evidence/);
});
