import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const functional = path.join(repo, 'project-implementation/assets/golden-simulated/current/functional-domain');
const frontend = path.join(repo, 'project-implementation/assets/golden-simulated/current/implementation-handoff');
const implementation = path.join(repo, 'project-implementation/assets/lingling-new-architecture-2/implementation');
const goldenImplementation = path.join(repo, 'project-implementation/assets/golden-simulated/current/implementation');

test('functional approval gate rejects a draft package', () => withCopy(functional, (dir) => {
  patchJson(`${dir}/manifest.json`, (value) => ({ ...value, status: 'draft' }));
  const result = run('functional-domain-design/scripts/validate-package.mjs', [dir, '--require-approved']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not approved/);
}));

test('implementation preparation rejects a missing independent review receipt', () => withCopy(functional, (withoutReceipt) => {
  rmSync(`${withoutReceipt}/review-receipt.json`);
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try {
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', withoutReceipt, '--frontend', frontend, '--output', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /functional package is missing review-receipt.json/);
  } finally { rmSync(output, { recursive: true, force: true }); }
}));

test('implementation preparation rejects a directory that is not an approved handoff', () => withApprovedFunctional((approved) => withCopy(frontend, (draftHandoff) => {
  patchJson(`${draftHandoff}/handoff-manifest.json`, (value) => ({ ...value, status: 'draft' }));
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try {
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--frontend', draftHandoff, '--output', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /implementation handoff is not approved/);
  } finally { rmSync(output, { recursive: true, force: true }); }
})));

test('implementation preparation accepts a locked approved implementation handoff', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (released) => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try {
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', released, '--output', output]);
    assert.equal(result.status, 0, result.stderr);
    const lock = readJson(`${output}/input-lock.json`);
    assert.equal(lock.sources.functionalPackageDigest, digestJson(readJson(`${approved}/package-lock.json`)));
    assert.ok(lock.sources.visualReleaseDigest);
    assert.ok(lock.sources.handoffPackageDigest);
    const plan = readJson(`${output}/implementation-plan.json`);
    const operationIds = readJson(`${released}/api-contract.json`).operations.map((item) => item.id);
    for (const operationId of operationIds) assert.ok(plan.units.some((unit) => unit.operationIds?.includes(operationId)));
  } finally { rmSync(output, { recursive: true, force: true }); }
})));

test('implementation preparation isolates a planned capability to a reachable planned-state unit', () => withApprovedFunctional((approved) => {
  let plannedId;
  patchJson(`${approved}/functional-spec.json`, (value) => {
    plannedId = value.capabilities[0].id;
    value.capabilities[0] = makePlanned(value.capabilities[0]);
    return value;
  });
  patchJson(`${approved}/capability-definitions.json`, (value) => { value.capabilities[0] = readJson(`${approved}/functional-spec.json`).capabilities[0]; return value; });
  withApprovedFrontend(approved, (released) => {
    const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-planned-output-'));
    try {
      const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', released, '--output', output]);
      assert.equal(result.status, 0, result.stderr);
      const plan = readJson(`${output}/implementation-plan.json`);
      assert.deepEqual(plan.units.filter((unit) => unit.capabilityIds?.includes(plannedId)).map((unit) => unit.type), ['ui-planned-state']);
      assert.equal(plan.units.some((unit) => unit.operationIds?.some((id) => readJson(`${released}/api-contract.json`).operations.some((operation) => operation.id === id && operation.capabilityId === plannedId))), false);
      const bindings = readJson(`${output}/field-binding-plan.json`).bindings.filter((binding) => binding.capabilityId === plannedId);
      assert.deepEqual(bindings.map((binding) => binding.kind), ['planned-state']);
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
}));

test('implementation preparation rejects a non-empty output directory', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (released) => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-nonempty-'));
  try {
    writeFileSync(`${output}/stale.txt`, 'stale');
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', released, '--output', output]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /must not exist or must be empty/);
  } finally { rmSync(output, { recursive: true, force: true }); }
})));

test('implementation preparation rejects a handoff receipt author mismatch', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (handoff) => {
  patchJson(`${handoff}/handoff-review-receipt.json`, (value) => ({ ...value, authorAgentId: 'different-author' }));
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try {
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', handoff, '--output', output]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /handoff review receipt author mismatch/);
  } finally { rmSync(output, { recursive: true, force: true }); }
})));

test('implementation preparation invalidates a handoff after the functional package is republished', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (handoff) => {
  patchJson(`${approved}/functional-spec.json`, (value) => ({ ...value, project: { ...value.project, brief: 'republished domain contract' } }));
  const validation = run('functional-domain-design/scripts/validate-package.mjs', [approved, '--require-approved']);
  assert.equal(validation.status, 0, validation.stderr);
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try {
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', handoff, '--output', output]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /handoff functional package digest mismatch/);
  } finally { rmSync(output, { recursive: true, force: true }); }
})));

test('implementation preparation rejects a changed visual source tree', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (handoff) => {
  writeFileSync(`${handoff}/web/pages/sample/index.html`, `${readFileSync(`${handoff}/web/pages/sample/index.html`, 'utf8')}\n<!-- changed -->\n`);
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try {
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', handoff, '--output', output]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /handoff visual source tree digest mismatch/);
  } finally { rmSync(output, { recursive: true, force: true }); }
})));

test('implementation preparation rejects a tampered functional lock', () => withApprovedFunctional((dir) => {
  patchJson(`${dir}/functional-spec.json`, (value) => ({ ...value, project: { ...value.project, name: 'tampered' } }));
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try {
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', dir, '--frontend', frontend, '--output', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lock mismatch/);
  } finally { rmSync(output, { recursive: true, force: true }); }
}));

test('implementation preparation rejects an incomplete functional lock', () => withApprovedFunctional((dir) => {
  patchJson(`${dir}/package-lock.json`, (value) => {
    const { ['functional-spec.json']: omitted, ...digests } = value.digests;
    return { ...value, digests };
  });
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try {
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', dir, '--frontend', frontend, '--output', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lock is missing digest: functional-spec.json/);
  } finally { rmSync(output, { recursive: true, force: true }); }
}));

test('implementation preparation rejects a missing UI implementation intent', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (dir) => {
    const mappedCapability = readJson(`${approved}/page-function-map.json`).pages.flatMap((page) => page.capabilityIds || []).at(-1);
    patchJson(`${dir}/ui-implementation-plan.json`, (value) => ({ ...value, capabilities: value.capabilities.filter((item) => item.capabilityId !== mappedCapability) }));
    patchJson(`${dir}/handoff-lock.json`, (value) => ({ ...value, digests: { ...value.digests, 'ui-implementation-plan.json': digest(readFileSync(`${dir}/ui-implementation-plan.json`)) } }));
    const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
    try {
      const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--frontend', dir, '--output', output]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /has no UI implementation intent/);
    } finally { rmSync(output, { recursive: true, force: true }); }
  })));

test('implementation preparation rejects duplicate UI capability contracts', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (dir) => {
  patchJson(`${dir}/ui-implementation-plan.json`, (value) => { value.capabilities.push({ ...value.capabilities[0] }); return value; });
  patchJson(`${dir}/handoff-lock.json`, (value) => ({ ...value, digests: { ...value.digests, 'ui-implementation-plan.json': digest(readFileSync(`${dir}/ui-implementation-plan.json`)) } }));
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try { const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--frontend', dir, '--output', output]); assert.notEqual(result.status, 0); assert.match(result.stderr, /exact one-to-one set/); }
  finally { rmSync(output, { recursive: true, force: true }); }
})));

test('implementation preparation rejects multipart operations without resourceTransfer', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (dir) => {
  patchJson(`${dir}/api-contract.json`, (value) => { value.operations[0].request.contentType = 'multipart/form-data'; delete value.operations[0].resourceTransfer; return value; });
  patchJson(`${dir}/handoff-lock.json`, (value) => ({ ...value, digests: { ...value.digests, 'api-contract.json': digest(readFileSync(`${dir}/api-contract.json`)) } }));
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try { const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--frontend', dir, '--output', output]); assert.notEqual(result.status, 0); assert.match(result.stderr, /has no resourceTransfer contract/); }
  finally { rmSync(output, { recursive: true, force: true }); }
})));

test('implementation verifier rejects missing test evidence', () => withCopy(implementation, (dir) => {
  rmSync(`${dir}/evidence/backend-tests.txt`);
  const result = run('project-implementation/scripts/verify-legacy-archive.mjs', [dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lacks safe workspace evidence/);
}));

test('implementation verifier rejects a changed locked input', () => withCopy(implementation, (dir) => {
  patchJson(`${dir}/inputs/frontend-api-contract.json`, (value) => ({ ...value, schemaVersion: 'changed' }));
  const result = run('project-implementation/scripts/verify-legacy-archive.mjs', [dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /input lock mismatch/);
}));

test('integrated verification rejects evidence without an application operation', () => withCopy(implementation, (dir) => {
  patchJson(`${dir}/implementation-manifest.json`, (value) => ({ ...value, status: 'integrated', verificationLevel: 'integrated' }));
  patchJson(`${dir}/integration-evidence.json`, () => ({
    schemaVersion: '1.0',
    verificationLevel: 'integrated',
    provider: { host: 'api.example.com' },
    output: { artifact: 'evidence/missing-provider-output.png', sha256: '0'.repeat(64), bytes: 2048, width: 512, height: 512 },
  }));
  const result = run('project-implementation/scripts/verify-legacy-archive.mjs', [dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must come through an application operation/);
}));

test('integrated verification rejects external connectivity evidence that bypasses the application', () => withCopy(implementation, (dir) => {
  patchJson(`${dir}/implementation-manifest.json`, (value) => ({ ...value, status: 'integrated', verificationLevel: 'integrated' }));
  patchJson(`${dir}/integration-evidence.json`, () => ({
    schemaVersion: '1.0',
    verificationLevel: 'integrated',
    provider: { host: 'api.example.com' },
    output: { artifact: 'evidence/provider-output.png', sha256: '0'.repeat(64), bytes: 2048, width: 512, height: 512 },
  }));
  const result = run('project-implementation/scripts/verify-legacy-archive.mjs', [dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must come through an application operation/);
}));

test('integrated verification checks structured operation data effects', () => withCopy(implementation, (dir) => {
  const api = readJson(`${dir}/inputs/frontend-api-contract.json`);
  const operation = api.operations.find((item) => item.effects?.length);
  operation.integrationVerification = { requiredScenarios: [], artifactAssertions: [] }; writeJson(`${dir}/inputs/frontend-api-contract.json`, api);
  mkdirSync(`${dir}/evidence/integrated`, { recursive: true });
  writeJson(`${dir}/evidence/integrated/request.json`, { operationId: operation.id, method: operation.method, path: operation.path, request: { sample: true } });
  writeJson(`${dir}/evidence/integrated/response.json`, { operationId: operation.id, status: 200, body: { ok: true } });
  writeJson(`${dir}/evidence/integrated/effect.json`, { operationId: operation.id, effects: [] });
  for (const scenario of ['success', 'providerFailure', 'providerTimeout', 'providerRateLimit']) writeJson(`${dir}/evidence/integrated/${scenario}.json`, { operationId: operation.id, scenario, observed: true });
  patchJson(`${dir}/implementation-manifest.json`, (value) => ({ ...value, status: 'integrated', verificationLevel: 'integrated' }));
  patchJson(`${dir}/integration-evidence.json`, () => ({
    schemaVersion: '1.0', verificationLevel: 'integrated', viaApplication: true, operationId: operation.id,
    provider: { host: 'api.example.com' },
    output: { artifact: 'evidence/missing.png', sha256: '0'.repeat(64), bytes: 2048, width: 512, height: 512 },
    requestEvidence: ['evidence/integrated/request.json'], responseEvidence: ['evidence/integrated/response.json'], dataEffectEvidence: ['evidence/integrated/effect.json'],
    scenarios: Object.fromEntries(['success', 'providerFailure', 'providerTimeout', 'providerRateLimit'].map((scenario) => [scenario, { status: 'passed', evidence: [`evidence/integrated/${scenario}.json`] }])),
  }));
  const result = run('project-implementation/scripts/verify-legacy-archive.mjs', [dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /integrated data-effect evidence does not cover/);
}));

test('integrated verification rejects a broken cross-operation data flow', () => withCopy(implementation, (dir) => {
  const apiPath = `${dir}/inputs/frontend-api-contract.json`; const api = readJson(apiPath); const operation = api.operations.find((item) => item.effects?.length);
  operation.request = { bodySchema: { type: 'object', required: ['inputAssetIds'], properties: { inputAssetIds: { type: 'array', minItems: 1, items: { type: 'string' } } } } };
  operation.integrationVerification = { requiredScenarios: [], artifactAssertions: [] };
  operation.dataDependencies = [{ sourceOperationId: 'upload-material-test', sourceField: 'response.materialId', targetField: 'request.inputAssetIds[]', requiredStatus: 'validated' }]; writeJson(apiPath, api);
  mkdirSync(`${dir}/evidence/integrated`, { recursive: true });
  writeJson(`${dir}/evidence/integrated/request.json`, { operationId: operation.id, method: operation.method, path: operation.path, request: {} });
  writeJson(`${dir}/evidence/integrated/response.json`, { operationId: operation.id, status: 200, body: { ok: true } });
  writeJson(`${dir}/evidence/integrated/effect.json`, { operationId: operation.id, effects: (operation.effects || []).map((item) => ({ ...item, observed: true, before: null, after: { id: 'created' } })) });
  for (const scenario of ['success', 'providerFailure', 'providerTimeout', 'providerRateLimit']) writeJson(`${dir}/evidence/integrated/${scenario}.json`, { operationId: operation.id, scenario, observed: true });
  patchJson(`${dir}/implementation-manifest.json`, (value) => ({ ...value, verificationLevel: 'integrated' }));
  patchJson(`${dir}/integration-evidence.json`, () => ({ schemaVersion: '1.0', verificationLevel: 'integrated', viaApplication: true, operationId: operation.id, provider: { host: 'api.example.com' }, output: { artifact: 'evidence/missing.png', sha256: '0'.repeat(64), bytes: 2048, width: 512, height: 512 }, requestEvidence: ['evidence/integrated/request.json'], responseEvidence: ['evidence/integrated/response.json'], dataEffectEvidence: ['evidence/integrated/effect.json'], scenarios: Object.fromEntries(['success', 'providerFailure', 'providerTimeout', 'providerRateLimit'].map((scenario) => [scenario, { status: 'passed', evidence: [`evidence/integrated/${scenario}.json`] }])) }));
  const result = run('project-implementation/scripts/verify-legacy-archive.mjs', [dir]); assert.notEqual(result.status, 0); assert.match(result.stderr, /request\.body\.inputAssetIds is required/); assert.match(result.stderr, /integrated data flow does not prove/);
}));

test('implementation verifier requires test-to-unit mappings', () => withCopy(implementation, (dir) => {
  const result = run('project-implementation/scripts/verify-legacy-archive.mjs', [dir, '--require-level', 'simulated']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not declare unit/);
}));

test('implementation verifier rejects pending operation provenance', () => withCopy(implementation, (dir) => {
  const result = run('project-implementation/scripts/verify-legacy-archive.mjs', [dir, '--require-level', 'simulated']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /provenance backend source is pending/);
}));

test('implementation verifier rejects the unsupported production-verified level', () => withCopy(implementation, (dir) => {
  patchJson(`${dir}/implementation-manifest.json`, (value) => ({ ...value, verificationLevel: 'production-verified' }));
  patchJson(`${dir}/integration-evidence.json`, (value) => ({ ...value, verificationLevel: 'production-verified' }));
  const result = run('project-implementation/scripts/verify-legacy-archive.mjs', [dir, '--require-level', 'production-verified']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid verification level/);
}));

test('implementation verifier checks that a declared source locator exists in its file', () => withCopy(implementation, (dir) => {
  const plan = readJson(`${dir}/implementation-plan.json`);
  const operationIds = [...new Set(plan.units.flatMap((unit) => unit.operationIds || []))];
  writeJson(`${dir}/implementation-provenance.json`, {
    schemaVersion: '1.0',
    backendSource: { status: 'implemented' },
    operationSources: operationIds.map((operationId) => ({ operationId, files: [{ path: 'package.json', symbol: `missing_${operationId}` }] })),
  });
  const result = run('project-implementation/scripts/verify-legacy-archive.mjs', [dir, '--require-level', 'simulated']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source locator is absent/);
}));

test('legacy archive inspection is read-only and creates no completion credentials', () => withTempImplementation((dir) => {
  mkdirSync(`${dir}/evidence`, { recursive: true });
  writeJson(`${dir}/input-lock.json`, { schemaVersion: '1.0', digests: {} });
  writeJson(`${dir}/implementation-plan.json`, { schemaVersion: '1.0', projectId: 'source-lock', units: [{ id: 'operation-op-a', operationIds: ['op-a'] }] });
  writeFileSync(`${dir}/server.mjs`, 'export function opA() { return true; }\n');
  writeJson(`${dir}/implementation-provenance.json`, { backendSource: { status: 'implemented' }, operationSources: [{ operationId: 'op-a', files: [{ path: 'server.mjs', symbol: 'opA' }] }] });
  writeJson(`${dir}/implementation-manifest.json`, { verificationLevel: 'simulated', units: [{ id: 'operation-op-a', status: 'succeeded', testIds: ['test-op-a'] }] });
  writeJson(`${dir}/integration-evidence.json`, { verificationLevel: 'simulated' });
  writeJson(`${dir}/openapi.json`, { openapi: '3.1.0', paths: {} });
  writeJson(`${dir}/startup.json`, { command: 'node server.mjs', healthUrl: 'http://127.0.0.1:${PORT}/health', requiredEnvironment: ['PORT'] });
  writeFileSync(`${dir}/evidence/op-a.txt`, 'passed\n');
  writeJson(`${dir}/test-report.json`, { cases: [{ id: 'test-op-a', status: 'passed', unitIds: ['operation-op-a'], evidence: ['evidence/op-a.txt'] }] });
  writeJson(`${dir}/inputs/frontend-api-contract.json`, { operations: [{ id: 'op-a', method: 'GET', path: '/a', response: { fields: ['ok'] } }] });
  const result = run('project-implementation/scripts/verify-legacy-archive.mjs', [dir, '--require-level', 'simulated']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: '1.0', generatedBy: 'project-implementation/verify-legacy-archive', status: 'archive-only', mutation: 'none', summary: { structurallyCheckedUnits: 1, observedPassingCases: 1 }, completionEvidence: false });
  assert.equal(existsSync(`${dir}/capability-completion-report.json`), false);
  assert.equal(existsSync(`${dir}/implementation-lock.json`), false);
}));

test('implementation verifier rejects an existing lock with removed source fields', () => withCopy(implementation, (dir) => {
  writeJson(`${dir}/implementation-lock.json`, { schemaVersion: '1.0', algorithm: 'sha256', digests: {}, sourceFiles: {} });
  const result = run('project-implementation/scripts/verify-legacy-archive.mjs', [dir, '--require-level', 'simulated']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /lock is incomplete or unsupported/);
}));

test('finalizer rejects one catch-all case for multiple units', () => withTempImplementation((dir) => {
  writeJson(`${dir}/implementation-plan.json`, { schemaVersion: '1.0', projectId: 'test', units: [{ id: 'unit-a' }, { id: 'unit-b' }] });
  writeFileSync(`${dir}/write-report.mjs`, "import {writeFileSync} from 'node:fs'; writeFileSync('evidence/unit.txt','ok'); writeFileSync('unit-test-report.json', JSON.stringify({cases:[{id:'catch-all',status:'passed',unitIds:['unit-a','unit-b'],evidence:['evidence/unit.txt']}]}));\n");
  const result = runAbsolute('project-implementation/scripts/finalize-implementation.mjs', ['--dir', dir, '--test', 'node write-report.mjs', '--build', 'true']);
  assert.notEqual(result.status, 0);
  assert.ok(readJson(`${dir}/implementation-manifest.json`).units.every((unit) => unit.status === 'failed'));
}));

test('generic campaign requires an explicit candidate contract', () => {
  const result = run('project-implementation/scripts/run-validation-campaign.mjs', [
    '--functional', functional,
    '--frontend', frontend,
    '--candidate', implementation,
    '--output', path.join(os.tmpdir(), 'unused-campaign-output'),
    '--level', 'integrated',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires candidate campaign-contract\.json/);
});

test('integrated campaign requires an application-level integrated E2E command', () => withCopy(implementation, (candidate) => {
  writeJson(`${candidate}/campaign-contract.json`, { runtime: {} });
  const result = spawnSync('node', [path.join(repo, 'project-implementation/scripts/run-validation-campaign.mjs'),
    '--functional', functional,
    '--frontend', frontend,
    '--candidate', candidate,
    '--output', path.join(os.tmpdir(), 'unused-integrated-campaign-output'),
    '--level', 'integrated',
  ], { encoding: 'utf8', env: { ...process.env, TEST_PROVIDER_KEY: 'secret' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires runtime.integratedE2e/);
}));

test('OpenAPI retains all logical operation variants on shared paths', () => {
  const api = JSON.parse(readFileSync(`${frontend}/api-contract.json`, 'utf8'));
  const openapi = JSON.parse(readFileSync(`${goldenImplementation}/openapi.json`, 'utf8'));
  const variants = Object.values(openapi.paths).flatMap((methods) => Object.values(methods)).flatMap((operation) => operation['x-operation-variants'] || []);
  assert.deepEqual(new Set(variants.map((item) => item.operationId)), new Set(api.operations.map((item) => item.id)));
});

test('finalizer emits standard OpenAPI schemas and status-specific errors', () => withTempImplementation((dir) => {
  writeJson(`${dir}/implementation-plan.json`, { schemaVersion: '1.0', projectId: 'test', units: [] });
  writeJson(`${dir}/inputs/frontend-api-contract.json`, { operations: [
    { id: 'update-item-a', method: 'POST', path: '/items/{itemId}', capabilityId: 'cap-a', request: { path: ['itemId'], body: ['name'], bodyRequired: true, discriminator: { property: 'kind', value: 'a' } }, response: { fields: ['item'] }, errors: ['ITEM_NOT_FOUND'] },
    { id: 'update-item-b', method: 'POST', path: '/items/{itemId}', capabilityId: 'cap-b', request: { path: ['itemId'], body: ['name', 'metadata'], discriminator: { property: 'kind', value: 'b' } }, response: { fields: ['item', 'metadata'] }, errors: [{ code: 'ITEM_FORBIDDEN', status: 403 }] },
  ] });
  const result = runAbsolute('project-implementation/scripts/finalize-implementation.mjs', ['--dir', dir, '--test', 'true', '--build', 'true']);
  assert.equal(result.status, 0, result.stderr);
  const openapi = readJson(`${dir}/openapi.json`);
  const operation = openapi.paths['/items/{itemId}'].post;
  assert.equal(operation.parameters[0].name, 'itemId');
  assert.equal(operation.requestBody.content['application/json'].schema.oneOf.length, 2);
  assert.equal(operation.requestBody.content['application/json'].schema.discriminator.propertyName, 'kind');
  assert.ok(operation.responses['404']);
  assert.ok(operation.responses['403']);
  assert.ok(Object.keys(openapi.components.schemas).length >= 4);
  const startup = readJson(`${dir}/startup.json`);
  assert.equal(startup.healthUrl, 'http://127.0.0.1:${PORT}/health');
  assert.deepEqual(startup.requiredEnvironment, ['PORT']);
}));

test('finalizer rejects ambiguous shared HTTP operations', () => withTempImplementation((dir) => {
  writeJson(`${dir}/implementation-plan.json`, { schemaVersion: '1.0', projectId: 'test', units: [] });
  writeJson(`${dir}/inputs/frontend-api-contract.json`, { operations: [
    { id: 'variant-a', method: 'POST', path: '/shared', capabilityId: 'cap-a', request: { body: ['value'] }, response: { fields: ['result'] } },
    { id: 'variant-b', method: 'POST', path: '/shared', capabilityId: 'cap-b', request: { body: ['value'] }, response: { fields: ['result'] } },
  ] });
  const result = runAbsolute('project-implementation/scripts/finalize-implementation.mjs', ['--dir', dir, '--test', 'true', '--build', 'true']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires request discriminators/);
}));

function withCopy(source, callback) { const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-contract-')); cpSync(source, dir, { recursive: true, filter: (item) => !item.includes('/node_modules') && !item.includes('/dist') }); if (existsSync(`${dir}/implementation-lock.json`)) rmSync(`${dir}/implementation-lock.json`); try { callback(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }
function withTempImplementation(callback) { const dir = mkdtempSync(path.join(os.tmpdir(), 'implementation-contract-')); mkdirSync(`${dir}/inputs`, { recursive: true }); writeJson(`${dir}/inputs/frontend-api-contract.json`, { operations: [] }); writeJson(`${dir}/integration-evidence.json`, { schemaVersion: '1.0', verificationLevel: 'simulated' }); try { callback(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }
function withApprovedFunctional(callback) {
  withCopy(functional, (dir) => {
    const authorAgentId = 'contract-test-author';
    const reviewerAgentId = 'contract-test-reviewer';
    patchJson(`${dir}/functional-spec.json`, (value) => ({ ...value,
      entities: (value.entities || []).map((item) => ({ ...item, identity: item.identity || { fields: ['id'] }, aggregateRoot: item.aggregateRoot ?? true, lifecycle: item.lifecycle?.length ? item.lifecycle : ['active'], constraints: item.constraints || { required: ['id'], unique: [['id']], status: { field: 'status', allowed: item.lifecycle?.length ? item.lifecycle : ['active'] } }, accessScope: item.accessScope || { ownerActor: 'creator', scope: 'owner', ownershipField: 'userId' } })),
      relationships: value.relationships || [],
      consistencyBoundaries: value.consistencyBoundaries || (value.entities || []).map((item) => ({ id: `boundary-${item.id}`, aggregateRootEntityId: item.id, entityIds: [item.id], strategy: 'atomic' })),
      capabilities: (value.capabilities || []).map((item) => ({ ...item, presentation: item.presentation || { mode: 'add-control', targetPageId: item.pageIds?.[0], preferredRegion: 'primary-content', control: { type: 'primary-button', label: item.name } } })),
      permissions: (value.permissions || []).map((item) => ({ ...item, resourceIds: (value.entities || []).map((entity) => entity.id) })),
      integrations: (value.integrations || []).map((item) => ({ ...item, capabilityIds: (value.capabilities || []).filter((capability) => capability.writesState).map((capability) => capability.id) })),
    }));
    const approvedSpec = readJson(`${dir}/functional-spec.json`); const planningGroups = ['capabilities', 'entities', 'relationships', 'consistencyBoundaries', 'journeys', 'rules', 'permissions', 'integrations'];
    patchJson(`${dir}/capability-definitions.json`, (value) => ({ ...value, ...Object.fromEntries(planningGroups.map((group) => [group, approvedSpec[group] || []])) }));
    patchJson(`${dir}/manifest.json`, (value) => ({ ...value, status: 'approved', authorAgentId, approval: { method: 'independent-agent-review', reviewerAgentId, reviewedAt: '2026-07-23T00:00:00.000Z' } }));
    patchJson(`${dir}/planning-manifest.json`, (value) => ({ ...value, status: 'approved', authorAgentId }));
    writeJson(`${dir}/planning-review-receipt.json`, { schemaVersion: '1.0', status: 'approved', workflow: 'fdd-bmad-planning', authorAgentId, reviewerAgentId, reviewedAt: '2026-07-23T00:00:00.000Z' });
    writeFileSync(`${dir}/review-receipt.json`, `${JSON.stringify({ schemaVersion: '1.0', status: 'approved', authorAgentId, reviewerAgentId, reviewedAt: '2026-07-23T00:00:00.000Z', checks: ['contract fixture'] }, null, 2)}\n`);
    const validation = run('functional-domain-design/scripts/validate-package.mjs', [dir, '--require-approved']);
    assert.equal(validation.status, 0, validation.stderr);
    callback(dir);
  });
}
function withApprovedFrontend(functionalDir, callback) {
  withCopy(frontend, (dir) => {
    const gateDigest = 'b'.repeat(64);
    const releaseBase = { schemaVersion: '1.0', suiteId: 'test-suite', runId: 'test-run', gateDigest, approvalDigest: 'c'.repeat(64), payloadManifestDigest: digestJson({ schemaVersion: '1.0', files: [] }), payloadManifest: { schemaVersion: '1.0', files: [] } };
    const releaseDigest = digestJson(releaseBase);
    patchJson(`${functionalDir}/manifest.json`, (value) => ({ ...value, visualReleaseDigest: releaseDigest }));
    patchJson(`${functionalDir}/functional-spec.json`, (value) => ({ ...value, visualSource: { sourceType: 'ai-restore-release', releaseDigest } }));
    const validation = run('functional-domain-design/scripts/validate-package.mjs', [functionalDir, '--require-approved']);
    assert.equal(validation.status, 0, validation.stderr);
    const functionalPackageDigest = digestJson(readJson(`${functionalDir}/package-lock.json`));
    writeJson(`${dir}/release-manifest.json`, { ...releaseBase, releaseDigest });
    writeJson(`${dir}/suite-gate.json`, { schemaVersion: '1.0', pass: true, gateDigest });
    writeJson(`${dir}/visual-approval.json`, { schemaVersion: '1.0', approvalDigest: releaseBase.approvalDigest });
    const sourceTreeDigest = digestTree(`${dir}/web`);
    writeJson(`${dir}/visual-source.json`, { schemaVersion: '1.0', sourceType: 'ai-restore-release', releaseManifest: 'release-manifest.json', releaseDigest, suiteGateDigest: gateDigest, pageIds: Object.keys(readJson(`${dir}/frontend-manifest.json`).pages), routes: {}, sourceTreeDigest });
    writeJson(`${dir}/visual-controls.json`, { schemaVersion: '1.0', controls: [] });
    const functionalSpec = readJson(`${functionalDir}/functional-spec.json`);
    writeJson(`${dir}/functional-spec.json`, functionalSpec);
    writeJson(`${dir}/ui-implementation-plan.json`, { schemaVersion: '1.0', capabilities: functionalSpec.capabilities.map((item) => ({ capabilityId: item.id, specificationStatus: item.specificationStatus || 'complete', presentation: item.presentation || { mode: 'add-control', targetPageId: item.pageIds?.[0], control: { type: 'button', label: item.name } }, deliveryPolicy: item.deliveryPolicy || { requiredForCompletion: true, allowedIncompleteState: 'planned' }, planningReason: item.planningReason || null, missingDecisions: item.missingDecisions || [] })) });
    const capabilityById = new Map(functionalSpec.capabilities.map((item) => [item.id, item]));
    patchJson(`${dir}/api-contract.json`, (value) => ({ ...value, operations: (value.operations || []).filter((operation) => capabilityById.get(operation.capabilityId)?.specificationStatus !== 'planned').map((operation) => ({ ...operation, ...((new Set((operation.effects || []).map((effect) => effect.entityId)).size > 1 || (operation.effects || []).some((effect) => effect.effect === 'associate')) && !operation.transaction ? { transaction: { boundary: operation.effects[0].entityId, atomic: true } } : {}) })) }));
    writeJson(`${dir}/domain-bindings.json`, { schemaVersion: '1.0', functionalPackageDigest, capabilityIds: readJson(`${functionalDir}/functional-spec.json`).capabilities.map((item) => item.id), ruleIds: readJson(`${functionalDir}/functional-spec.json`).rules.map((item) => item.id) });
    writeJson(`${dir}/runtime-contract.json`, { schemaVersion: '1.0', command: 'npm start', healthUrl: 'http://127.0.0.1:${PORT}/health', requiredEnvironment: ['PORT'] });
    writeJson(`${dir}/handoff-manifest.json`, { schemaVersion: '1.0', packageType: 'implementation-handoff', status: 'approved', authorAgentId: 'handoff-author', functionalPackageDigest, visualReleaseDigest: releaseDigest, approval: { reviewerAgentId: 'handoff-reviewer' } });
    writeJson(`${dir}/handoff-review-receipt.json`, { schemaVersion: '1.0', status: 'approved', authorAgentId: 'handoff-author', reviewerAgentId: 'handoff-reviewer', functionalPackageDigest, visualReleaseDigest: releaseDigest });
    const files = ['handoff-manifest.json', 'visual-source.json', 'release-manifest.json', 'suite-gate.json', 'visual-approval.json', 'frontend-manifest.json', 'functional-spec.json', 'visual-controls.json', 'ui-implementation-plan.json', 'api-contract.json', 'domain-bindings.json', 'runtime-contract.json', 'handoff-review-receipt.json'];
    const digests = Object.fromEntries(files.map((file) => [file, digest(readFileSync(`${dir}/${file}`))]));
    digests.web = sourceTreeDigest;
    writeJson(`${dir}/handoff-lock.json`, { schemaVersion: '1.0', algorithm: 'sha256', functionalPackageDigest, visualReleaseDigest: releaseDigest, sourceTreeDigest, digests });
    callback(dir);
  });
}
function patchJson(file, transform) { const value = JSON.parse(readFileSync(file, 'utf8')); writeFileSync(file, `${JSON.stringify(transform(value), null, 2)}\n`); }
function makePlanned(capability) {
  const reason = 'Business semantics are not evidenced yet';
  const presentation = { ...(capability.presentation || {}), behavior: 'planned-state', primaryOperationId: null, plannedState: { title: capability.name, message: '功能待实现', capabilitySpecific: true } };
  if (presentation.surface?.contentContract) presentation.surface = { ...presentation.surface, contentContract: { ...presentation.surface.contentContract, inputIds: [], primaryAction: null, primaryOperationId: null, emptyState: '功能待实现' } };
  return { ...capability, inputs: [], inputSchema: null, outcomes: [], outputSchema: null, operations: [], entityEffects: [], writesState: false, ruleIds: [], failures: [], acceptanceCriteria: [`Opening ${capability.name} shows 功能待实现 without a business request`], acceptanceExamples: [], specificationStatus: 'planned', planningReason: reason, missingDecisions: [reason], deliveryPolicy: { requiredForCompletion: false, allowedIncompleteState: 'planned', uiBehavior: 'show-planned-state' }, presentation, capabilityIntent: capability.capabilityIntent ? { ...capability.capabilityIntent, inputs: [], processingSemantics: { mode: 'undetermined', reason }, outputs: [], sideEffects: [], downstreamUsage: [], qualityCriteria: [], failures: [] } : capability.capabilityIntent };
}
function run(script, args) { return spawnSync('node', [path.join(repo, script), ...args], { encoding: 'utf8' }); }
function runAbsolute(script, args) { return spawnSync('node', [path.join(repo, script), ...args], { encoding: 'utf8' }); }
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function digestJson(value) { return digest(Buffer.from(canonical(value), 'utf8')); }
function canonical(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; }
function digestTree(root) {
  const files = spawnSync('find', [root, '-type', 'f'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).filter((file) => !file.includes('/node_modules/') && !file.includes('/dist/')).sort();
  return digestJson(files.map((file) => ({ path: file.slice(root.length + 1), size: readFileSync(file).length, sha256: digest(readFileSync(file)) })));
}
