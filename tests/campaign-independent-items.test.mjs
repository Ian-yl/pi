import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectionAtResponsePath, concurrencyFindings, independentItemsCampaignFindings, invocationBindingEvidence, operationResourceProofs, operationScopedCalls, providerOperationSetFindings } from '../scripts/lib/campaign-independence.mjs';
import { workspaceCwd } from '../scripts/lib/workspace-path.mjs';
import { buildResultReviewRequest, controlledProviderResponse, resultReviewReceiptFindings } from '../scripts/lib/campaign-review.mjs';

// The integrated campaign must count its OWN observed external provider calls and the observed response
// collection, never the app's self-reported provider-call field. For an independent-items operation the
// observed external-call count must equal the distinct external-result count and the observed response
// collection length. These tests exercise that mechanism directly
// (the integrated positive golden is a later wave); the language is generic to any external-item provider.
const operation = { id: 'op-generate', providerContract: { outputMode: 'independent-items', oneProviderResultPerItem: true } };
const challengeId = 'chal-1';
const at = 1000;
const ingress = (responseCollectionLength) => ({ startedAt: at - 10, observedAt: at + 10, responseCollectionLength });
const call = (externalResultId) => ({ challengeId, status: 200, observedAt: at, externalResultId });

test('independent-item campaign cardinality follows the declared output mode', () => {
  const ids = ['r1', 'r2', 'r3', 'r4'];
  assert.deepEqual(independentItemsCampaignFindings(operation, ingress(4, ids), ids.map(call), challengeId), []);
  const cases = [
    [ingress(4, ['r1']), [call('r1')], /does not equal the observed external provider call count/],
    [ingress(4, ['r1']), [call('r1'), call('r1'), call('r1'), call('r1')], /one distinct external result per call/],
  ];
  for (const [observedIngress, calls, pattern] of cases) {
    const findings = independentItemsCampaignFindings(operation, observedIngress, calls, challengeId);
    assert.ok(findings.some((item) => pattern.test(item)), findings.join(' | '));
  }
  const composite = { id: 'op-collage', providerContract: { outputMode: 'composite-output' } };
  assert.deepEqual(independentItemsCampaignFindings(composite, ingress(1, []), [], challengeId), []);
});

// Concurrency teeth: the campaign judges only the observed maximum in-flight external-call count against
// the declared contract, with delay injection making overlap deterministic (not timing luck).
const parallelProvider = { outputMode: 'independent-items', concurrency: { maxParallel: 16, ordering: 'unordered', failurePolicy: 'fail-fast' } };

test('campaign concurrency accepts declared execution and rejects only ceiling violations', () => {
  assert.deepEqual(concurrencyFindings(parallelProvider, 4, 2), []);
  assert.deepEqual(concurrencyFindings({ outputMode: 'independent-items', concurrency: { maxParallel: 1, ordering: 'index-ordered', failurePolicy: 'fail-fast' } }, 4, 1), []);
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

test('provider evidence is operation-scoped and cannot be reused across operations', () => {
  const operations = [{ id: 'one', providerContract: {} }, { id: 'two', providerContract: {} }, { id: 'local' }];
  assert.deepEqual(providerOperationSetFindings(operations, [{ operationId: 'one' }, { operationId: 'two' }]), []);
  assert.ok(providerOperationSetFindings(operations, [{ operationId: 'one' }]).some((item) => /set mismatch/.test(item)));
  assert.ok(providerOperationSetFindings(operations, [{ operationId: 'one' }, { operationId: 'one' }, { operationId: 'two' }]).some((item) => /set mismatch/.test(item)));
  const observedIngress = { startedAt: 1, observedAt: 10 };
  const observations = [
    { challengeId, operationId: 'operation-a', status: 200, startedAt: 2, observedAt: 9 },
    { challengeId, operationId: 'operation-b', status: 200, startedAt: 2, observedAt: 9 },
  ];
  assert.equal(operationScopedCalls(observations, challengeId, 'operation-a', observedIngress).length, 1);
  assert.equal(operationScopedCalls(observations, challengeId, 'operation-b', observedIngress).length, 1);
  assert.equal(operationScopedCalls(observations.slice(0, 1), challengeId, 'operation-b', observedIngress).length, 0);
});

test('campaign command working directories stay inside the implementation workspace', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'campaign-cwd-'));
  try { mkdirSync(`${root}/inside`); symlinkSync(os.tmpdir(), `${root}/outside-link`); assert.match(workspaceCwd(root, 'inside'), /\/campaign-cwd-[^/]+\/inside$/); for (const cwd of ['../outside', os.tmpdir(), 'outside-link']) assert.throws(() => workspaceCwd(root, cwd), /workspace/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('campaign response and independent review artifacts stay bound to Agent-authored contracts', () => {
  const contract = { id: 'external-op', providerContract: { controlledResponse: { status: 202, contentType: 'application/json', bodySchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^run-' } } }, body: { id: 'run-template' }, resultIdPath: 'id' }, providerResultLineage: { id: 'lineage', sourcePath: 'providerResponse.id', targetPath: 'response.id', transformation: 'persist', reviewAssertionId: 'lineage-review' } }, integrationVerification: { resultReview: { required: true, assertions: [{ id: 'lineage-review', acceptance: 'review the declared lineage' }] } } };
  assert.throws(() => controlledProviderResponse(contract, 'plain-uuid'), /rendered controlled response/);
  contract.providerContract.controlledResponse.bodySchema.properties.id.pattern = '^plain-'; contract.providerContract.controlledResponse.body.id = 'plain-template';
  assert.equal(controlledProviderResponse(contract, 'plain-uuid').body.id, 'plain-uuid');
  const request = buildResultReviewRequest([contract], [{ operationId: contract.id, providerResults: [{ id: 'plain-uuid' }], result: { id: 'business-id' } }], 'challenge', ['implementer']);
  const receipt = { schemaVersion: '1.0', requestDigest: request.requestDigest, reviewerAgentId: 'reviewer', reviewedAt: '2026-07-28T00:00:00.000Z', verdict: 'passed', assertionResults: [{ operationId: contract.id, assertionId: 'lineage-review', verdict: 'passed' }] };
  assert.deepEqual(resultReviewReceiptFindings(request, receipt), []);
  assert.ok(resultReviewReceiptFindings(request, { ...receipt, reviewerAgentId: 'implementer' }).length);
});
