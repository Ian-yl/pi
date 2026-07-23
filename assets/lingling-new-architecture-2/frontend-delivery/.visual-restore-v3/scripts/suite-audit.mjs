import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSuitePlan } from './lib/suite-config.mjs';
import { executeSuiteAudit, parseSuiteAuditArgs } from './lib/suite-audit.mjs';

export async function suiteAuditMain(
  argv = process.argv.slice(2),
  {
    root = process.env.VISUAL_RESTORE_ROOT || process.cwd(),
    stdout = process.stdout,
    execute = executeSuiteAudit,
  } = {},
) {
  const options = parseSuiteAuditArgs(argv);
  const projectRoot = resolve(root);
  const plan = loadSuitePlan(options.suiteId, { root: projectRoot });
  const result = await execute({
    root: projectRoot,
    plan,
    runId: options.runId ?? undefined,
    concurrency: options.concurrency,
    skipAssets: options.skipAssets,
    strict: options.strict,
    incremental: options.incremental,
    baselineRun: options.baselineRun ?? undefined,
  });
  const parts = [
    `Suite audit ${result.gate.pass ? 'PASS' : 'FAIL'}: ${options.suiteId}`,
    `run=${result.suiteRun.runId}`,
    `digest=${result.suiteRun.suiteResultDigest}`,
    `evidence=${result.runDir}`,
  ];
  if (options.incremental && result.suiteRun?.incremental) {
    parts.push(`reused=${(result.suiteRun.incremental.reusedPages || []).length}`);
    parts.push(`executed=${(result.suiteRun.incremental.executedPages || []).length}`);
  }
  stdout.write(parts.join(' ') + '\n');
  return result.gate.pass ? 0 : 2;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  suiteAuditMain()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error) => {
      process.stderr.write(`Suite audit failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
