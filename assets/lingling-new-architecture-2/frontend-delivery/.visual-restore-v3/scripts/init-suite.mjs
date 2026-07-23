// Initialize a design-suite workflow from existing page restore plans.
// Usage:
//   node scripts/init-suite.mjs <suite> --pages=a,b --exemplar=a [--title=...] [--force]
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSuitePlan } from './lib/suite-config.mjs';
import { hashFiles } from './lib/suite-digest.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseInitSuiteArgs(argv) {
  const args = {
    suite: null,
    pages: null,
    exemplar: null,
    title: null,
    force: false,
  };

  for (const item of argv) {
    if (item === '--force') args.force = true;
    else if (item.startsWith('--pages=')) args.pages = parsePageList(item.slice('--pages='.length));
    else if (item.startsWith('--exemplar=')) args.exemplar = item.slice('--exemplar='.length).trim();
    else if (item.startsWith('--title=')) args.title = item.slice('--title='.length).trim();
    else if (item.startsWith('--')) throw new Error(`unknown option: ${item}`);
    else if (!args.suite) args.suite = item.trim();
    else throw new Error(`unexpected argument: ${item}`);
  }

  validateSuiteIdentifier(args.suite, 'suite identifier');
  if (!args.pages || args.pages.length === 0) throw new Error('--pages must contain at least one page');
  if (!args.exemplar) throw new Error('--exemplar is required');
  validateIdentifier(args.exemplar, 'exemplar');
  if (!args.pages.includes(args.exemplar)) throw new Error('exemplar must be included in --pages');
  if (args.title !== null && !args.title) throw new Error('--title must not be empty');
  args.title ??= args.suite;
  return args;
}

export const parseInitArgs = parseInitSuiteArgs;
export const parseArgs = parseInitSuiteArgs;

export function buildInitialSuitePlan(
  args,
  { root = process.cwd(), capturePaths = new Map(), assetOutputs = [] } = {},
) {
  const suiteId = validateSuiteIdentifier(args.suite, 'suite identifier');
  const pages = args.pages.map((name) => ({
    name: validateIdentifier(name, 'page identifier'),
    required: true,
    relationships: [],
  }));
  const raw = {
    schemaVersion: '1.0',
    suiteId,
    title: String(args.title || suiteId).trim(),
    exemplar: args.exemplar,
    pages,
    shared: {
      sources: [
        `suites/${suiteId}/CONVENTIONS.md`,
        `suites/${suiteId}/normalizations.json`,
        `suites/${suiteId}/shared/tokens.css`,
        `suites/${suiteId}/shared/components.css`,
      ],
      components: [],
    },
    consistency: { regions: [] },
    gate: {
      strictPages: true,
      blockingSeverities: ['P0', 'P1'],
    },
    publication: {
      include: [
        `suites/${suiteId}/shared/tokens.css`,
        `suites/${suiteId}/shared/components.css`,
        ...new Set(pages.map((page) => (
          capturePaths.get(page.name) ?? `pages/${page.name}/index.html`
        ))),
        ...assetOutputs,
      ],
    },
  };
  return normalizeSuitePlan(raw, { root, suiteId });
}

export function buildSuiteFiles(plan) {
  const suiteRoot = `suites/${plan.suiteId}`;
  return new Map([
    [`${suiteRoot}/suite-plan.json`, `${JSON.stringify(plan, null, 2)}\n`],
    [`${suiteRoot}/CONVENTIONS.md`, conventionsFor(plan)],
    [`${suiteRoot}/normalizations.json`, '{\n  "schemaVersion": "1.0",\n  "decisions": []\n}\n'],
    [`${suiteRoot}/shared/tokens.css`, tokensTemplate(plan)],
    [`${suiteRoot}/shared/components.css`, componentsTemplate(plan)],
  ]);
}

export async function initializeSuite(args, { root = process.cwd() } = {}) {
  const projectRoot = resolve(root);
  const normalizedArgs = normalizeInitOptions(args);
  const { capturePaths, assetOutputs } = validateRestorePlans(normalizedArgs, projectRoot);
  const plan = buildInitialSuitePlan(normalizedArgs, {
    root: projectRoot,
    capturePaths,
    assetOutputs,
  });
  const files = buildSuiteFiles(plan);
  assertExistingDirectoryChainIsSafe(projectRoot, `suites/${plan.suiteId}`);

  const actions = preflightWrites(projectRoot, files, normalizedArgs.force);
  for (const action of actions) {
    if (action.kind === 'unchanged') continue;
    mkdirSync(dirname(action.absolutePath), { recursive: true });
    atomicWrite(action.absolutePath, action.content);
  }

  return {
    suiteId: plan.suiteId,
    plan,
    created: actions.filter((action) => action.kind === 'create').map((action) => action.path),
    overwritten: actions.filter((action) => action.kind === 'overwrite').map((action) => action.path),
    unchanged: actions.filter((action) => action.kind === 'unchanged').map((action) => action.path),
  };
}

export async function main(
  argv = process.argv.slice(2),
  {
    root = resolve(process.env.VISUAL_RESTORE_ROOT || DEFAULT_ROOT),
    logger = console.log,
  } = {},
) {
  const args = parseInitSuiteArgs(argv);
  const result = await initializeSuite(args, { root });
  logger(`Suite initialized: ${result.suiteId}`);
  logger(`Created ${result.created.length}, overwritten ${result.overwritten.length}, unchanged ${result.unchanged.length}`);
  return result;
}

function normalizeInitOptions(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('suite initialization options must be an object');
  }
  const pages = parsePageList(Array.isArray(args.pages) ? args.pages.join(',') : args.pages);
  const suite = validateSuiteIdentifier(args.suite, 'suite identifier');
  const exemplar = validateIdentifier(args.exemplar, 'exemplar');
  if (!pages.includes(exemplar)) throw new Error('exemplar must be included in pages');
  const title = String(args.title || suite).trim();
  if (!title) throw new Error('title must not be empty');
  return { suite, pages, exemplar, title, force: args.force === true };
}

function validateRestorePlans(args, projectRoot) {
  const paths = args.pages.map((page) => `pages/${page}/restore-plan.json`);
  hashFiles(projectRoot, paths);
  const capturePaths = new Map();
  const assetOutputs = new Set();
  for (const [index, path] of paths.entries()) {
    let restorePlan;
    try {
      restorePlan = JSON.parse(readFileSync(join(projectRoot, path), 'utf8'));
    } catch (error) {
      throw new Error(`invalid restore-plan for ${args.pages[index]}: ${error.message}`);
    }
    if (!restorePlan || typeof restorePlan !== 'object' || Array.isArray(restorePlan)) {
      throw new Error(`restore-plan for ${args.pages[index]} must be a JSON object`);
    }
    if (restorePlan.name !== undefined && restorePlan.name !== args.pages[index]) {
      throw new Error(`restore-plan name does not match page ${args.pages[index]}`);
    }
    capturePaths.set(
      args.pages[index],
      normalizeProjectPath(
        restorePlan.capture?.path ?? `pages/${args.pages[index]}/index.html`,
        `restore-plan capture.path for ${args.pages[index]}`,
      ),
    );
    const assetPlanPath = `pages/${args.pages[index]}/asset-plan.json`;
    let assetPlanExists = false;
    try {
      lstatSync(join(projectRoot, assetPlanPath));
      assetPlanExists = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (assetPlanExists) {
      hashFiles(projectRoot, [assetPlanPath]);
      let assetPlan;
      try {
        assetPlan = JSON.parse(readFileSync(join(projectRoot, assetPlanPath), 'utf8'));
      } catch (error) {
        throw new Error(`invalid asset-plan for ${args.pages[index]}: ${error.message}`);
      }
      const assets = assetPlan?.assets ?? [];
      if (!Array.isArray(assets)) {
        throw new Error(`asset-plan assets for ${args.pages[index]} must be an array`);
      }
      for (const [assetIndex, asset] of assets.entries()) {
        if (asset?.output === undefined) continue;
        assetOutputs.add(normalizeProjectPath(
          asset.output,
          `asset-plan assets[${assetIndex}].output for ${args.pages[index]}`,
        ));
      }
    }
  }
  return { capturePaths, assetOutputs: [...assetOutputs] };
}

function normalizeProjectPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a relative path`);
  const path = value.trim();
  if (
    isAbsolute(path)
    || /^[a-zA-Z]:[\\/]/.test(path)
    || path.startsWith('\\\\')
    || path.includes('\\')
    || path.includes('\0')
  ) {
    throw new Error(`${label} must be a safe project-relative path`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
  const normalized = posix.normalize(path);
  if (normalized !== path) throw new Error(`${label} must be a normalized relative path`);
  return normalized;
}

function preflightWrites(projectRoot, files, force) {
  const actions = [];
  for (const [path, content] of files) {
    const absolutePath = join(projectRoot, ...path.split('/'));
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        actions.push({ kind: 'create', path, absolutePath, content });
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`refusing to write symlink: ${path}`);
    if (!stat.isFile()) throw new Error(`refusing to overwrite non-file: ${path}`);
    const existing = readFileSync(absolutePath, 'utf8');
    if (existing === content) {
      actions.push({ kind: 'unchanged', path, absolutePath, content });
      continue;
    }
    if (!force) throw new Error(`refusing to overwrite divergent file: ${path}; use --force`);
    actions.push({ kind: 'overwrite', path, absolutePath, content });
  }
  return actions;
}

function assertExistingDirectoryChainIsSafe(projectRoot, path) {
  let current = projectRoot;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${relative(projectRoot, current)}`);
      if (!stat.isDirectory()) throw new Error(`suite path is not a directory: ${relative(projectRoot, current)}`);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

function atomicWrite(path, content) {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
}

function parsePageList(value) {
  if (typeof value !== 'string') throw new Error('--pages is required');
  const pages = value.split(',').map((page) => page.trim()).filter(Boolean);
  if (pages.length === 0) throw new Error('--pages must contain at least one page');
  const seen = new Set();
  for (const page of pages) {
    validateIdentifier(page, 'page identifier');
    if (seen.has(page)) throw new Error(`duplicate page: ${page}`);
    seen.add(page);
  }
  return pages;
}

function validateIdentifier(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const id = value.trim();
  if (
    id === '.'
    || id === '..'
    || id.length > 160
    || /[\\/\0\x00-\x1f\x7f]/.test(id)
    || /^[a-zA-Z]:/.test(id)
  ) {
    throw new Error(`${label} must be a safe identifier`);
  }
  return id;
}

function validateSuiteIdentifier(value, label) {
  const id = validateIdentifier(value, label);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,63})$/.test(id)) {
    throw new Error(`${label} must be a lowercase kebab identifier of at most 64 characters`);
  }
  return id;
}

function conventionsFor(plan) {
  const rows = plan.pages.map((page) => (
    `| ${page.name} | pages/${page.name}/restore-plan.json | pages/${page.name}/index.html |${page.name === plan.exemplar ? ' golden exemplar' : ''} |`
  )).join('\n');
  return `# ${plan.title} Suite Conventions

## Workflow

1. **Shared-first:** sample design values into \`shared/tokens.css\`, then define reusable UI in \`shared/components.css\`.
2. **Exemplar-first:** finish and verify \`${plan.exemplar}\` before assembling dependent pages.
3. Page workers must not modify shared files. They report shared change requests to the suite owner.
4. Every page must complete a screenshot comparison self-check loop before suite audit.

## Parallel Page-Worker Discipline

1. A page worker writes only \`pages/<own>/**\`; it must not modify \`suites/${plan.suiteId}/shared/**\`, other pages, or \`designs/**\`.
2. Report shared-layer change needs to the suite owner as a structured request (file, current value, expected value, reason); only the owner edits shared sources, and a worker never forks shared component internals into its page.
3. Each worker is bound by its page convergence contract: on \`plateaued\` or \`budget-exhausted\`, stop fixing and escalate for a human decision (waive / adjust target / de-scope). Never burn unbounded repair rounds.
4. Each worker uses only its own lease-protected \`output/<page>\`; temporary files are never shared across workers.
5. The orchestrator validates every worker diff before merging; a diff touching shared sources or another page is rejected and returned for rework.
6. \`suites/${plan.suiteId}/**\`, \`releases/**\`, and \`normalizations.json\` are written exclusively by the orchestrator.

Convergence contract: \`vr:init\` writes default \`convergence\` budgets (\`maxRounds\`, \`plateauRounds\`, \`plateauEpsilonPp\`) into each page's \`restore-plan.json\`; the stop-loss relaxes no gate thresholds — it turns endless fixing into an explicit escalation decision.

## Page Matrix

| Page | Restore plan | Implementation | Role |
| --- | --- | --- | --- |
${rows}

## Normalization Decisions

Record intentional cross-page design normalizations in \`normalizations.json\`. Do not hide unintended drift as a normalization.

## Shared-Layer Rules

- Shared components and tokens are suite-owned sources.
- Page-specific layout may consume shared sources but may not override shared component internals.
- Shared findings are repaired once in the shared layer, then every required page is re-audited.
`;
}

function tokensTemplate(plan) {
  return `/* ${plan.title}: sampled design tokens. Replace placeholders from the golden exemplar. */
:root {
  --suite-token-placeholder: initial;
}
`;
}

function componentsTemplate(plan) {
  return `/* ${plan.title}: shared components. Values must reference tokens.css variables. */
@import url("./tokens.css");
`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
