import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('exports every implementation unit to a traceable BMAD story', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'pi-bmad-'));
  writeFileSync(`${root}/implementation-plan.json`, `${JSON.stringify({ projectId: 'demo', units: [
    { id: 'entity-user', type: 'persistence', dependsOn: [], acceptance: ['User is persisted'] },
    { id: 'operation-create-user', type: 'api', dependsOn: ['entity-user'], acceptance: ['Returns the created user'] },
  ] })}\n`);
  const result = spawnSync(process.execPath, ['scripts/export-bmad-stories.mjs', '--implementation', root], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const traceability = JSON.parse(readFileSync(`${root}/bmad-traceability.json`, 'utf8'));
  assert.equal(traceability.method, 'bmad-v6');
  assert.equal(traceability.workflow, 'pi-implementation-bmad');
  assert.equal(traceability.domainAuthority, 'inputs/functional-functional-spec.json');
  assert.equal(traceability.fddPlanningSource, 'inputs/functional-planning-artifacts.json');
  assert.deepEqual(traceability.stories.map((item) => item.unitId), ['entity-user', 'operation-create-user']);
  for (const story of traceability.stories) assert.equal(existsSync(`${root}/${traceability.output}/${story.storyPath}`), true);
  assert.match(readFileSync(`${root}/_bmad-output/implementation-artifacts/sprint-status.yaml`, 'utf8'), /"1\.2": ready-for-dev/);
});

test('rejects a BMAD output directory outside the implementation workspace', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'pi-bmad-outside-'));
  writeFileSync(`${root}/implementation-plan.json`, `${JSON.stringify({ projectId: 'demo', units: [] })}\n`);
  const result = spawnSync(process.execPath, ['scripts/export-bmad-stories.mjs', '--implementation', root, '--output', `${root}-external`], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be inside/);
});
