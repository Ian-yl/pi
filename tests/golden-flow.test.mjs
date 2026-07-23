import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('checked-in current golden fixture passes the current verifier', () => {
  const current = path.resolve(import.meta.dirname, '../assets/golden-simulated/current/implementation');
  const result = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), current, '--require-level', 'simulated'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('golden fixture completes the current simulated flow', () => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'golden-simulated-'));
  try {
    const script = path.resolve(import.meta.dirname, '../assets/golden-simulated/generate.mjs');
    const result = spawnSync('node', [script, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(JSON.parse(readFileSync(`${output}/summary.json`, 'utf8')).status, 'verified');
    const interactions = JSON.parse(readFileSync(`${output}/implementation/interaction-manifest.json`, 'utf8')).interactions;
    const localNavigation = interactions.find((item) => item.capabilityId === 'cap-sample-local-navigation');
    assert.ok(localNavigation);
    assert.equal(Object.hasOwn(localNavigation, 'operationId'), false);
    assert.equal(interactions.some((item) => item.capabilityId === 'cap-sample-display-result'), false);
    const bindings = JSON.parse(readFileSync(`${output}/implementation/control-bindings.json`, 'utf8')).bindings;
    const dataRender = bindings.find((item) => item.capabilityId === 'cap-sample-display-result');
    assert.equal(dataRender.bindingType, 'data-render');
    assert.equal(dataRender.operationId, 'query-sample-result');
    assert.equal(dataRender.trigger, 'task-succeeded');
    const plan = JSON.parse(readFileSync(`${output}/implementation/implementation-plan.json`, 'utf8'));
    assert.equal(plan.planningSource.workflow, 'fdd-bmad-planning');
    assert.equal(plan.planningSource.semanticChangesAllowed, false);
    assert.equal(plan.implementationWorkflow, 'pi-implementation-bmad');
    const inputLock = JSON.parse(readFileSync(`${output}/implementation/input-lock.json`, 'utf8'));
    assert.ok(inputLock.sources.fddPlanningDigest);
    for (const file of ['functional-planning-manifest.json', 'functional-planning-artifacts.json', 'functional-capability-definitions.json', 'functional-planning-review-receipt.json']) assert.equal(existsSync(`${output}/implementation/inputs/${file}`), true);
    assert.ok(plan.units.some((unit) => unit.id === 'relationship-relation-submission-events'));
    assert.ok(plan.units.some((unit) => unit.id === 'consistency-boundary-submission'));
    const lock = JSON.parse(readFileSync(`${output}/implementation/implementation-lock.json`, 'utf8'));
    assert.ok(lock.sourceDigests.backend);
    assert.ok(lock.sourceDigests.frontend);
    assert.ok(lock.sourceDigests.tests);
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test('formal all-headless fixture completes without browser runtime evidence', () => {
  const output = mkdtempSync(path.join(os.tmpdir(), 'golden-headless-'));
  try {
    const script = path.resolve(import.meta.dirname, '../assets/golden-simulated/generate.mjs');
    const result = spawnSync('node', [script, '--output', output, '--headless'], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const implementation = `${output}/implementation`;
    const uiPlan = JSON.parse(readFileSync(`${implementation}/inputs/handoff-ui-implementation-plan.json`, 'utf8'));
    assert.ok(uiPlan.capabilities.length > 0);
    assert.ok(uiPlan.capabilities.every((item) => item.presentation.mode === 'headless'));
    const report = JSON.parse(readFileSync(`${implementation}/test-report.json`, 'utf8'));
    assert.equal(report.cases.some((item) => item.id.startsWith('frontend-')), false);
    assert.equal(existsSync(`${implementation}/browser-e2e-report.json`), false);
    assert.equal(existsSync(`${implementation}/frontend-runtime-report.json`), false);
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test('frontend runtime gates reject false implementation evidence', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'golden-runtime-negative-'));
  const generated = `${root}/generated`;
  try {
    const script = path.resolve(import.meta.dirname, '../assets/golden-simulated/generate.mjs');
    const result = spawnSync('node', [script, '--output', generated], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const source = `${generated}/implementation`;
    checkMutation('fake-runner', (dir) => patch(dir, 'frontend-runtime-report.json', (value) => ({ ...value, generatedBy: 'candidate-script' })), /not generated by the runtime runner/);
    checkMutation('missing-interaction-evidence', (dir) => patch(dir, 'interaction-manifest.json', (value) => { delete value.interactions[0].evidenceId; return value; }), /interaction has no browser evidence/);
    checkMutation('wrong-operation-path', (dir) => patchRuntime(dir, (value) => { value.cases.find((item) => item.observed.networkRequests.length).observed.networkRequests[0].path = '/api/wrong'; return value; }), /no matching successful API request evidence/);
    checkMutation('unsuccessful-operation-status', (dir) => patchRuntime(dir, (value) => { for (const item of value.cases) for (const request of item.observed.networkRequests || []) request.status = 404; return value; }), /no matching successful API request evidence/);
    checkMutation('constant-required-input', (dir) => patchRuntime(dir, (value) => { const evidence = value.cases.flatMap((item) => item.observed.inputBindings || []).find((item) => item.dynamic); evidence.dynamic = false; evidence.observedValue = 'fixed-constant'; return value; }), /required input binding has no operation-bound dynamic UI-to-request evidence/);
    checkMutation('ambiguous-locator', (dir) => patchRuntime(dir, (value) => { value.cases[0].observed.matchCount = 2; return value; }), /locator is absent, ambiguous/);
    checkMutation('planned-capability', (dir) => patchRuntime(dir, (value) => { value.cases[0].observed.capabilityStatus = 'planned'; return value; }), /not active and implemented|planned state/);
    checkMutation('title-only-capability-switch', (dir) => {
      const contracts = JSON.parse(readFileSync(`${dir}/inputs/handoff-ui-implementation-plan.json`, 'utf8')).capabilities.slice(0, 2);
      patch(dir, 'inputs/handoff-ui-implementation-plan.json', (value) => { for (const [index, contract] of value.capabilities.slice(0, 2).entries()) contract.presentation.surface = { type: 'same-page-workspace', requiredRegions: ['configuration-panel', 'result-panel'], contentContract: { heading: `Heading ${index}`, inputIds: ['same-input'], primaryAction: 'Run', primaryOperationId: 'same-operation', emptyState: 'Same empty state' } }; return value; });
      patchRuntime(dir, (value) => { for (const [index, item] of value.cases.filter((entry) => contracts.some((contract) => contract.capabilityId === entry.capabilityId)).entries()) item.surfaceFingerprint = { heading: `Heading ${index}`, inputIds: ['same-input'], primaryAction: 'Run', primaryOperationId: 'same-operation', emptyState: 'Same empty state', requiredRegions: ['configuration-panel', 'result-panel'] }; return value; });
    }, /share the same runtime surface fingerprint/);
    checkMutation('missing-placeholder-states', (dir) => patch(dir, 'placeholder-resolution.json', (value) => { delete value.items.find((item) => item.resolution === 'replaced-by-api-data').states.error; return value; }), /lacks complete runtime states/, 'scripts/audit-placeholders.mjs');
    checkMutation('missing-browser-report', (dir) => rmSync(`${dir}/browser-e2e-report.json`), /missing browser-e2e-report/);
    const noClick = `${root}/no-click-handler`; cpSync(source, noClick, { recursive: true });
    const serverFile = `${noClick}/backend/server.mjs`; writeFileSync(serverFile, readFileSync(serverFile, 'utf8').replace("addEventListener('click'", "addEventListener('unreachable'"));
    patch(noClick, 'frontend-runtime-config.json', (value) => ({ ...value, e2e: { ...value.e2e, timeoutMs: 3000 } }));
    const finalize = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/finalize-implementation.mjs'), '--dir', noClick], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(finalize.status, 0, 'button without click handler must fail finalization');
    const forgedBrowser = `${root}/forged-browser`; cpSync(source, forgedBrowser, { recursive: true });
    writeFileSync(`${forgedBrowser}/tests/browser-runtime.mjs`, "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.FRONTEND_RAW_REPORT, JSON.stringify({engine:'playwright',cases:[{id:'fake',capabilityId:'cap-sample',bindingId:'binding-cap-sample',locator:'implementation-control-cap-sample',mode:'add-control',status:'passed',observed:{matchCount:1,visible:true,enabled:true},artifacts:['evidence/frontend/fake.png']}]})); writeFileSync('evidence/frontend/fake.png','not-a-screenshot');\n");
    const forged = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/finalize-implementation.mjs'), '--dir', forgedBrowser], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(forged.status, 0, 'self-declared Playwright JSON without a real trace must fail finalization');
    assert.match(readFileSync(`${forgedBrowser}/evidence/browser-runtime-runner.txt`, 'utf8'), /Playwright trace|browser E2E command failed/);
    const unrelatedTrace = `${root}/unrelated-trace`; cpSync(source, unrelatedTrace, { recursive: true });
    const originalBrowser = readFileSync(`${unrelatedTrace}/tests/browser-runtime.mjs`, 'utf8'); const requireTarget = originalBrowser.match(/createRequire\(("[^"]+")\)/)[1];
    const claimedCases = JSON.parse(readFileSync(`${unrelatedTrace}/frontend-runtime-report.json`, 'utf8')).cases;
    writeFileSync(`${unrelatedTrace}/tests/browser-runtime.mjs`, `import {createRequire} from 'node:module';import {writeFileSync} from 'node:fs';const require=createRequire(${requireTarget});const {chromium}=require('playwright');const browser=await chromium.launch({headless:true});const context=await browser.newContext();await context.tracing.start({screenshots:true,snapshots:true});const page=await context.newPage();await page.goto(process.env.BASE_URL);const traceArtifact='evidence/frontend/playwright-trace.zip';await context.tracing.stop({path:traceArtifact});await browser.close();writeFileSync(process.env.FRONTEND_RAW_REPORT,JSON.stringify({engine:'playwright',traceArtifact,cases:${JSON.stringify(claimedCases)}}));\n`);
    const unrelated = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/finalize-implementation.mjs'), '--dir', unrelatedTrace], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(unrelated.status, 0, 'an unrelated page visit trace must not attest claimed cases');
    assert.match(readFileSync(`${unrelatedTrace}/evidence/browser-runtime-runner.txt`, 'utf8'), /trace has no .*case locator/);
    const duplicateAction = `${root}/duplicate-action`; cpSync(source, duplicateAction, { recursive: true });
    const duplicateScript = `${duplicateAction}/tests/browser-runtime.mjs`;
    writeFileSync(duplicateScript, readFileSync(duplicateScript, 'utf8').replace("const traceArtifact='evidence/frontend/playwright-trace.zip'", "cases.push({...cases[0],id:'browser-duplicate'});const traceArtifact='evidence/frontend/playwright-trace.zip'"));
    const duplicateCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/finalize-implementation.mjs'), '--dir', duplicateAction], { encoding: 'utf8', timeout: 30000 });
    assert.equal(duplicateCheck.signal, null, 'duplicate-action verifier must not be terminated by a signal or timeout');
    assert.notEqual(duplicateCheck.status, null, 'duplicate-action verifier must exit normally');
    assert.notEqual(duplicateCheck.status, 0, 'one trace action must not attest two cases with the same locator');
    assert.match(readFileSync(`${duplicateAction}/evidence/browser-runtime-runner.txt`, 'utf8'), /trace has no .*case locator/);
    const noBmad = `${root}/missing-bmad`; cpSync(source, noBmad, { recursive: true });
    rmSync(`${noBmad}/bmad-traceability.json`); rmSync(`${noBmad}/implementation-lock.json`);
    const bmadCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), noBmad, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(bmadCheck.status, 0, 'prepared workspace without BMAD traceability must fail');
    assert.match(`${bmadCheck.stdout}${bmadCheck.stderr}`, /missing bmad-traceability|BMAD traceability is required/);
    const missingEffect = `${root}/missing-operation-effect`; cpSync(source, missingEffect, { recursive: true }); rmSync(`${missingEffect}/implementation-lock.json`);
    patch(missingEffect, 'operation-events.json', (value) => { for (const event of value.events) event.effects = []; return value; });
    spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/build-operation-receipts.mjs'), missingEffect], { encoding: 'utf8' });
    const missingEffectCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), missingEffect, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(missingEffectCheck.status, 0); assert.match(`${missingEffectCheck.stdout}${missingEffectCheck.stderr}`, /operation receipt failed/);
    const skippedBmad = `${root}/skipped-bmad`; cpSync(source, skippedBmad, { recursive: true }); rmSync(`${skippedBmad}/implementation-lock.json`);
    patch(skippedBmad, 'bmad-completion.json', () => ({ schemaVersion: '1.0', status: 'pending', records: [] }));
    const skippedBmadCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), skippedBmad, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(skippedBmadCheck.status, 0); assert.match(`${skippedBmadCheck.stdout}${skippedBmadCheck.stderr}`, /BMAD completion is not completed|completion receipt is invalid/);
    const mutableStory = `${root}/mutable-story`; cpSync(source, mutableStory, { recursive: true }); rmSync(`${mutableStory}/implementation-lock.json`);
    const traceability = JSON.parse(readFileSync(`${mutableStory}/bmad-traceability.json`, 'utf8'));
    const mutableStoryFile = `${mutableStory}/${traceability.output}/${traceability.stories[0].storyPath}`; appendFileSync(mutableStoryFile, '\n- [x] Additional development note\n');
    patch(mutableStory, 'bmad-completion.json', (value) => { value.records.find((item) => item.unitId === traceability.stories[0].unitId).storyDigest = sha(readFileSync(mutableStoryFile, 'utf8')); return value; });
    const mutableStoryCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), mutableStory, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.equal(mutableStoryCheck.status, 0, `${mutableStoryCheck.stdout}${mutableStoryCheck.stderr}`);
    const changedContract = `${root}/changed-story-contract`; cpSync(source, changedContract, { recursive: true }); rmSync(`${changedContract}/implementation-lock.json`);
    patch(changedContract, 'bmad-traceability.json', (value) => { value.stories[0].contract.acceptance.push('new unapproved acceptance'); return value; });
    const changedContractCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), changedContract, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(changedContractCheck.status, 0); assert.match(`${changedContractCheck.stdout}${changedContractCheck.stderr}`, /immutable story contract differs/);
    const changedAcceptance = `${root}/changed-story-acceptance`; cpSync(source, changedAcceptance, { recursive: true }); rmSync(`${changedAcceptance}/implementation-lock.json`);
    const changedTrace = JSON.parse(readFileSync(`${changedAcceptance}/bmad-traceability.json`, 'utf8')); const changedStoryFile = `${changedAcceptance}/${changedTrace.output}/${changedTrace.stories[0].storyPath}`;
    writeFileSync(changedStoryFile, readFileSync(changedStoryFile, 'utf8').replace(/- \[x\] ([^\n]+)/, '- [x] weakened acceptance'));
    patch(changedAcceptance, 'bmad-completion.json', (value) => { value.records.find((item) => item.unitId === changedTrace.stories[0].unitId).storyDigest = sha(readFileSync(changedStoryFile, 'utf8')); return value; });
    const changedAcceptanceCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), changedAcceptance, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(changedAcceptanceCheck.status, 0); assert.match(`${changedAcceptanceCheck.stdout}${changedAcceptanceCheck.stderr}`, /source contract text differs/);
    const downgradedBmad = `${root}/downgraded-bmad`; cpSync(source, downgradedBmad, { recursive: true }); rmSync(`${downgradedBmad}/implementation-lock.json`); rmSync(`${downgradedBmad}/bmad-traceability.json`); rmSync(`${downgradedBmad}/bmad-completion.json`);
    patch(downgradedBmad, 'input-lock.json', (value) => { value.bmadRequired = false; delete value.bmad; return value; });
    const downgradedCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), downgradedBmad, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(downgradedCheck.status, 0); assert.match(`${downgradedCheck.stdout}${downgradedCheck.stderr}`, /missing bmad|BMAD requirement was removed/);
    const legacyOptionCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), source, '--legacy', '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(legacyOptionCheck.status, 0); assert.match(`${legacyOptionCheck.stdout}${legacyOptionCheck.stderr}`, /legacy archive inspection is not a completion-verification mode/);
    const internalLegacyOptionCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), source, '--legacy-archive-internal', '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(internalLegacyOptionCheck.status, 0); assert.match(`${internalLegacyOptionCheck.stdout}${internalLegacyOptionCheck.stderr}`, /legacy archive inspection is not a completion-verification mode/);
    const disguisedLegacy = `${root}/disguised-legacy`; cpSync(source, disguisedLegacy, { recursive: true }); rmSync(`${disguisedLegacy}/implementation-lock.json`); rmSync(`${disguisedLegacy}/bmad-traceability.json`); rmSync(`${disguisedLegacy}/bmad-completion.json`);
    patch(disguisedLegacy, 'input-lock.json', (value) => { value.schemaVersion = '1.0'; delete value.bmadRequired; delete value.bmad; delete value.sources.handoffPackageDigest; delete value.digests['handoff/handoff-manifest.json']; delete value.digests['handoff/ui-implementation-plan.json']; return value; });
    rmSync(`${disguisedLegacy}/inputs/handoff-handoff-manifest.json`); rmSync(`${disguisedLegacy}/inputs/handoff-ui-implementation-plan.json`);
    const disguisedCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), disguisedLegacy, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(disguisedCheck.status, 0); assert.match(`${disguisedCheck.stdout}${disguisedCheck.stderr}`, /formal verification requires input-lock schema 1\.1|missing bmad/);
    const markdownSpoof = `${root}/markdown-spoof`; cpSync(source, markdownSpoof, { recursive: true }); rmSync(`${markdownSpoof}/implementation-lock.json`);
    const spoofTrace = JSON.parse(readFileSync(`${markdownSpoof}/bmad-traceability.json`, 'utf8')); const spoofStory = `${markdownSpoof}/${spoofTrace.output}/${spoofTrace.stories[0].storyPath}`;
    writeFileSync(spoofStory, readFileSync(spoofStory, 'utf8').replace('Status: done', 'Status: ready-for-dev').replace('- [x] ', '- [ ] ') + '\n```markdown\nStatus: done\n- [x] spoofed task\n## Dev Agent Record\n## Code Review Record\n```\n');
    patch(markdownSpoof, 'bmad-completion.json', (value) => { value.records.find((item) => item.unitId === spoofTrace.stories[0].unitId).storyDigest = sha(readFileSync(spoofStory, 'utf8')); return value; });
    const markdownSpoofCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), markdownSpoof, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(markdownSpoofCheck.status, 0); assert.match(`${markdownSpoofCheck.stdout}${markdownSpoofCheck.stderr}`, /story tasks are not completed/);
    const yamlSpoof = `${root}/yaml-spoof`; cpSync(source, yamlSpoof, { recursive: true }); rmSync(`${yamlSpoof}/implementation-lock.json`);
    const yamlTrace = JSON.parse(readFileSync(`${yamlSpoof}/bmad-traceability.json`, 'utf8')); const sprintFile = `${yamlSpoof}/${yamlTrace.output}/implementation-artifacts/sprint-status.yaml`;
    writeFileSync(sprintFile, readFileSync(sprintFile, 'utf8').replace('  "1.1": done', '  "1.1": ready-for-dev # "1.1": done'));
    const yamlSpoofCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), yamlSpoof, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(yamlSpoofCheck.status, 0); assert.match(`${yamlSpoofCheck.stdout}${yamlSpoofCheck.stderr}`, /sprint status is not completed/);
    const duplicateCompletion = `${root}/duplicate-completion`; cpSync(source, duplicateCompletion, { recursive: true }); rmSync(`${duplicateCompletion}/implementation-lock.json`);
    patch(duplicateCompletion, 'bmad-completion.json', (value) => { value.records.push({ ...value.records[0] }, { ...value.records[0], unitId: 'unknown-unit' }); return value; });
    const duplicateCompletionCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), duplicateCompletion, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(duplicateCompletionCheck.status, 0); assert.match(`${duplicateCompletionCheck.stdout}${duplicateCompletionCheck.stderr}`, /duplicate unit/); assert.match(`${duplicateCompletionCheck.stdout}${duplicateCompletionCheck.stderr}`, /unknown unit|record set differs/);
    const missingCompletion = `${root}/missing-completion-record`; cpSync(source, missingCompletion, { recursive: true }); rmSync(`${missingCompletion}/implementation-lock.json`);
    patch(missingCompletion, 'bmad-completion.json', (value) => { value.records.shift(); return value; });
    const missingCompletionCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), missingCompletion, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(missingCompletionCheck.status, 0); assert.match(`${missingCompletionCheck.stdout}${missingCompletionCheck.stderr}`, /record set differs/);
    const incompleteInputLock = `${root}/incomplete-input-lock`; cpSync(source, incompleteInputLock, { recursive: true }); rmSync(`${incompleteInputLock}/implementation-lock.json`);
    patch(incompleteInputLock, 'input-lock.json', (value) => { delete value.digests['handoff/release-manifest.json']; return value; });
    patch(incompleteInputLock, 'inputs/handoff-release-manifest.json', (value) => ({ ...value, projectId: 'tampered-release' }));
    const incompleteInputCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), incompleteInputLock, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(incompleteInputCheck.status, 0); assert.match(`${incompleteInputCheck.stdout}${incompleteInputCheck.stderr}`, /input lock digest file set mismatch|visual release source digest mismatch/);
    const symlinkEvidence = `${root}/symlink-evidence`; cpSync(source, symlinkEvidence, { recursive: true });
    const report = JSON.parse(readFileSync(`${symlinkEvidence}/test-report.json`, 'utf8')); const manifest = JSON.parse(readFileSync(`${symlinkEvidence}/implementation-manifest.json`, 'utf8')); const unitTestIds = new Set(manifest.units.flatMap((item) => item.testIds || [])); const evidence = report.cases.find((item) => unitTestIds.has(item.id) && item.evidence?.length).evidence[0];
    const external = `${root}/external-evidence.txt`; writeFileSync(external, 'passed'); rmSync(`${symlinkEvidence}/${evidence}`); symlinkSync(external, `${symlinkEvidence}/${evidence}`); rmSync(`${symlinkEvidence}/implementation-lock.json`);
    const symlinkCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/verify-implementation.mjs'), symlinkEvidence, '--require-level', 'simulated'], { encoding: 'utf8' });
    assert.notEqual(symlinkCheck.status, 0); assert.match(`${symlinkCheck.stdout}${symlinkCheck.stderr}`, /lacks safe workspace evidence/);
    const campaignCandidate = `${root}/campaign-candidate`; cpSync(source, campaignCandidate, { recursive: true });
    writeFileSync(`${campaignCandidate}/campaign-contract.json`, JSON.stringify({ copy: ['input-lock.json'], install: [], runtime: {} }));
    const campaignCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/run-validation-campaign.mjs'), '--functional', `${generated}/functional-domain`, '--handoff', `${generated}/implementation-handoff`, '--candidate', campaignCandidate, '--output', `${root}/campaign-output`, '--level', 'simulated'], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(campaignCheck.status, 0); assert.match(`${campaignCheck.stdout}${campaignCheck.stderr}`, /targets protected implementation input/);
    writeFileSync(`${campaignCandidate}/campaign-contract.json`, JSON.stringify({ copy: ['foo/../input-lock.json'], install: [], runtime: {} }));
    const normalizedCampaignCheck = spawnSync('node', [path.resolve(import.meta.dirname, '../scripts/run-validation-campaign.mjs'), '--functional', `${generated}/functional-domain`, '--handoff', `${generated}/implementation-handoff`, '--candidate', campaignCandidate, '--output', `${root}/campaign-normalized-output`, '--level', 'simulated'], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(normalizedCampaignCheck.status, 0); assert.match(`${normalizedCampaignCheck.stdout}${normalizedCampaignCheck.stderr}`, /targets protected implementation input/);

    function checkMutation(name, mutate, pattern, verifier = 'scripts/verify-frontend-runtime.mjs') {
      const dir = `${root}/${name}`; cpSync(source, dir, { recursive: true }); mutate(dir);
      const check = spawnSync('node', [path.resolve(import.meta.dirname, `../${verifier}`), dir], { encoding: 'utf8' });
      assert.notEqual(check.status, 0, name); assert.match(`${check.stdout}${check.stderr}`, pattern, name);
    }
    function patchRuntime(dir, transform) {
      patch(dir, 'frontend-runtime-report.json', transform);
      patch(dir, 'browser-e2e-report.json', (receipt) => ({ ...receipt, runtimeCasesDigest: sha(JSON.stringify(JSON.parse(readFileSync(`${dir}/frontend-runtime-report.json`, 'utf8')).cases)) }));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function patch(dir, file, transform) { const target = `${dir}/${file}`; const value = JSON.parse(readFileSync(target, 'utf8')); writeFileSync(target, `${JSON.stringify(transform(value), null, 2)}\n`); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
