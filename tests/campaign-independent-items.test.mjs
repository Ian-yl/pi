import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { collectionAtResponsePath, concurrencyFindings, independentItemsCampaignFindings, invocationBindingEvidence, operationResourceProofs, operationScopedCalls, providerOperationSetFindings } from '../scripts/lib/campaign-independence.mjs';

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

test('independent-item evidence rejects incomplete or reused external results', () => {
  const cases = [
    [ingress(4, ['r1']), [call('r1')], /does not equal the observed external provider call count/],
    [ingress(4, ['r1']), [call('r1'), call('r1'), call('r1'), call('r1')], /one distinct external result per call/],
    [{ startedAt: at - 10, observedAt: at + 10, responseCollectionLength: 2, responseValues: ['r1', 'fabricated'] }, [call('r1'), call('r2')], /does not incorporate a distinct external result per item/],
  ];
  for (const [observedIngress, calls, pattern] of cases) {
    const findings = independentItemsCampaignFindings(operation, observedIngress, calls, challengeId);
    assert.ok(findings.some((item) => pattern.test(item)), findings.join(' | '));
  }
});

test('a non-independent-items provider is not subject to the campaign count gate', () => {
  const composite = { id: 'op-collage', providerContract: { outputMode: 'composite-output' } };
  assert.deepEqual(independentItemsCampaignFindings(composite, ingress(1, []), [], challengeId), []);
});

// Concurrency teeth: the campaign judges only the observed maximum in-flight external-call count against
// the declared contract, with delay injection making overlap deterministic (not timing luck).
const parallelProvider = { outputMode: 'independent-items', concurrency: { maxParallel: 16, ordering: 'unordered', failurePolicy: 'fail-fast' } };

test('observed parallelism within the declared ceiling passes the concurrency gate', () => {
  assert.deepEqual(concurrencyFindings(parallelProvider, 4, 2), []);
});

test('the implementation may choose serial execution within its declared ceiling', () => {
  assert.deepEqual(concurrencyFindings({ outputMode: 'independent-items', concurrency: { maxParallel: 1, ordering: 'index-ordered', failurePolicy: 'fail-fast' } }, 4, 1), []);
});

test('in-flight external calls cannot exceed the declared maxParallel', () => {
  const findings = concurrencyFindings(parallelProvider, 20, 17);
  assert.ok(findings.some((item) => /exceeding its declared maxParallel/.test(item)), findings.join(' | '));
});

test('the declared response path selects the contract collection instead of another array', () => {
  const body = Buffer.from(JSON.stringify({ warnings: ['a', 'b', 'c', 'd'], result: { items: ['r1', 'r2'] } }));
  assert.deepEqual(collectionAtResponsePath(body, 'response.result.items'), ['r1', 'r2']);
});

test('every provider invocation must preserve every required integration binding', () => {
  const op = { id: 'op', integrationBindings: [{ source: 'request.value', target: 'provider.value', required: true }] };
  const ingressRecord = { startedAt: 1, observedAt: 10, requestValueDigests: { 'request.value': 'a'.repeat(64) } };
  const calls = [{ id: 'one', challengeId, startedAt: 2, observedAt: 3, requestValueDigests: { 'provider.value': 'a'.repeat(64) } }, { id: 'two', challengeId, startedAt: 4, observedAt: 5, requestValueDigests: {} }];
  const evidence = invocationBindingEvidence(op, ingressRecord, calls, challengeId);
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].observed, true);
  assert.equal(evidence[1].observed, false);
});

test('resource resolution passes only when the uploaded content reaches the provider target', () => {
  const op = { id: 'op', capabilityId: 'cap', dataDependencies: [{ sourceOperationId: 'upload', sourceField: 'response.resourceIds', targetField: 'request.resourceIds' }], integrationBindings: [{ source: 'request.resourceIds', target: 'provider.bytes', required: true }] };
  const upload = { id: 'upload', method: 'POST', path: '/resources', resourceTransfer: { fileField: 'file' } };
  const resolution = { method: 'resource-id-dereference', verificationMode: 'base64-content', detail: 'resolve the locked resource before the provider call' };
  const spec = { capabilities: [{ id: 'cap', closure: { inputUtilization: [{ operationId: 'op', requestPath: 'body.resourceIds', disposition: 'provider-mapped', resourceResolution: resolution }] } }] };
  const ids = ['resource-b'];
  const idsDigest = createHash('sha256').update(JSON.stringify(ids)).digest('hex');
  const contentDigest = 'c'.repeat(64);
  const ingress = { startedAt: 5, observedAt: 10, requestValueDigests: { 'request.resourceIds': idsDigest } };
  const observations = [
    { method: 'POST', path: '/resources', status: 201, observedAt: 2, responseBody: { resourceIds: ['resource-a'] }, requestContentDigests: { 'request.file': { 'raw-content': ['a'.repeat(64)] } } },
    { method: 'POST', path: '/resources', status: 201, observedAt: 4, responseBody: { resourceIds: ids }, requestContentDigests: { 'request.file': { 'raw-content': [contentDigest] } } },
  ];
  const proofs = operationResourceProofs(spec, op, [upload, op], observations, ingress);
  const call = { id: 'call', challengeId, startedAt: 5, observedAt: 6, requestValueDigests: { 'provider.bytes': 'b'.repeat(64) }, requestContentDigests: { 'provider.bytes': { 'base64-content': [contentDigest] } } };
  const evidence = invocationBindingEvidence(op, ingress, [call], challengeId, proofs);
  assert.equal(evidence[0].mappingMode, 'resource-resolution');
  assert.match(evidence[0].resolutionDigest, /^[a-f0-9]{64}$/);
  assert.equal(evidence[0].observed, true);
  assert.equal(invocationBindingEvidence(op, ingress, [{ ...call, requestContentDigests: { 'provider.bytes': { 'base64-content': ['d'.repeat(64)] } } }], challengeId, proofs)[0].observed, false);
});

test('provider evidence must exactly cover every provider operation, not merely its capability', () => {
  const operations = [{ id: 'one', providerContract: {} }, { id: 'two', providerContract: {} }, { id: 'local' }];
  assert.deepEqual(providerOperationSetFindings(operations, [{ operationId: 'one' }, { operationId: 'two' }]), []);
  assert.ok(providerOperationSetFindings(operations, [{ operationId: 'one' }]).some((item) => /set mismatch/.test(item)));
  assert.ok(providerOperationSetFindings(operations, [{ operationId: 'one' }, { operationId: 'one' }, { operationId: 'two' }]).some((item) => /set mismatch/.test(item)));
});

test('overlapping provider operations cannot reuse one external invocation', () => {
  const observedIngress = { startedAt: 1, observedAt: 10 };
  const observations = [
    { challengeId, operationId: 'operation-a', status: 200, startedAt: 2, observedAt: 9 },
    { challengeId, operationId: 'operation-b', status: 200, startedAt: 2, observedAt: 9 },
  ];
  assert.equal(operationScopedCalls(observations, challengeId, 'operation-a', observedIngress).length, 1);
  assert.equal(operationScopedCalls(observations, challengeId, 'operation-b', observedIngress).length, 1);
  assert.equal(operationScopedCalls(observations.slice(0, 1), challengeId, 'operation-b', observedIngress).length, 0);
});
