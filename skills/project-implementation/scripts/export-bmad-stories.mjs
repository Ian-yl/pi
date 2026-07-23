#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
const args = parseArgs(process.argv.slice(2));
if (!args.implementation) usage();
const root = resolve(args.implementation); const plan = JSON.parse(readFileSync(`${root}/implementation-plan.json`, 'utf8')); const output = resolve(args.output || `${root}/_bmad-output`);
const outputRelative = relative(root, output).replaceAll('\\', '/');
if (!outputRelative || outputRelative === '..' || outputRelative.startsWith('../')) throw new Error('BMAD output must be inside the implementation workspace');
mkdirSync(`${output}/implementation-artifacts/stories`, { recursive: true });
const stories = [];
for (const [index, unit] of (plan.units || []).entries()) { const storyId = `1.${index + 1}`; const storyPath = `implementation-artifacts/stories/${storyId}-${safe(unit.id)}.md`; const acceptance = (unit.acceptance || []).map((item) => `- [ ] ${item}`).join('\n') || '- [ ] Unit contract is implemented'; const contract = storyContract(unit); writeFileSync(`${output}/${storyPath}`, `# Story ${storyId}: ${unit.id}\n\nStatus: ready-for-dev\n\n## Source Contract\n\n- Implementation unit: \`${unit.id}\`\n- Type: \`${unit.type}\`\n- Depends on: ${(unit.dependsOn || []).map((item) => `\`${item}\``).join(', ') || 'none'}\n- Contract digest: \`${digest(contract)}\`\n\n## Acceptance Criteria\n\n${acceptance}\n\n## Development Loop\n\nRun \`bmad-dev-story\`, then \`bmad-code-review\`. Status, task checkboxes, development notes, and review records may change; the source contract digest remains immutable.\n`); stories.push({ unitId: unit.id, storyId, storyPath, contract, contractDigest: digest(contract), status: 'ready-for-dev' }); }
writeFileSync(`${output}/implementation-artifacts/sprint-status.yaml`, `generated: true\nproject: ${JSON.stringify(String(plan.projectId || 'project'))}\ndevelopment_status:\n${stories.map((item) => `  ${JSON.stringify(item.storyId)}: ready-for-dev`).join('\n')}\n`);
writeFileSync(`${root}/bmad-traceability.json`, `${JSON.stringify({ schemaVersion: '1.0', method: 'bmad-v6', workflow: 'pi-implementation-bmad', domainAuthority: 'inputs/functional-functional-spec.json', fddPlanningSource: 'inputs/functional-planning-artifacts.json', output: outputRelative, stories }, null, 2)}\n`);
console.log(`Exported ${stories.length} BMAD stories -> ${output}`);
function safe(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function storyContract(unit) { return { unitId: unit.id, type: unit.type, dependsOn: [...(unit.dependsOn || [])], acceptance: [...(unit.acceptance || [])] }; }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function parseArgs(values) { const result = {}; for (let i = 0; i < values.length; i++) if (values[i].startsWith('--')) result[values[i].slice(2)] = values[++i]; return result; }
function usage() { console.error('Usage: export-bmad-stories.mjs --implementation <implementation-workspace> [--output <_bmad-output>]'); process.exit(2); }
