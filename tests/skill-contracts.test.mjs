import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repo = path.resolve(import.meta.dirname, '../..');
const fddHarness = path.join(repo, 'project-implementation/test-support/functional-domain-design');
const functional = path.join(repo, 'project-implementation/assets/golden-simulated/current/functional-domain');
const frontend = path.join(repo, 'project-implementation/assets/golden-simulated/current/implementation-handoff');
const goldenImplementation = path.join(repo, 'project-implementation/assets/golden-simulated/current/implementation');
const implementation = goldenImplementation;

test('functional approval gate rejects a draft package', () => withCopy(functional, (dir) => {
  patchJson(`${dir}/manifest.json`, (value) => ({ ...value, status: 'draft' }));
  const result = runFdd('validate-package.mjs', [dir, '--require-approved']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not approved/);
}));

test('implementation preparation rejects a missing independent review receipt', () => withCopy(functional, (withoutReceipt) => {
  rmSync(`${withoutReceipt}/review-receipt.json`);
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try {
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', withoutReceipt, '--handoff', frontend, '--output', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /functional package is missing review-receipt.json/);
  } finally { rmSync(output, { recursive: true, force: true }); }
}));

test('implementation preparation rejects a directory that is not an approved handoff', () => withApprovedFunctional((approved) => withCopy(frontend, (draftHandoff) => {
  patchJson(`${draftHandoff}/handoff-manifest.json`, (value) => ({ ...value, status: 'draft' }));
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try {
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', draftHandoff, '--output', output]);
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

test('implementation preparation preserves FDD-authored designed-control metadata', () => withApprovedFunctional((approved) => {
  patchJson(`${approved}/control-capability-map.json`, (value) => {
    const mapping = value.mappings.find((item) => item.capabilityId === 'cap-submission-submit-submission');
    const binding = mapping.fieldBindings.find((item) => item.requestPath === 'body.submission-category');
    Object.assign(binding, { source: 'designed-control', designedControl: { type: 'select', label: 'Category', targetRegion: 'options-section' }, rationale: 'The implementation may refine this control while preserving its approved data role.', evidenceAnchors: ['page-module:options-section'] });
    return value;
  });
  withApprovedFrontend(approved, (released) => {
    const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-designed-control-'));
    try {
      const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', released, '--output', output]);
      assert.equal(result.status, 0, result.stderr);
      const binding = readJson(`${output}/field-binding-plan.json`).bindings.find((item) => item.requestPath === 'body.submission-category');
      assert.equal(binding.source, 'designed-control');
      assert.equal(binding.controlId, 'category-select');
      assert.deepEqual(binding.designedControl, { type: 'select', label: 'Category', targetRegion: 'options-section' });
      assert.equal(binding.authoredControlBinding, true);
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
}));

test('implementation preparation never executes a handoff-supplied validator snapshot', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (released) => {
  const marker = `${released}/package-code-executed`; const malicious = `${released}/malicious.mjs`;
  writeFileSync(malicious, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  patchJson(`${released}/handoff-review-receipt.json`, (value) => ({ ...value, validatorSnapshot: { path: 'malicious.mjs', sha256: digest(readFileSync(malicious)) } }));
  patchJson(`${released}/handoff-lock.json`, (value) => { value.digests['handoff-review-receipt.json'] = digest(readFileSync(`${released}/handoff-review-receipt.json`)); return value; });
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try { const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', released, '--output', output]); assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(marker), false); }
  finally { rmSync(output, { recursive: true, force: true }); }
})));

test('implementation preparation derives result presentation units and output bindings', () => withApprovedFunctional((approved) => {
  const capability = readJson(`${approved}/functional-spec.json`).capabilities.find((item) => item.resultPresentation); const capabilityId = capability.id; const operationId = capability.operations[0].id;
  withApprovedFrontend(approved, (released) => { const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-result-output-')); try { const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', released, '--output', output]); assert.equal(result.status, 0, result.stderr); const plan = readJson(`${output}/implementation-plan.json`); assert.ok(plan.units.some((unit) => unit.id === `result-presentation-${capabilityId}`)); const binding = readJson(`${output}/field-binding-plan.json`).bindings.find((item) => item.kind === 'result' && item.capabilityId === capabilityId); assert.equal(binding.operationId, operationId); assert.equal(binding.regionId, capability.resultPresentation.targetRegion); assert.equal(binding.responsePath, capability.resultPresentation.bindings[0].responsePath.replace(/^response\./, '')); } finally { rmSync(output, { recursive: true, force: true }); } });
}));

test('implementation preparation isolates a planned capability to a reachable planned-state unit', () => withApprovedFunctional((approved) => {
  const plannedId = readJson(`${approved}/functional-spec.json`).capabilities.find((item) => item.specificationStatus === 'planned').id;
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
  const reviewerAgentId = 'republish-reviewer';
  const request = runFdd('review-package.mjs', ['--package', approved, '--reviewer-agent', reviewerAgentId, '--prepare-semantic-review']);
  assert.equal(request.status, 0, `${request.stdout}${request.stderr}`);
  writeSemanticReview(approved, reviewerAgentId);
  const validation = runFdd('review-package.mjs', ['--package', approved, '--reviewer-agent', reviewerAgentId]);
  assert.equal(validation.status, 0, `${validation.stdout}${validation.stderr}`);
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try {
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', handoff, '--output', output]);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /handoff functional package digest mismatch/);
  } finally { rmSync(output, { recursive: true, force: true }); }
})));

test('implementation preparation rejects a changed visual source tree', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (handoff) => {
  const pageFile = `${handoff}/web/pages/submission/index.html`;
  writeFileSync(pageFile, `${readFileSync(pageFile, 'utf8')}\n<!-- changed -->\n`);
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
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', dir, '--handoff', frontend, '--output', output]);
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
    const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', dir, '--handoff', frontend, '--output', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lock (?:is missing digest:|is missing required file) functional-spec.json/);
  } finally { rmSync(output, { recursive: true, force: true }); }
}));

test('implementation preparation rejects a missing UI implementation intent', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (dir) => {
    const mappedCapability = readJson(`${approved}/page-function-map.json`).pages.flatMap((page) => page.capabilityIds || []).at(-1);
    patchJson(`${dir}/ui-implementation-plan.json`, (value) => ({ ...value, capabilities: value.capabilities.filter((item) => item.capabilityId !== mappedCapability) }));
    patchJson(`${dir}/handoff-lock.json`, (value) => ({ ...value, digests: { ...value.digests, 'ui-implementation-plan.json': digest(readFileSync(`${dir}/ui-implementation-plan.json`)) } }));
    const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
    try {
      const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', dir, '--output', output]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /has no UI implementation intent/);
    } finally { rmSync(output, { recursive: true, force: true }); }
  })));

test('implementation preparation rejects duplicate UI capability contracts', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (dir) => {
  patchJson(`${dir}/ui-implementation-plan.json`, (value) => { value.capabilities.push({ ...value.capabilities[0] }); return value; });
  patchJson(`${dir}/handoff-lock.json`, (value) => ({ ...value, digests: { ...value.digests, 'ui-implementation-plan.json': digest(readFileSync(`${dir}/ui-implementation-plan.json`)) } }));
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try { const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', dir, '--output', output]); assert.notEqual(result.status, 0); assert.match(result.stderr, /exact one-to-one set/); }
  finally { rmSync(output, { recursive: true, force: true }); }
})));

test('implementation preparation rejects multipart operations without resourceTransfer', () => withApprovedFunctional((approved) => withApprovedFrontend(approved, (dir) => {
  patchJson(`${dir}/api-contract.json`, (value) => { value.operations[0].request.contentType = 'multipart/form-data'; delete value.operations[0].resourceTransfer; return value; });
  patchJson(`${dir}/handoff-lock.json`, (value) => ({ ...value, digests: { ...value.digests, 'api-contract.json': digest(readFileSync(`${dir}/api-contract.json`)) } }));
  const output = mkdtempSync(path.join(os.tmpdir(), 'implementation-output-'));
  try { const result = run('project-implementation/scripts/prepare-implementation.mjs', ['--functional', approved, '--handoff', dir, '--output', output]); assert.notEqual(result.status, 0); assert.match(result.stderr, /has no resourceTransfer contract/); }
  finally { rmSync(output, { recursive: true, force: true }); }
})));


test('integrated verification rejects evidence without an application operation', () => withCopy(implementation, (dir) => {
  patchJson(`${dir}/implementation-manifest.json`, (value) => ({ ...value, status: 'integrated', verificationLevel: 'integrated' }));
  patchJson(`${dir}/integration-evidence.json`, () => ({
    schemaVersion: '1.0',
    verificationLevel: 'integrated',
    provider: { host: 'api.example.com' },
    output: { artifact: 'evidence/missing-provider-output.png', sha256: '0'.repeat(64), bytes: 2048, width: 512, height: 512 },
  }));
  const result = run('project-implementation/scripts/verify-implementation.mjs', [dir]);
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
  const result = run('project-implementation/scripts/verify-implementation.mjs', [dir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must come through an application operation/);
}));



test('implementation verifier rejects the unsupported production-verified level', () => withCopy(implementation, (dir) => {
  patchJson(`${dir}/implementation-manifest.json`, (value) => ({ ...value, verificationLevel: 'production-verified' }));
  patchJson(`${dir}/integration-evidence.json`, (value) => ({ ...value, verificationLevel: 'production-verified' }));
  const result = run('project-implementation/scripts/verify-implementation.mjs', [dir, '--require-level', 'production-verified']);
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
  const result = run('project-implementation/scripts/verify-implementation.mjs', [dir, '--require-level', 'simulated']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source locator is absent/);
}));


test('implementation verifier rejects an existing lock with removed source fields', () => withCopy(implementation, (dir) => {
  writeJson(`${dir}/implementation-lock.json`, { schemaVersion: '1.0', algorithm: 'sha256', digests: {}, sourceFiles: {} });
  const result = run('project-implementation/scripts/verify-implementation.mjs', [dir, '--require-level', 'simulated']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /lock is incomplete or unsupported/);
}));

test('finalizer rejects one catch-all case for multiple units', () => withTempImplementation((dir) => {
  writeJson(`${dir}/implementation-plan.json`, { schemaVersion: '1.0', projectId: 'test', units: [{ id: 'unit-a' }, { id: 'unit-b' }] });
  writeFileSync(`${dir}/write-report.mjs`, "import {writeFileSync} from 'node:fs'; writeFileSync('evidence/unit.txt','ok'); writeFileSync('unit-test-report.json', JSON.stringify({cases:[{id:'catch-all',status:'passed',unitIds:['unit-a','unit-b'],evidence:['evidence/unit.txt']}]}));\n");
  const result = runAbsolute('project-implementation/scripts/finalize-implementation.mjs', ['--dir', dir, '--test', 'node write-report.mjs', '--build', 'true']);
  assert.notEqual(result.status, 0);
  assert.ok(readJson(`${dir}/implementation-manifest.json`).units.every((unit) => unit.status === 'failed'));
}));

test('generic campaign requires an explicit candidate contract', () => withCopy(implementation, (candidate) => {
  rmSync(`${candidate}/campaign-contract.json`, { force: true });
  const result = run('project-implementation/scripts/run-validation-campaign.mjs', [
    '--functional', functional,
    '--handoff', frontend,
    '--candidate', candidate,
    '--output', path.join(os.tmpdir(), 'unused-campaign-output'),
    '--level', 'integrated',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires candidate campaign-contract\.json/);
}));

test('integrated campaign requires an application-level integrated E2E command', () => withCopy(implementation, (candidate) => {
  writeJson(`${candidate}/campaign-contract.json`, { runtime: {} });
  const result = spawnSync('node', [path.join(repo, 'project-implementation/scripts/run-validation-campaign.mjs'),
    '--functional', functional,
    '--handoff', frontend,
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
  const operations = [
    { id: 'update-item-a', method: 'POST', path: '/items/{itemId}', capabilityId: 'cap-a', request: { path: ['itemId'], body: ['name'], bodyRequired: true, discriminator: { property: 'kind', value: 'a' } }, response: { fields: ['item'] }, errors: ['ITEM_NOT_FOUND'] },
    { id: 'update-item-b', method: 'POST', path: '/items/{itemId}', capabilityId: 'cap-b', request: { path: ['itemId'], body: ['name', 'metadata'], discriminator: { property: 'kind', value: 'b' } }, response: { fields: ['item', 'metadata'] }, errors: [{ code: 'ITEM_FORBIDDEN', status: 403 }] },
  ];
  writeJson(`${dir}/inputs/handoff-api-contract.json`, { operations });
  writeOperationEventEmitter(dir, operations);
  const result = runAbsolute('project-implementation/scripts/finalize-implementation.mjs', ['--dir', dir, '--test', 'node emit-operation-events.cjs', '--build', 'true']);
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
  const operations = [
    { id: 'variant-a', method: 'POST', path: '/shared', capabilityId: 'cap-a', request: { body: ['value'] }, response: { fields: ['result'] } },
    { id: 'variant-b', method: 'POST', path: '/shared', capabilityId: 'cap-b', request: { body: ['value'] }, response: { fields: ['result'] } },
  ];
  writeJson(`${dir}/inputs/handoff-api-contract.json`, { operations });
  writeOperationEventEmitter(dir, operations);
  const result = runAbsolute('project-implementation/scripts/finalize-implementation.mjs', ['--dir', dir, '--test', 'node emit-operation-events.cjs', '--build', 'true']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires request discriminators/);
}));

function withCopy(source, callback) { const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-contract-')); cpSync(source, dir, { recursive: true, filter: (item) => !item.includes('/node_modules') && !item.includes('/dist') }); if (existsSync(`${dir}/implementation-lock.json`)) rmSync(`${dir}/implementation-lock.json`); try { callback(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }
function withTempImplementation(callback) { const dir = mkdtempSync(path.join(os.tmpdir(), 'implementation-contract-')); mkdirSync(`${dir}/inputs`, { recursive: true }); writeJson(`${dir}/inputs/handoff-api-contract.json`, { operations: [] }); writeJson(`${dir}/inputs/handoff-runtime-contract.json`, { schemaVersion: '1.0', requiredEnvironment: ['PORT'], healthUrl: 'http://127.0.0.1:${PORT}/health' }); writeJson(`${dir}/inputs/handoff-ui-implementation-plan.json`, { schemaVersion: '1.0', capabilities: [] }); writeJson(`${dir}/integration-evidence.json`, { schemaVersion: '1.0', verificationLevel: 'simulated' }); try { callback(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }
function writeOperationEventEmitter(dir, operations) { const events = operations.flatMap((operation) => [{ id: `success-${operation.id}`, operationId: operation.id, request: { method: operation.method, route: operation.path, contentType: operation.request?.contentType || 'application/json', path: {}, query: {}, header: {}, body: {} }, response: { status: 200, body: {} }, authorization: { checked: true }, effects: [] }, ...(operation.errors || []).map((error, index) => ({ id: `error-${operation.id}-${index}`, operationId: operation.id, errorCode: typeof error === 'object' ? error.code : error }))]); writeFileSync(`${dir}/emit-operation-events.cjs`, `require('node:fs').writeFileSync('operation-events.json', ${JSON.stringify(JSON.stringify({ schemaVersion: '1.0', events }))});\n`); }
function withApprovedFunctional(callback) {
  withCopy(functional, (dir) => {
    const validation = runFdd('validate-package.mjs', [dir, '--require-approved']);
    assert.equal(validation.status, 0, validation.stderr);
    callback(dir);
  });
}
function withApprovedFrontend(functionalDir, callback) {
  const reviewerAgentId = 'contract-refresh-reviewer';
  const request = runFdd('review-package.mjs', ['--package', functionalDir, '--reviewer-agent', reviewerAgentId, '--prepare-semantic-review']);
  assert.equal(request.status, 0, `${request.stdout}${request.stderr}`);
  writeSemanticReview(functionalDir, reviewerAgentId);
  const domainReview = runFdd('review-package.mjs', ['--package', functionalDir, '--reviewer-agent', reviewerAgentId]);
  assert.equal(domainReview.status, 0, `${domainReview.stdout}${domainReview.stderr}`);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'approved-handoff-'));
  try {
    const release = path.join(repo, 'project-implementation/assets/golden-simulated/fixtures/visual-release');
    const build = runFdd('build-implementation-handoff.mjs', ['--functional', functionalDir, '--visual-release', release, '--output', dir, '--author-agent', 'handoff-author']);
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const review = runFdd('review-implementation-handoff.mjs', ['--handoff', dir, '--reviewer-agent', 'handoff-reviewer']);
    assert.equal(review.status, 0, `${review.stdout}${review.stderr}`);
    callback(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function writeSemanticReview(packageDir, reviewerAgentId) {
  const request = readJson(`${packageDir}/semantic-review-request.json`);
  const spec = readJson(`${packageDir}/functional-spec.json`);
  const capabilitiesByPage = new Map();
  for (const capability of spec.capabilities || []) {
    const pageId = capability.presentation?.targetPageId;
    if (!pageId) continue;
    if (!capabilitiesByPage.has(pageId)) capabilitiesByPage.set(pageId, []);
    capabilitiesByPage.get(pageId).push(capability.id);
  }
  writeJson(`${packageDir}/semantic-review.json`, { schemaVersion: '1.0', reviewerAgentId, requestDigest: request.requestDigest, status: 'approved', pageReviews: request.pageIds.map((pageId) => ({ pageId, verdict: 'approved', capabilityIds: (capabilitiesByPage.get(pageId) || []).sort(), controlIds: request.controlIds.filter((id) => id.startsWith(`${pageId}:`)).sort(), closureAssessment: 'The neutral test fixture has distinct interaction closures.', evidenceAssessment: 'The locked fixture evidence accounts for these closures.' })) });
}
function patchJson(file, transform) { const value = JSON.parse(readFileSync(file, 'utf8')); writeFileSync(file, `${JSON.stringify(transform(value), null, 2)}\n`); }
function makePlanned(capability) {
  const reason = 'Business semantics are not evidenced yet';
  const presentation = { ...(capability.presentation || {}), behavior: 'planned-state', primaryOperationId: null, plannedState: { title: capability.name, message: '功能待实现', capabilitySpecific: true } };
  if (presentation.surface?.contentContract) presentation.surface = { ...presentation.surface, contentContract: { ...presentation.surface.contentContract, inputIds: [], primaryAction: null, primaryOperationId: null, emptyState: '功能待实现' } };
  return { ...capability, inputs: [], inputSchema: null, outcomes: [], outputSchema: null, operations: [], entityEffects: [], writesState: false, ruleIds: [], failures: [], acceptanceCriteria: [`Opening ${capability.name} shows 功能待实现 without a business request`], acceptanceExamples: [], specificationStatus: 'planned', planningReason: reason, missingDecisions: [reason], deliveryPolicy: { requiredForCompletion: false, allowedIncompleteState: 'planned', uiBehavior: 'show-planned-state' }, presentation, capabilityIntent: capability.capabilityIntent ? { ...capability.capabilityIntent, inputs: [], processingSemantics: { mode: 'undetermined', reason }, outputs: [], sideEffects: [], downstreamUsage: [], qualityCriteria: [], failures: [] } : capability.capabilityIntent };
}
function run(script, args) { return spawnSync('node', [path.join(repo, script), ...args], { encoding: 'utf8' }); }
function runFdd(script, args) { return spawnSync('node', [path.join(fddHarness, 'scripts', script), ...args], { encoding: 'utf8' }); }
function runAbsolute(script, args) { return spawnSync('node', [path.join(repo, script), ...args], { encoding: 'utf8' }); }
function readJson(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function writeJson(file, value) { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function digestJson(value) { return digest(Buffer.from(canonical(value), 'utf8')); }
function canonical(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; }
