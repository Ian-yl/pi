import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySuiteRun } from './lib/suite-release.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;

export async function runSuiteGateCli(
  argv = process.argv.slice(2),
  {
    root,
    env = process.env,
    stdout = process.stdout,
    verify = verifySuiteRun,
  } = {},
) {
  const args = parseArgs(argv);
  const projectRoot = resolve(root ?? args.root ?? env.VISUAL_RESTORE_ROOT ?? DEFAULT_ROOT);
  const result = verify({
    root: projectRoot,
    suiteId: args.suiteId,
    runId: args.runId,
  });
  const gate = result.gate;
  // Runs recorded before per-page adjudication lack pages/partial in the gate
  // JSON; fall back to the recomputed gate derived from the same evidence.
  const pages = gate.pages ?? result.recomputedGate?.pages;
  const partial = gate.partial ?? result.recomputedGate?.partial;
  if (args.json) {
    const output = {
      ...gate,
      ...(pages === undefined ? {} : { pages }),
      ...(partial === undefined ? {} : { partial }),
    };
    stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    stdout.write(`Suite gate ${gate.pass ? 'PASS' : 'FAIL'}: ${args.suiteId} run=${args.runId} digest=${gate.gateDigest}\n`);
    for (const page of pages ?? []) {
      const verdict = page.pageGatePass === true ? 'PASS' : 'FAIL';
      const kind = page.required === false ? ' (optional)' : '';
      const reasons = Array.isArray(page.reasons) && page.reasons.length
        ? ` — ${page.reasons.join('; ')}`
        : '';
      stdout.write(`  page ${page.name}: ${verdict}${kind}${reasons}\n`);
    }
    if (partial !== undefined) {
      if (partial.eligible === true) {
        const excluded = (partial.excludedPages || []).map(({ name }) => name).join(',');
        stdout.write(`  partial: eligible publishable=${(partial.publishablePages || []).join(',')} excluded=${excluded}\n`);
      } else {
        const reasons = Array.isArray(partial.reasons) && partial.reasons.length
          ? ` — ${partial.reasons.join('; ')}`
          : '';
        stdout.write(`  partial: not eligible${reasons}\n`);
      }
    }
  }
  return gate.pass === true ? 0 : 2;
}

function parseArgs(argv) {
  const values = { suiteId: null, runId: null, root: undefined, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      values.json = true;
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
    else values.root = value;
  }
  if (!SAFE_ID.test(String(values.suiteId || ''))) throw new Error('suite id must be a safe lowercase identifier');
  if (!values.runId) throw new Error('--run is required');
  if (!SAFE_ID.test(values.runId)) throw new Error('--run must be a safe lowercase identifier');
  return values;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runSuiteGateCli()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      process.stderr.write(`suite gate failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
