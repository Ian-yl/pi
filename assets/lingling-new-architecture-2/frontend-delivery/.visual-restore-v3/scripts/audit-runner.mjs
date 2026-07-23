// V3 full visual audit pipeline runner.
// Usage:
//   node scripts/audit-runner.mjs <name> [--dpr=1] [--threshold=0.1] [--skip-assets]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRemediationQueue } from './audit-queue.mjs';
import { readHistoryEntries, readLatestHistoryEntry } from './coverage-gate.mjs';
import { prepareCaptureTarget } from './lib/browser-target.mjs';
import { buildResidualReport, evaluateConvergence, formatConvergenceLine } from './lib/convergence.mjs';
import { buildRunManifest } from './lib/freshness.mjs';
import { acquirePageOutputLock } from './lib/page-output-lock.mjs';
import { resolveRestoreConfig } from './lib/restore-config.mjs';

const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const TOOL_DIR = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    name: null,
    dpr: null,
    threshold: null,
    skipAssets: false,
  };
  for (const item of argv) {
    if (item === '--skip-assets') args.skipAssets = true;
    else if (item.startsWith('--dpr=')) args.dpr = Number(item.slice('--dpr='.length));
    else if (item.startsWith('--threshold=')) args.threshold = Number(item.slice('--threshold='.length));
    else if (!args.name) args.name = item;
    else throw new Error(`未知参数: ${item}`);
  }
  if (!args.name) throw new Error('用法: node scripts/audit-runner.mjs <name> [--dpr=1] [--threshold=0.1] [--skip-assets]');
  if (args.dpr !== null && (!Number.isFinite(args.dpr) || args.dpr <= 0)) throw new Error('--dpr 必须是正数');
  if (args.threshold !== null && !Number.isFinite(args.threshold)) throw new Error('--threshold 必须是数字');
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = resolveRestoreConfig(args.name, {
    root: ROOT,
    dpr: args.dpr,
    threshold: args.threshold,
  });
  const outputLock = acquirePageOutputLock({
    root: ROOT,
    page: args.name,
    token: process.env.VISUAL_RESTORE_PAGE_LOCK_TOKEN || null,
  });
  let managedCapture = null;
  try {
    managedCapture = await prepareCaptureTarget(config);
    await executeAudit(args, config);
  } finally {
    managedCapture?.close();
    outputLock.release();
  }
}

async function executeAudit(args, config) {
  args.dpr = config.viewport.dpr;
  args.threshold = config.quality.threshold;
  const outDir = join(ROOT, 'output', args.name);
  const logDir = join(outDir, 'audit-logs');
  mkdirSync(logDir, { recursive: true });

  const commands = [];
  const run = (id, script, scriptArgs, options = {}) => {
    const result = runNodeScript(id, script, scriptArgs, { ...options, logDir });
    commands.push(result);
    return result;
  };

  run('verify', 'verify.mjs', [args.name, `--dpr=${args.dpr}`, `--threshold=${args.threshold}`]);
  run('foreground-score', 'foreground-score.mjs', [args.name, `--threshold=${args.threshold}`]);
  run('diff-components', 'diff-components.mjs', [args.name]);
  run('region-score', 'region-score.mjs', [args.name, `--threshold=${args.threshold}`]);
  run('structure-audit', 'structure-audit.mjs', [args.name, `--dpr=${args.dpr}`]);
  run('visual-inventory', 'visual-inventory.mjs', [args.name, `--dpr=${args.dpr}`]);
  run('color-audit', 'color-audit.mjs', [args.name, `--dpr=${args.dpr}`]);
  run('font-audit', 'font-audit.mjs', [args.name, `--dpr=${args.dpr}`]);
  run('full-audit', 'full-audit.mjs', [args.name, `--dpr=${args.dpr}`]);
  run('content-audit', 'content-audit.mjs', [args.name, `--dpr=${args.dpr}`]);
  if (config.responsive.enabled) {
    run('responsive-audit', 'responsive-audit.mjs', [args.name]);
  } else {
    commands.push(skippedCommand('responsive-audit', 'responsive audit disabled for this plan', {
      required: config.policy.responsiveRequired,
    }));
  }

  const assetPlanPath = join(ROOT, 'pages', args.name, 'asset-plan.json');
  if (!args.skipAssets && existsSync(assetPlanPath)) {
    run('asset-plan', 'asset-plan.mjs', [args.name]);
  } else {
    commands.push(skippedCommand(
      'asset-plan',
      args.skipAssets ? '--skip-assets' : 'pages/<name>/asset-plan.json missing',
      { required: config.policy.assetRequired },
    ));
  }

  if (!args.skipAssets) {
    run('asset-edge-audit', 'asset-edge-audit.mjs', [args.name]);
  } else {
    commands.push(skippedCommand('asset-edge-audit', '--skip-assets', { required: config.policy.assetRequired }));
  }

  run('audit-fusion', 'audit-fusion.mjs', [args.name]);

  const runManifest = buildRunManifest(args.name, config);
  writeFileSync(join(outDir, 'run-manifest.json'), `${JSON.stringify(runManifest, null, 2)}\n`);

  const ledger = buildLedger(args.name, args, commands, config);
  writeFileSync(join(outDir, 'audit-ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);
  const queue = buildQueueFromDisk(args.name, ledger);
  writeFileSync(join(outDir, 'remediation-queue.json'), `${JSON.stringify(queue, null, 2)}\n`);
  const residualPath = maybeWriteResidualReport(args.name, outDir, ledger, config);

  console.log(`V3 全量视觉审计流水线完成: output/${args.name}/audit-ledger.json`);
  console.log(`修复队列: output/${args.name}/remediation-queue.json (${queue.summary.total} 项)`);
  console.log(`命令: ${commands.map((command) => `${command.id}:${command.status}`).join(', ')}`);
  if (ledger.summary.score) console.log(`最新相似度: ${ledger.summary.score.similarity}%`);
  if (ledger.summary.foreground) console.log(`前景相似度: ${ledger.summary.foreground.foregroundSimilarity}%`);
  if (ledger.convergence) console.log(formatConvergenceLine(ledger.convergence));
  if (residualPath) console.log(`剩余差异构成报告: ${residualPath}`);
  if (ledger.summary.inventory) console.log(`视觉盘点: ${ledger.summary.inventory.total} 元素, 未闭环 ${ledger.summary.inventory.unresolved?.count || 0} 项`);
  if (ledger.summary.responsive) console.log(`响应式审计: ${ledger.summary.responsive.status}, ${ledger.summary.responsive.profiles} profiles, ${ledger.summary.responsive.blockingFindings} blocking`);
  const failed = commands.filter((command) => command.status === 'fail');
  if (failed.length) {
    throw new Error(`V3 审计包含失败的必需命令: ${failed.map((command) => command.id).join(', ')}`);
  }
}

function buildQueueFromDisk(name, ledger) {
  const outDir = join(ROOT, 'output', name);
  return buildRemediationQueue({
    name,
    ledger,
    inventory: readJsonIfExists(join(outDir, 'visual-inventory.json')),
    edgeAudit: readJsonIfExists(join(outDir, 'assets', 'edge-audit.json')),
    findings: readJsonIfExists(join(outDir, 'findings.json')),
  });
}

function readJsonIfExists(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function readJsonSafely(path) {
  try {
    return readJsonIfExists(path);
  } catch {
    return null;
  }
}

function maybeWriteResidualReport(name, outDir, ledger, config) {
  const convergence = ledger.convergence;
  if (!convergence || !['plateaued', 'budget-exhausted'].includes(convergence.status)) return null;
  const report = buildResidualReport({
    name,
    convergence,
    targets: {
      fullSimilarity: config.quality.fullSimilarity,
      foregroundSimilarity: config.quality.foregroundSimilarity,
      minRegionSimilarity: config.quality.minRegionSimilarity,
    },
    foreground: readJsonSafely(join(outDir, 'foreground-score.json')),
    diffComponents: readJsonSafely(join(outDir, 'diff-components.json')),
    regionScores: readJsonSafely(join(outDir, 'region-score.json')),
    inventorySummary: ledger.summary.inventory,
    qualityTarget: config.target,
  });
  writeFileSync(join(outDir, 'residual-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return `output/${name}/residual-report.json`;
}

function runNodeScript(id, script, args, { logDir, optional = false } = {}) {
  const started = Date.now();
  const scriptPath = join(TOOL_DIR, script);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  const durationMs = Date.now() - started;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const logPath = join(logDir, `${id}.log`);
  writeFileSync(logPath, [
    `$ node scripts/${script} ${args.join(' ')}`,
    '',
    stdout.trimEnd(),
    stderr.trimEnd() ? `\n[stderr]\n${stderr.trimEnd()}` : '',
  ].join('\n'));

  const failed = result.status !== 0;
  return {
    id,
    command: `node scripts/${script} ${args.join(' ')}`,
    status: failed ? (optional ? 'warn' : 'fail') : 'pass',
    exitCode: result.status,
    optional,
    durationMs,
    log: relativeToRoot(logPath),
    stdoutTail: tailLines(stdout, 8),
    stderrTail: tailLines(stderr, 8),
  };
}

function skippedCommand(id, reason, { required = false } = {}) {
  return {
    id,
    command: '',
    status: required ? 'fail' : 'skipped',
    optional: !required,
    exitCode: required ? 1 : null,
    durationMs: 0,
    reason,
  };
}

function buildLedger(name, args, commands, config) {
  const outDir = join(ROOT, 'output', name);
  const requiredPaths = [
    `output/${name}/design.png`,
    `output/${name}/actual.png`,
    `output/${name}/diff.png`,
    `output/${name}/delta.png`,
    `output/${name}/report.html`,
    `output/${name}/history.jsonl`,
    `output/${name}/diff-components.json`,
    `output/${name}/region-score.json`,
    `output/${name}/foreground-score.json`,
    `output/${name}/structure-audit.json`,
    `output/${name}/visual-inventory.json`,
    `output/${name}/color-audit.json`,
    `output/${name}/font-audit.json`,
    `output/${name}/full-audit.json`,
    `output/${name}/content-audit.json`,
    `output/${name}/findings.json`,
    `output/${name}/run-manifest.json`,
  ];
  if (config.policy.responsiveRequired) {
    requiredPaths.push(`output/${name}/responsive-audit.json`);
    for (const profile of config.responsive.profiles) {
      requiredPaths.push(`output/${name}/responsive/${profile.id}.png`);
    }
  }
  const optionalPaths = [
    `pages/${name}/restore-plan.json`,
    `pages/${name}/asset-plan.json`,
    `output/${name}/assets/asset-report.json`,
    `output/${name}/assets/edge-audit.json`,
  ];
  if (!config.policy.responsiveRequired) optionalPaths.push(`output/${name}/responsive-audit.json`);

  const historyPath = join(outDir, 'history.jsonl');
  const inventoryPath = join(outDir, 'visual-inventory.json');
  const foregroundPath = join(outDir, 'foreground-score.json');
  const assetReportPath = join(outDir, 'assets', 'asset-report.json');
  const edgeReportPath = join(outDir, 'assets', 'edge-audit.json');
  const findingsPath = join(outDir, 'findings.json');
  const responsivePath = join(outDir, 'responsive-audit.json');
  const inventory = existsSync(inventoryPath) ? JSON.parse(readFileSync(inventoryPath, 'utf8')) : null;
  const foreground = existsSync(foregroundPath) ? JSON.parse(readFileSync(foregroundPath, 'utf8')) : null;
  const assetReport = existsSync(assetReportPath) ? JSON.parse(readFileSync(assetReportPath, 'utf8')) : null;
  const edgeReport = existsSync(edgeReportPath) ? JSON.parse(readFileSync(edgeReportPath, 'utf8')) : null;
  const findings = existsSync(findingsPath) ? JSON.parse(readFileSync(findingsPath, 'utf8')) : null;
  const responsive = config.responsive.enabled && existsSync(responsivePath)
    ? JSON.parse(readFileSync(responsivePath, 'utf8'))
    : null;
  const historySource = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '';
  const convergence = evaluateConvergence({
    entries: readHistoryEntries(historySource),
    ...config.convergence,
    targetScore: config.quality.fullSimilarity,
    targetForeground: config.quality.foregroundSimilarity,
    foregroundScore: typeof foreground?.foregroundSimilarity === 'number' ? foreground.foregroundSimilarity : null,
  });

  return {
    version: 3,
    name,
    generatedAt: new Date().toISOString(),
    convergence,
    run: {
      dpr: args.dpr,
      threshold: args.threshold,
      skipAssets: args.skipAssets,
      config: {
        source: config.source,
        target: config.target,
        fullSimilarity: config.quality.fullSimilarity,
        foregroundSimilarity: config.quality.foregroundSimilarity,
        minRegionSimilarity: config.quality.minRegionSimilarity,
        responsiveEnabled: config.responsive.enabled,
        responsiveProfiles: config.responsive.profiles,
      },
    },
    commands,
    artifacts: {
      required: requiredPaths.map((path) => artifact(path)),
      optional: optionalPaths.map((path) => artifact(path)),
    },
    summary: {
      score: readLatestHistoryEntry(historySource),
      foreground,
      inventory: inventory?.summary || null,
      assets: assetReport || null,
      assetEdges: edgeReport?.summary || null,
      findings: findings?.summary || null,
      responsive: responsive?.summary || null,
      warnings: buildWarnings(commands, inventory?.summary, assetReport, edgeReport, findings?.summary, responsive?.summary),
    },
  };
}

function buildWarnings(commands, inventorySummary, assetReport, edgeReport, findingSummary, responsiveSummary) {
  const warnings = [];
  for (const command of commands) {
    if (command.status === 'warn') warnings.push(`${command.id} exited ${command.exitCode}; see ${command.log}`);
    if (command.status === 'skipped') warnings.push(`${command.id} skipped: ${command.reason}`);
  }
  if (inventorySummary?.unresolved?.count) {
    warnings.push(`visual inventory has ${inventorySummary.unresolved.count} pending/fail/missing dimension entries`);
  }
  const failedAssets = assetReport?.assets?.filter((asset) => !asset.pass) || [];
  if (failedAssets.length) warnings.push(`asset-plan has ${failedAssets.length} assets below quality gate`);
  if (edgeReport?.summary?.failAssets) warnings.push(`asset edge audit found issues in ${edgeReport.summary.failAssets} assets`);
  if (findingSummary?.open) warnings.push(`audit findings open: ${findingSummary.open}`);
  if (responsiveSummary?.blockingFindings) warnings.push(`responsive audit has ${responsiveSummary.blockingFindings} blocking findings`);
  return warnings;
}

function artifact(path) {
  return {
    path,
    exists: existsSync(join(ROOT, path)),
  };
}

function tailLines(value, count) {
  return String(value || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-count);
}

function relativeToRoot(file) {
  return file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
