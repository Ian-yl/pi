import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publishSuiteRun } from './lib/suite-release.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function runSuitePublishCli(
  argv = process.argv.slice(2),
  {
    root,
    clock,
    env = process.env,
    stdout = process.stdout,
  } = {},
) {
  const args = parseArgs(argv);
  const projectRoot = resolve(root ?? args.root ?? env.VISUAL_RESTORE_ROOT ?? DEFAULT_ROOT);
  const result = publishSuiteRun({
    root: projectRoot,
    suiteId: args.suiteId,
    runId: args.runId,
    partial: args.partial,
    clock,
  });
  const state = result.idempotent ? 'already published' : 'published';
  const partialSuffix = result.releaseManifest.partial === true
    ? ` partial excluded=${(result.releaseManifest.excludedPages || []).join(',')}`
    : '';
  stdout.write(`suite release: ${args.suiteId}/${result.releaseManifest.suiteResultDigest} ${state}${partialSuffix}\n`);
  return 0;
}

function parseArgs(argv) {
  const values = { suiteId: null, runId: null, root: undefined, partial: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--partial') {
      values.partial = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      if (values.suiteId !== null) throw new Error(`unexpected argument: ${argument}`);
      values.suiteId = argument;
      continue;
    }
    const equal = argument.indexOf('=');
    const key = argument.slice(2, equal < 0 ? undefined : equal);
    const value = equal < 0 ? argv[++index] : argument.slice(equal + 1);
    if (!['run', 'root'].includes(key)) throw new Error(`unknown option: --${key}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    if (key === 'run') values.runId = value;
    else values[key] = value;
  }
  if (!values.suiteId) throw new Error('suite id is required');
  if (!values.runId) throw new Error('--run is required');
  return values;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runSuitePublishCli().catch((error) => {
    process.stderr.write(`suite publish failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
