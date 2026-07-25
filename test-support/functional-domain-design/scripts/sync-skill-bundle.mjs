#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const skill = `${root}/skills/functional-domain-design`;
rmSync(`${skill}/scripts`, { recursive: true, force: true });
mkdirSync(`${skill}/scripts`, { recursive: true });
for (const file of ['import-productforge.mjs', 'scaffold-package.mjs', 'review-package.mjs', 'validate-package.mjs', 'freeze-validator.mjs', 'build-implementation-handoff.mjs', 'review-implementation-handoff.mjs', 'validate-implementation-handoff.mjs']) cpSync(`${root}/scripts/${file}`, `${skill}/scripts/${file}`);
cpSync(`${root}/scripts/lib`, `${skill}/scripts/lib`, { recursive: true });
rmSync(`${skill}/validators`, { recursive: true, force: true });
cpSync(`${root}/validators`, `${skill}/validators`, { recursive: true });
rmSync(`${skill}/scripts/profiles`, { recursive: true, force: true });
rmSync(`${skill}/references`, { recursive: true, force: true });
cpSync(`${root}/references`, `${skill}/references`, { recursive: true });
mkdirSync(`${skill}/agents`, { recursive: true });
cpSync(`${root}/agents/openai.yaml`, `${skill}/agents/openai.yaml`);
cpSync(`${root}/runtime-manifest.json`, `${skill}/runtime-manifest.json`);
console.log(`Skill bundle synchronized: ${skill}`);
