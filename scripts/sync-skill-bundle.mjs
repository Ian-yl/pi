#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const skill = `${root}/skills/project-implementation`;
rmSync(`${skill}/scripts`, { recursive: true, force: true });
mkdirSync(`${skill}/scripts`, { recursive: true });
for (const file of ['prepare-implementation.mjs', 'finalize-implementation.mjs', 'build-operation-receipts.mjs', 'verify-implementation.mjs', 'verify-legacy-archive.mjs', 'verify-frontend-runtime.mjs', 'run-browser-e2e.mjs', 'audit-placeholders.mjs', 'run-validation-campaign.mjs', 'export-bmad-stories.mjs']) cpSync(`${root}/scripts/${file}`, `${skill}/scripts/${file}`);
cpSync(`${root}/scripts/lib`, `${skill}/scripts/lib`, { recursive: true });
rmSync(`${skill}/references`, { recursive: true, force: true });
cpSync(`${root}/references`, `${skill}/references`, { recursive: true });
mkdirSync(`${skill}/agents`, { recursive: true });
cpSync(`${root}/agents/openai.yaml`, `${skill}/agents/openai.yaml`);
cpSync(`${root}/runtime-manifest.json`, `${skill}/runtime-manifest.json`);
console.log(`Skill bundle synchronized: ${skill}`);
