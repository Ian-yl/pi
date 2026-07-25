#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const skill = `${root}/skills/project-implementation`;
const errors = [];
for (const file of ['SKILL.md', 'agents/openai.yaml', 'runtime-manifest.json']) if (!existsSync(`${skill}/${file}`)) errors.push(`missing ${file}`);
for (const file of ['prepare-implementation.mjs', 'export-bmad-stories.mjs', 'finalize-implementation.mjs', 'build-operation-receipts.mjs', 'verify-implementation.mjs', 'verify-frontend-runtime.mjs', 'run-browser-e2e.mjs', 'audit-placeholders.mjs', 'run-validation-campaign.mjs']) if (digestFile(`${root}/scripts/${file}`) !== digestFile(`${skill}/scripts/${file}`)) errors.push(`scripts/${file} differs from project source`);
if (existsSync(`${skill}/scripts/verify-real-provider.mjs`)) errors.push('product-specific provider verifier must not be bundled in the generic Skill');
for (const file of ['agents/openai.yaml', 'runtime-manifest.json']) if (!existsSync(`${root}/${file}`) || !existsSync(`${skill}/${file}`) || digestFile(`${root}/${file}`) !== digestFile(`${skill}/${file}`)) errors.push(`${file} missing or differs from project source`);
if (digestTree(`${root}/scripts/lib`) !== digestTree(`${skill}/scripts/lib`)) errors.push('scripts/lib bundle differs from project source');
if (!existsSync(`${skill}/validators`) || digestTree(`${root}/validators`) !== digestTree(`${skill}/validators`)) errors.push('trusted validator bundle differs from project source');
if (digestTree(`${root}/references`) !== digestTree(`${skill}/references`)) errors.push('references bundle differs from project source');
const skillText = existsSync(`${skill}/SKILL.md`) ? readFileSync(`${skill}/SKILL.md`, 'utf8') : '';
if (!skillText.startsWith('---\nname: project-implementation\n')) errors.push('SKILL.md frontmatter is invalid');
if (errors.length) { console.error(errors.map((item) => `- ${item}`).join('\n')); process.exit(1); }
console.log('Project implementation Skill bundle is complete and synchronized.');

function digestTree(dir) {
  const hash = createHash('sha256');
  for (const file of walk(dir)) hash.update(file.slice(dir.length + 1)).update('\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}
function digestFile(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]).sort(); }
