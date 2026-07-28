import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(root, 'assets/golden-simulated/current/implementation');
const verifyImpl = path.resolve(root, 'scripts/verify-implementation.mjs');
const verifyFrontend = path.resolve(root, 'scripts/verify-frontend-runtime.mjs');
const buildReceipts = path.resolve(root, 'scripts/build-operation-receipts.mjs');
const runBrowser = path.resolve(root, 'scripts/run-browser-e2e.mjs');

// --- Group 2 · anti-scripting guardrails -------------------------------------

test('gate A rejects schema-shaped operation events that skip the acceptance example', () => {
  const dir = copyGolden('gate-a-schema-shape');
  try {
    rmSync(`${dir}/implementation-lock.json`);
    const api = readJSON(`${dir}/inputs/handoff-api-contract.json`);
    const operations = new Map(api.operations.map((operation) => [operation.id, operation]));
    patch(dir, 'operation-events.json', (doc) => {
      for (const event of doc.events) {
        const operation = operations.get(event.operationId);
        if (!operation || event.response.status < 200 || event.response.status >= 300) continue;
        event.request.body = schemaSample(operation.request?.bodySchema);
        event.response.body = schemaSample(operation.response?.bodySchema);
      }
      return doc;
    });
    const rebuild = spawnSync('node', [buildReceipts, dir], { encoding: 'utf8' });
    assert.notEqual(rebuild.status, 0);
    assert.match(`${rebuild.stdout}${rebuild.stderr}`, /acceptance example is not proven/);
    const check = spawnSync('node', [verifyImpl, dir, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(check.status, 0);
    assert.match(`${check.stdout}${check.stderr}`, /operation receipt failed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('formal verifier rejects an OpenAPI document that omits an approved FDD operation', () => {
  const dir = copyGolden('openapi-operation-closure');
  try {
    rmSync(`${dir}/implementation-lock.json`);
    patch(dir, 'openapi.json', (openapi) => {
      const methods = Object.values(openapi.paths)[0];
      const operation = Object.values(methods)[0];
      operation['x-operation-variants'] = operation['x-operation-variants'].slice(1);
      return openapi;
    });
    const check = spawnSync('node', [verifyImpl, dir, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(check.status, 0);
    assert.match(`${check.stdout}${check.stderr}`, /OpenAPI operation set must exactly match the approved FDD API contract/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gate B rejects three non-GET operations wired to one catch-all handler', () => {
  const dir = copyGolden('gate-b-catch-all');
  try {
    rmSync(`${dir}/implementation-lock.json`);
    patch(dir, 'inputs/handoff-api-contract.json', (api) => {
      const clone = JSON.parse(JSON.stringify(api.operations.find((item) => item.id === 'upload-submission-upload-resource')));
      clone.id = 'extra-op-c';
      clone.path = '/api/pages/submission/capabilities/extra/c';
      api.operations.push(clone);
      return api;
    });
    patch(dir, 'implementation-provenance.json', (provenance) => {
      const api = readJSON(`${dir}/inputs/handoff-api-contract.json`);
      provenance.operationSources = api.operations
        .filter((operation) => operation.method !== 'GET')
        .map((operation) => ({ operationId: operation.id, files: [{ path: 'backend/server.mjs', symbol: 'createSubmission' }] }));
      return provenance;
    });
    const check = spawnSync('node', [verifyImpl, dir, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(check.status, 0);
    assert.match(`${check.stdout}${check.stderr}`, /each operation requires operation-specific handling; a single catch-all handler is not an implementation/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gate C rejects a story dev record with no changed-file provenance', () => {
  const dir = copyGolden('gate-c-empty-files');
  try {
    rmSync(`${dir}/implementation-lock.json`);
    const trace = readJSON(`${dir}/bmad-traceability.json`);
    const story = trace.stories.find((item) => item.unitId.startsWith('operation-'));
    rewriteStory(dir, trace, story, (text) => text.replace(/- Files: [^\n]*/, '- Files: '));
    const check = spawnSync('node', [verifyImpl, dir, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(check.status, 0);
    assert.match(`${check.stdout}${check.stderr}`, /dev agent record lists no changed files/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gate C rejects a code review record that cites no acceptance criterion', () => {
  const dir = copyGolden('gate-c-no-quote');
  try {
    rmSync(`${dir}/implementation-lock.json`);
    const trace = readJSON(`${dir}/bmad-traceability.json`);
    const story = trace.stories[0];
    rewriteStory(dir, trace, story, (text) => text.replace(/- Verified acceptance: [^\n]*/, '- Verified acceptance: unrelated reviewer commentary'));
    const check = spawnSync('node', [verifyImpl, dir, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(check.status, 0);
    assert.match(`${check.stdout}${check.stderr}`, /does not cite any of the story's acceptance criteria/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gate C keeps identical completion timestamps a warning, not a failure', () => {
  const dir = copyGolden('gate-c-timestamp-warning');
  try {
    rmSync(`${dir}/implementation-lock.json`);
    const check = spawnSync('node', [verifyImpl, dir, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
    assert.match(`${check.stdout}${check.stderr}`, /warning: all BMAD stories share the identical dev completion timestamp/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- Group 1 · anti-bypass guardrails ----------------------------------------

test('control provenance gate rejects an injected surrogate control', () => {
  const dir = copyGolden('provenance-surrogate');
  try {
    const page = `${dir}/web/pages/submission/index.html`;
    let html = readFileSync(page, 'utf8');
    html = html.replace('</main>', '<section class="pi-capabilities"><button id="pi-fake-submit">Run submission (debug)</button></section></main>');
    html = html.replace('</script>', "document.querySelector('#pi-fake-submit').addEventListener('click',()=>document.querySelector('#control-cap-submission-submit-submission').click());</script>");
    writeFileSync(page, html);
    const e2e = `${dir}/tests/browser-runtime.mjs`;
    writeFileSync(e2e, readFileSync(e2e, 'utf8').split('control-cap-submission-submit-submission').join('pi-fake-submit'));
    const check = spawnSync('node', [runBrowser, '--dir', dir], { encoding: 'utf8', timeout: 60000 });
    assert.notEqual(check.status, 0);
    assert.match(`${check.stdout}${check.stderr}`, /trigger element identity does not match the release control/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('layout integrity gate rejects a business action that removes release anchors', () => {
  const dir = copyGolden('layout-anchor-drop');
  try {
    const page = `${dir}/web/pages/submission/index.html`;
    let html = readFileSync(page, 'utf8');
    html = html.replace(
      "document.querySelector('[data-history-state]').textContent=data.submissionId",
      "document.querySelectorAll('main input[data-vr-id]').forEach(el=>el.remove());document.querySelector('[data-history-state]').textContent=data.submissionId"
    );
    writeFileSync(page, html);
    const check = spawnSync('node', [runBrowser, '--dir', dir], { encoding: 'utf8', timeout: 60000 });
    assert.notEqual(check.status, 0);
    assert.match(`${check.stdout}${check.stderr}`, /release layout anchors disappeared after the action/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('layout integrity gate rejects a business action that removes a region-level layout anchor', () => {
  const dir = copyGolden('layout-region-anchor-drop');
  try {
    const page = `${dir}/web/pages/submission/index.html`;
    let html = readFileSync(page, 'utf8');
    html = html.replace(
      "document.querySelector('[data-history-state]').textContent=data.submissionId",
      "document.querySelector('[data-vr-id=\"result-panel\"]').removeAttribute('data-vr-id');document.querySelector('[data-history-state]').textContent=data.submissionId"
    );
    writeFileSync(page, html);
    const check = spawnSync('node', [runBrowser, '--dir', dir], { encoding: 'utf8', timeout: 60000 });
    assert.notEqual(check.status, 0);
    assert.match(`${check.stdout}${check.stderr}`, /release layout anchors disappeared after the action/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('add-control gate rejects a control rendered outside its declared region', () => {
  const dir = copyGolden('add-control-out-of-region');
  try {
    patch(dir, 'inputs/handoff-ui-implementation-plan.json', (ui) => {
      ui.capabilities.push({ capabilityId: 'cap-add-widget', specificationStatus: 'complete', presentation: { mode: 'add-control', targetPageId: 'submission', preferredRegion: 'options-section', triggerControl: { controlId: 'add-widget-control' } }, deliveryPolicy: { requiredForCompletion: false } });
      return ui;
    });
    patchRuntime(dir, (report) => {
      const anchors = { pageId: 'submission', expected: ['title-input', 'category-select', 'quantity-input', 'upload-input', 'submit-button', 'planned-export'], present: ['title-input', 'category-select', 'quantity-input', 'upload-input', 'submit-button', 'planned-export'], missing: [] };
      report.cases.push({ id: 'browser-add-widget', capabilityId: 'cap-add-widget', bindingId: 'binding-add-widget', locator: 'add-widget-control', pageId: 'submission', event: 'click', mode: 'add-control', provenance: null, surfaceFingerprint: { heading: 'Add widget', inputIds: [], requiredRegions: [] }, observed: { matchCount: 1, visible: true, enabled: true, activeCapabilityId: 'cap-add-widget', capabilityStatus: 'implemented', domChanged: true, releaseAnchors: anchors, addControlRegion: { preferredRegion: 'options-section', withinRegion: false }, networkRequests: [], stateTransitions: [], visibleText: ['Add widget'] }, status: 'passed' });
      return report;
    });
    const check = spawnSync('node', [verifyFrontend, dir], { encoding: 'utf8' });
    assert.notEqual(check.status, 0);
    assert.match(`${check.stdout}${check.stderr}`, /add-control capability control is outside its declared region/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('golden runtime records release-control provenance and layout-anchor evidence', () => {
  const report = readJSON(`${source}/frontend-runtime-report.json`);
  const submit = report.cases.find((item) => item.id === 'browser-submit');
  assert.equal(submit.provenance.matched, true);
  assert.equal(submit.provenance.expectedControl, 'submit-button');
  assert.deepEqual(submit.observed.releaseAnchors.missing, []);
  const initial = report.cases.find((item) => item.event === 'initial-state');
  assert.deepEqual(initial.observed.releaseAnchors.missing, []);
  const planned = report.cases.find((item) => item.id === 'browser-planned');
  assert.equal(planned.provenance.matched, true);
  assert.equal(planned.provenance.expectedControl, 'planned-export');
});

// --- helpers -----------------------------------------------------------------

function copyGolden(name) { const dir = mkdtempSync(path.join(os.tmpdir(), `pi-guardrail-${name}-`)); cpSync(source, dir, { recursive: true }); return dir; }
function readJSON(file) { return JSON.parse(readFileSync(file, 'utf8')); }
function patch(dir, file, transform) { const target = `${dir}/${file}`; writeFileSync(target, `${JSON.stringify(transform(readJSON(target)), null, 2)}\n`); }
function patchRuntime(dir, transform) { patch(dir, 'frontend-runtime-report.json', transform); patch(dir, 'browser-e2e-report.json', (receipt) => ({ ...receipt, runtimeCasesDigest: sha(JSON.stringify(readJSON(`${dir}/frontend-runtime-report.json`).cases)) })); }
function rewriteStory(dir, trace, story, transform) {
  const file = `${dir}/${trace.output}/${story.storyPath}`;
  writeFileSync(file, transform(readFileSync(file, 'utf8')));
  patch(dir, 'bmad-completion.json', (completion) => { completion.records.find((record) => record.unitId === story.unitId).storyDigest = sha(readFileSync(file, 'utf8')); return completion; });
}
function schemaSample(schema) {
  return schema?.const ?? schema?.enum?.[0] ?? (schema?.type === 'object'
    ? Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, schemaSample(value)]))
    : schema?.type === 'array' ? [schemaSample(schema.items)]
      : schema?.type === 'integer' || schema?.type === 'number' ? 1
        : schema?.type === 'boolean' ? true : 'observed');
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
