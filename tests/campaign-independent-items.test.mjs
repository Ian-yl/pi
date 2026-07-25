import assert from 'node:assert/strict';
import test from 'node:test';
import { concurrencyFindings, independentItemsCampaignFindings, visualAuditFindings } from '../scripts/lib/campaign-independence.mjs';

// The integrated campaign must count its OWN observed external provider calls and the observed response
// collection, never the app's self-reported provider-call field. For an independent-items operation the
// observed external-call count must equal the distinct external-result count and the observed response
// collection length, with each external result incorporated. These tests exercise that mechanism directly
// (the integrated positive golden is a later wave); the language is generic to any external-item provider.
const operation = { id: 'op-generate', providerContract: { outputMode: 'independent-items', oneProviderResultPerItem: true } };
const challengeId = 'chal-1';
const at = 1000;
const ingress = (responseCollectionLength, resultIds) => ({ startedAt: at - 10, observedAt: at + 10, responseCollectionLength, responseValues: [...resultIds, 'unrelated-scalar'] });
const call = (externalResultId) => ({ challengeId, status: 200, observedAt: at, externalResultId });

test('N distinct external calls, results, and response items pass the campaign count gate', () => {
  const ids = ['r1', 'r2', 'r3', 'r4'];
  assert.deepEqual(independentItemsCampaignFindings(operation, ingress(4, ids), ids.map(call), challengeId), []);
});

test('CAMP1: one external call self-split into a 4-item response is rejected (call-once-split-N)', () => {
  const findings = independentItemsCampaignFindings(operation, ingress(4, ['r1']), [call('r1')], challengeId);
  assert.ok(findings.some((item) => /does not equal the observed external provider call count/.test(item)), findings.join(' | '));
});

test('CAMP2: reusing one external result across N calls violates one-result-per-item', () => {
  const findings = independentItemsCampaignFindings(operation, ingress(4, ['r1']), [call('r1'), call('r1'), call('r1'), call('r1')], challengeId);
  assert.ok(findings.some((item) => /one distinct external result per call/.test(item)), findings.join(' | '));
});

test('CAMP3: a response item with no incorporated external result is rejected', () => {
  const findings = independentItemsCampaignFindings(operation, { startedAt: at - 10, observedAt: at + 10, responseCollectionLength: 2, responseValues: ['r1', 'fabricated'] }, [call('r1'), call('r2')], challengeId);
  assert.ok(findings.some((item) => /does not incorporate a distinct external result per item/.test(item)), findings.join(' | '));
});

test('a non-independent-items provider is not subject to the campaign count gate', () => {
  const composite = { id: 'op-collage', providerContract: { outputMode: 'composite-output' } };
  assert.deepEqual(independentItemsCampaignFindings(composite, ingress(1, []), [], challengeId), []);
});

// Concurrency teeth: the campaign judges only the observed maximum in-flight external-call count against
// the declared contract, with delay injection making overlap deterministic (not timing luck).
const parallelProvider = { outputMode: 'independent-items', concurrency: { maxParallel: 2, ordering: 'unordered', failurePolicy: 'fail-fast' } };

test('observed parallelism within the declared ceiling passes the concurrency gate', () => {
  assert.deepEqual(concurrencyFindings(parallelProvider, 4, 2), []);
});

test('a declared-serial provider (maxParallel:1) observed serial passes', () => {
  assert.deepEqual(concurrencyFindings({ outputMode: 'independent-items', concurrency: { maxParallel: 1, ordering: 'index-ordered', failurePolicy: 'fail-fast' } }, 4, 1), []);
});

test('CAMP4: a provider that declares maxParallel>=2 but runs serially is rejected (floor)', () => {
  const findings = concurrencyFindings({ outputMode: 'independent-items', concurrency: { maxParallel: 3, ordering: 'unordered', failurePolicy: 'fail-fast' } }, 4, 1);
  assert.ok(findings.some((item) => /was observed running serially/.test(item)), findings.join(' | '));
});

test('CAMP5: in-flight external calls exceeding the declared maxParallel is rejected (ceiling)', () => {
  const findings = concurrencyFindings(parallelProvider, 4, 3);
  assert.ok(findings.some((item) => /exceeding its declared maxParallel/.test(item)), findings.join(' | '));
});

// Visual sampling receipt: a process gate over the not-machine-detectable content-collage boundary. The
// machine only checks receipt existence, digest alignment, and recorded identity/time — never the verdict.
const sheet = [{ digest: 'd1' }, { digest: 'd2' }, { digest: 'd3' }];
const goodReceipt = { sampleDigests: ['d1', 'd2', 'd3'], verdictPerItem: ['independent', 'independent', 'suspected-composite'], auditorIdentity: 'design-reviewer-1', auditedAt: '2026-07-25T00:00:00Z' };

test('a complete, aligned visual-audit-receipt passes the process gate', () => {
  assert.deepEqual(visualAuditFindings(sheet, goodReceipt), []);
});

test('CAMP6: an integrated independent-items delivery with no visual-audit-receipt is rejected', () => {
  assert.ok(visualAuditFindings(sheet, null).some((item) => /no visual-audit-receipt/.test(item)));
});

test('CAMP7: a visual-audit-receipt whose sampled digests do not align with the sampling sheet is rejected', () => {
  const findings = visualAuditFindings(sheet, { ...goodReceipt, sampleDigests: ['d1', 'd2', 'dX'] });
  assert.ok(findings.some((item) => /do not align one-to-one/.test(item)), findings.join(' | '));
});

test('CAMP8: a visual-audit-receipt lacking auditor identity is rejected', () => {
  const findings = visualAuditFindings(sheet, { ...goodReceipt, auditorIdentity: '' });
  assert.ok(findings.some((item) => /lacks an auditor identity/.test(item)), findings.join(' | '));
});
