import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The first positive integrated qualification path in the repository: the golden candidate is driven through
// the full campaign at --level integrated (fresh prepare -> candidate copy -> in-place setup -> observed
// integrated E2E -> finalize -> integrated verify) and must go green. The observer injects a fixed upstream
// delay, so this exercises real bounded parallel outbound provider traffic, not timing luck. A generous
// timeout keeps the two browser-runtime passes (generate + campaign finalize) inside budget without cutting
// any validation.
test('golden candidate passes the first integrated qualification campaign', { timeout: 240000 }, () => {
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
    assert.equal(campaign.status, 0, `${campaign.stdout}\n${campaign.stderr}`);

    const summary = JSON.parse(readFileSync(`${root}/campaign/campaign-summary.json`, 'utf8'));
    assert.equal(summary.verificationLevel, 'integrated');
    assert.equal(summary.passedRuns, 1);
    assert.equal(summary.completedRuns, 1);

    const impl = `${root}/campaign/run-01/implementation`;
    const manifest = JSON.parse(readFileSync(`${impl}/implementation-manifest.json`, 'utf8'));
    assert.equal(manifest.verificationLevel, 'integrated');
    const completion = JSON.parse(readFileSync(`${impl}/capability-completion-report.json`, 'utf8'));
    assert.equal(completion.productStatus, 'delivered-with-planned-capabilities');
    assert.ok(completion.counts.implemented >= 1);

    // Campaign-owned observation receipt (schema 1.4): re-derive ingress/egress independently and assert the
    // full five-party equality that the independent-items gate enforces, the clean teeth, and bounded
    // concurrency against the contract's declared maxParallel.
    const receipt = JSON.parse(readFileSync(`${impl}/operation-observation-receipt.json`, 'utf8'));
    assert.equal(receipt.schemaVersion, '1.4');
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.generatedBy, 'project-implementation/validation-campaign-observer');
    for (const key of ['independentItemsFindings', 'concurrencyFindings', 'visualAuditFindings']) assert.deepEqual(receipt[key], [], key);

    const ingress = receipt.observations.find((item) => item.challengeId === receipt.challengeId && item.method === 'POST' && /create$/.test(item.path) && item.status >= 200 && item.status < 300);
    assert.ok(ingress, 'ingress observation present');
    const egress = receipt.externalObservations.filter((item) => item.challengeId === receipt.challengeId && item.status >= 200 && item.status < 300 && item.observedAt >= ingress.startedAt && item.observedAt <= ingress.observedAt);
    const resultIds = egress.map((item) => item.externalResultId);
    const incorporated = resultIds.filter((id) => ingress.responseValues.includes(id));
    const quantity = ingress.responseCollectionLength;
    assert.ok(quantity >= 2, `observed quantity ${quantity} must be >= 2`);
    assert.equal(egress.length, quantity, 'observed external provider calls equal the response quantity');
    assert.equal(new Set(resultIds).size, quantity, 'one distinct external result per call');
    assert.equal(incorporated.length, quantity, 'every external result is incorporated into the ingress response');

    const api = JSON.parse(readFileSync(`${impl}/inputs/handoff-api-contract.json`, 'utf8'));
    const declaredMaxParallel = api.operations.find((item) => item.providerContract?.outputMode === 'independent-items').providerContract.concurrency.maxParallel;
    assert.ok(receipt.maxInFlight >= 2, `real parallelism observed (maxInFlight ${receipt.maxInFlight} >= 2 under delay injection)`);
    assert.ok(receipt.maxInFlight <= declaredMaxParallel, `in-flight ${receipt.maxInFlight} stays within declared maxParallel ${declaredMaxParallel}`);

    assert.ok(receipt.integrationBindingEvidence.length > 0, 'integration bindings observed');
    assert.ok(receipt.integrationBindingEvidence.every((binding) => !binding.required || (binding.observed && /^[a-f0-9]{64}$/i.test(binding.sourceValueDigest || '') && binding.sourceValueDigest === binding.targetValueDigest)), 'ingress input digest equals egress provider digest');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
