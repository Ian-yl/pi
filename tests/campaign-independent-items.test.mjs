import assert from 'node:assert/strict';
import test from 'node:test';
import { independentItemsCampaignFindings } from '../scripts/lib/campaign-independence.mjs';

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
