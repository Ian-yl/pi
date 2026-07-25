import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Shared golden dev-completion for BMAD stories. Used both by the direct golden flow (generate.mjs) and by
// the campaign candidate setup (which completes the freshly re-prepared stories in place, because the
// campaign runner re-prepares a clean ready-for-dev workspace and forbids copying _bmad-output). The two
// paths must stay byte-identical so the completion digests verify, hence one source of truth here.
export function completeBmad(dir) {
  const trace = readJSON(`${dir}/bmad-traceability.json`);
  const units = new Map((readJSON(`${dir}/implementation-plan.json`).units || []).map((unit) => [unit.id, unit]));
  const provenanceFiles = new Map((readJSON(`${dir}/implementation-provenance.json`).operationSources || []).map((source) => [source.operationId, (source.files || []).map((location) => location.path)]));
  const records = [];
  for (const story of trace.stories) {
    const file = `${dir}/${trace.output}/${story.storyPath}`;
    const original = readFileSync(file, 'utf8');
    const changedFiles = unitChangedFiles(dir, units.get(story.unitId) || {}, provenanceFiles);
    const acceptance = ([...original.matchAll(/- \[[ x]\] (.+)/g)].map((match) => match[1].trim())[0]) || 'Unit contract is implemented';
    const completed = original.replace('Status: ready-for-dev', 'Status: done').replaceAll('- [ ]', '- [x]') + `\n## Dev Agent Record\n\n- Agent: golden-dev\n- Status: completed\n- Files: ${changedFiles.map((path) => `\`${path}\``).join(', ')}\n\n## Code Review Record\n\n- Reviewer: golden-reviewer\n- Status: approved\n- Verified acceptance: ${acceptance}\n`;
    writeFileSync(file, completed);
    records.push({ unitId: story.unitId, storyId: story.storyId, storyDigest: sha(completed), devStory: { status: 'completed', agentId: 'golden-dev', completedAt: '2026-01-01T00:00:00.000Z', changedFiles }, codeReview: { status: 'approved', reviewerAgentId: 'golden-reviewer', reviewedAt: '2026-01-01T00:01:00.000Z' } });
  }
  const sprint = `${dir}/${trace.output}/implementation-artifacts/sprint-status.yaml`;
  writeFileSync(sprint, readFileSync(sprint, 'utf8').replaceAll('ready-for-dev', 'done'));
  writeJSON(`${dir}/bmad-completion.json`, { schemaVersion: '1.0', status: 'completed', records });
}
function unitChangedFiles(dir, unit, provenanceFiles) {
  const fromProvenance = [...new Set((unit.operationIds || []).flatMap((id) => provenanceFiles.get(id) || []))];
  if (fromProvenance.length) return fromProvenance;
  const type = String(unit.type || '');
  if (type.startsWith('ui-') && existsSync(`${dir}/web/pages/submission/index.html`)) return ['web/pages/submission/index.html'];
  if (['persistence', 'consistency'].includes(type)) return ['migrations/001-submissions.sql'];
  if (type === 'e2e' && existsSync(`${dir}/tests/browser-runtime.mjs`)) return ['tests/browser-runtime.mjs'];
  return ['backend/server.mjs'];
}
function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJSON(path, value) { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
