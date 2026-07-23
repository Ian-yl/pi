// Quality gate for V3 restoration audits.
// Usage:
//   node scripts/coverage-gate.mjs <name> [--min-score=95] [--strict]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatConvergenceLine } from './lib/convergence.mjs';
import { buildRunManifest, compareRunManifest } from './lib/freshness.mjs';
import { findingIsOpen } from './lib/findings.mjs';
import { resolveRestoreConfig } from './lib/restore-config.mjs';

const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));

export function readLatestHistoryEntry(source) {
  const lines = String(source || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep looking for the last valid JSONL entry
    }
  }
  return null;
}

export function readHistoryEntries(source) {
  return String(source || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    })
    .filter((entry) => typeof entry.similarity === 'number');
}

export function evaluateCoverageGate({
  minScore = 95,
  minForeground = 85,
  minRegion = null,
  maxRegression = 0.2,
  strict = false,
  latestHistory = null,
  foreground = null,
  inventorySummary = null,
  ledger = null,
  regionScores = null,
  findings = null,
  responsive = null,
  responsiveRequired = false,
  freshness = undefined,
  historyEntries = [],
  strictSkipped = false,
} = {}) {
  const errors = [];
  const warnings = [];

  if (!latestHistory || typeof latestHistory.similarity !== 'number') {
    errors.push('missing latest verify score in history.jsonl');
  } else if (latestHistory.similarity < minScore) {
    errors.push(`score ${latestHistory.similarity.toFixed(4)} < min-score ${minScore}`);
  }

  const bestScore = historyEntries.length
    ? Math.max(...historyEntries.map((entry) => entry.similarity))
    : latestHistory?.similarity ?? null;
  const regression = bestScore !== null && latestHistory?.similarity !== undefined
    ? bestScore - latestHistory.similarity
    : 0;
  if (regression > maxRegression) {
    const msg = `score regression ${regression.toFixed(4)} > max-regression ${maxRegression} (best ${bestScore.toFixed(4)})`;
    if (strict) errors.push(msg);
    else warnings.push(msg);
  }

  if (foreground && typeof foreground.foregroundSimilarity === 'number') {
    if (foreground.foregroundSimilarity < minForeground) {
      errors.push(`foreground ${foreground.foregroundSimilarity.toFixed(4)} < min-foreground ${minForeground}`);
    }
  } else {
    const msg = 'missing foreground-score.json';
    if (strict) errors.push(msg);
    else warnings.push(msg);
  }

  if (!inventorySummary || typeof inventorySummary.total !== 'number') {
    errors.push('missing visual inventory summary');
  } else {
    const dimensionCounts = Object.values(inventorySummary.dimensions || {});
    const failed = dimensionCounts.reduce((sum, counts) => sum + (counts.fail || 0) + (counts.missing || 0), 0);
    const pending = dimensionCounts.reduce((sum, counts) => sum + (counts.pending || 0), 0);
    if (failed > 0) errors.push(`failed or missing visual audit items: ${failed}`);
    if (pending > 0) {
      const msg = `pending visual audit items: ${pending}`;
      if (strict) errors.push(msg);
      else warnings.push(msg);
    } else if (!dimensionCounts.length && (inventorySummary.unresolved?.count || 0) > 0) {
      const msg = `unresolved visual audit items: ${inventorySummary.unresolved.count}`;
      if (strict) errors.push(msg);
      else warnings.push(msg);
    }
  }


  if (strictSkipped && inventorySummary?.dimensions) {
    const skipped = Object.entries(inventorySummary.dimensions)
      .reduce((sum, [, counts]) => sum + (counts.skipped || 0), 0);
    if (skipped) errors.push(`strict-skipped policy rejects ${skipped} skipped dimension entries`);
  }

  if (minRegion !== null && Array.isArray(regionScores)) {
    for (const region of regionScores.filter((item) => item.required !== false)) {
      const threshold = region.minSimilarity ?? minRegion;
      if (region.similarity < threshold) {
        errors.push(`region ${region.name} ${region.similarity.toFixed(4)} < min-region ${threshold}`);
      }
    }
  }

  if (responsiveRequired) {
    if (!responsive?.summary) {
      errors.push('missing required responsive-audit.json');
    } else if (responsive.summary.status === 'skipped') {
      errors.push('required responsive audit was skipped');
    } else if (Number(responsive.summary.blockingFindings || 0) > 0) {
      errors.push(`responsive audit has ${responsive.summary.blockingFindings} blocking finding(s) across ${responsive.summary.profiles || 0} profile(s)`);
    }
  }

  const activeFindings = (findings?.findings || []).filter(findingIsOpen);
  for (const finding of activeFindings) {
    const msg = `${finding.severity} ${finding.id}: ${finding.title}`;
    if (strict || finding.severity === 'P0' || finding.severity === 'P1') errors.push(msg);
    else warnings.push(msg);
  }

  if (freshness !== undefined) {
    if (!freshness) errors.push('missing run-manifest freshness check');
    else if (!freshness.fresh) errors.push(...freshness.errors);
  }

  if (!ledger) {
    warnings.push('missing audit ledger');
  } else {
    const failedCommands = (ledger.commands || []).filter((command) => command.status === 'fail');
    if (failedCommands.length) {
      errors.push(`failed audit commands: ${failedCommands.map((command) => command.id).join(', ')}`);
    }
    const skippedRequired = (ledger.artifacts?.required || []).filter((artifact) => !artifact.exists);
    if (skippedRequired.length) {
      errors.push(`missing required artifacts: ${skippedRequired.map((artifact) => artifact.path).join(', ')}`);
    }
    for (const warning of ledger.summary?.warnings || []) {
      if (/audit findings open|visual inventory has/i.test(String(warning))) continue;
      if (strict && isStrictLedgerWarning(warning)) errors.push(warning);
      else warnings.push(warning);
    }
  }

  return {
    pass: errors.length === 0,
    strict,
    minScore,
    minForeground,
    minRegion,
    maxRegression,
    score: latestHistory?.similarity ?? null,
    foreground: foreground?.foregroundSimilarity ?? null,
    bestScore,
    regression: Number(regression.toFixed(4)),
    activeFindings: activeFindings.length,
    responsive: responsive?.summary || null,
    convergence: ledger?.convergence || null,
    fresh: freshness === undefined ? null : freshness?.fresh ?? false,
    errors,
    warnings,
  };
}

function isStrictLedgerWarning(warning) {
  return /asset edge audit found issues|asset-plan has|failed audit commands|missing required artifacts/i.test(String(warning));
}

function parseArgs(argv) {
  const args = { name: null, minScore: null, minForeground: null, minRegion: null, maxRegression: null, strict: false, json: false };
  for (const item of argv) {
    if (item === '--strict') args.strict = true;
    else if (item === '--json') args.json = true;
    else if (item.startsWith('--min-score=')) args.minScore = Number(item.slice('--min-score='.length));
    else if (item.startsWith('--min-foreground=')) args.minForeground = Number(item.slice('--min-foreground='.length));
    else if (item.startsWith('--min-region=')) args.minRegion = Number(item.slice('--min-region='.length));
    else if (item.startsWith('--max-regression=')) args.maxRegression = Number(item.slice('--max-regression='.length));
    else if (!args.name) args.name = item;
    else throw new Error(`未知参数: ${item}`);
  }
  if (!args.name) throw new Error('用法: node scripts/coverage-gate.mjs <name> [--min-score=95] [--strict]');
  if (args.minScore !== null && !Number.isFinite(args.minScore)) throw new Error('--min-score 必须是数字');
  if (args.minForeground !== null && !Number.isFinite(args.minForeground)) throw new Error('--min-foreground 必须是数字');
  if (args.minRegion !== null && !Number.isFinite(args.minRegion)) throw new Error('--min-region 必须是数字');
  if (args.maxRegression !== null && !Number.isFinite(args.maxRegression)) throw new Error('--max-regression 必须是数字');
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = resolveRestoreConfig(args.name, {
    root: ROOT,
    minScore: args.minScore,
    minForeground: args.minForeground,
    minRegion: args.minRegion,
  });
  args.minScore = config.quality.fullSimilarity;
  args.minForeground = config.quality.foregroundSimilarity;
  args.minRegion = config.quality.minRegionSimilarity;
  args.maxRegression = args.maxRegression ?? config.quality.maxRegression;
  const outDir = join(ROOT, 'output', args.name);
  const historyPath = join(outDir, 'history.jsonl');
  const inventoryPath = join(outDir, 'visual-inventory.json');
  const foregroundPath = join(outDir, 'foreground-score.json');
  const ledgerPath = join(outDir, 'audit-ledger.json');
  const regionPath = join(outDir, 'region-score.json');
  const findingsPath = join(outDir, 'findings.json');
  const responsivePath = join(outDir, 'responsive-audit.json');
  const manifestPath = join(outDir, 'run-manifest.json');

  const latestHistory = existsSync(historyPath)
    ? readLatestHistoryEntry(readFileSync(historyPath, 'utf8'))
    : null;
  const inventory = existsSync(inventoryPath)
    ? JSON.parse(readFileSync(inventoryPath, 'utf8'))
    : null;
  const foreground = existsSync(foregroundPath)
    ? JSON.parse(readFileSync(foregroundPath, 'utf8'))
    : null;
  const ledger = existsSync(ledgerPath)
    ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
    : null;
  const regionScores = existsSync(regionPath) ? JSON.parse(readFileSync(regionPath, 'utf8')) : null;
  const findings = existsSync(findingsPath) ? JSON.parse(readFileSync(findingsPath, 'utf8')) : null;
  const responsive = config.responsive.enabled && existsSync(responsivePath)
    ? JSON.parse(readFileSync(responsivePath, 'utf8'))
    : null;
  const recordedManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const currentManifest = buildRunManifest(args.name, config);
  const freshness = recordedManifest ? compareRunManifest(recordedManifest, currentManifest) : null;
  const historyEntries = existsSync(historyPath) ? readHistoryEntries(readFileSync(historyPath, 'utf8')) : [];

  const result = evaluateCoverageGate({
    minScore: args.minScore,
    minForeground: args.minForeground,
    minRegion: args.minRegion,
    maxRegression: args.maxRegression,
    strict: args.strict,
    latestHistory,
    foreground,
    inventorySummary: inventory?.summary || null,
    ledger,
    regionScores,
    findings,
    responsive,
    responsiveRequired: config.policy.responsiveRequired,
    freshness,
    historyEntries,
    strictSkipped: config.policy.strictSkipped,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`质量门禁: score=${result.score ?? '--'} min=${args.minScore} foreground=${result.foreground ?? '--'} minFg=${args.minForeground} minRegion=${args.minRegion} fresh=${result.fresh ? 'yes' : 'no'} strict=${args.strict ? 'yes' : 'no'}`);
    const convergenceLine = formatConvergenceLine(result.convergence);
    if (convergenceLine) console.log(convergenceLine);
    for (const warning of result.warnings) console.log(`WARN ${warning}`);
    for (const error of result.errors) console.log(`FAIL ${error}`);
    console.log(result.pass ? 'PASS' : 'FAIL');
  }

  if (!result.pass) process.exit(1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
