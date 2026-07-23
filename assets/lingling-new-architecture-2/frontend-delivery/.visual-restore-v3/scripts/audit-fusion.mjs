// Merge detector outputs into findings.json and resolve visual-inventory dimensions.
// Usage: node scripts/audit-fusion.mjs <name> [--json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findingIsOpen, makeFinding, reconcileFindings, summarizeFindings } from './lib/findings.mjs';
import { resolveRestoreConfig } from './lib/restore-config.mjs';
import { summarizeInventoryCoverage } from './visual-inventory.mjs';

const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));

export function buildRegionFindings(regionScores, minRegionSimilarity) {
  return (regionScores || [])
    .filter((region) => region.required !== false)
    .filter((region) => region.similarity < (region.minSimilarity ?? minRegionSimilarity))
    .map((region) => makeFinding({
      detector: 'region-score',
      code: 'region-below-threshold',
      dimension: 'geometry',
      severity: region.similarity < (region.minSimilarity ?? minRegionSimilarity) - 5 ? 'P0' : 'P1',
      title: `${region.name} 分区相似度 ${region.similarity.toFixed(2)}%`,
      target: { region: region.name, rect: pickRect(region) },
      expected: { minSimilarity: region.minSimilarity ?? minRegionSimilarity },
      actual: { similarity: region.similarity, mismatch: region.mismatch },
      threshold: { minSimilarity: region.minSimilarity ?? minRegionSimilarity },
      confidence: 0.98,
      nextAction: `优先修复 ${region.name} 区域的最大 diff 连通块`,
    }));
}

export function buildDiffFindings(components, imagePixels, { top = 30, minShare = 0.0001 } = {}) {
  return (components || [])
    .filter((component) => component.count / Math.max(1, imagePixels) >= minShare)
    .slice(0, top)
    .map((component) => makeFinding({
      detector: 'diff-components',
      code: 'diff-component',
      dimension: 'geometry',
      severity: component.count / Math.max(1, imagePixels) >= 0.005 ? 'P1' : 'P2',
      title: `${component.region || 'Unknown'} 差异块 ${component.count}px`,
      target: { region: component.region || '', rect: pickRect(component) },
      actual: { pixels: component.count, share: component.count / Math.max(1, imagePixels) },
      confidence: 0.96,
      anchor: `${component.x},${component.y},${component.width},${component.height}`,
      evidence: { diff: 'diff.png', rect: pickRect(component) },
      nextAction: '打开该坐标局部对比，定位对应 DOM 元素后修复',
    }));
}

export function applyAuditResults(inventory, reports, { contentRequired = false, overrides = null } = {}) {
  const items = inventory.items || [];
  const full = reports.fullAudit;
  for (const measurement of full?.measurements || []) {
    const item = findInventoryItem(items, measurement.target);
    if (!item) continue;
    for (const [dimension, result] of Object.entries(measurement.dimensions || {})) {
      item.dimensions[dimension] = { ...result };
    }
  }

  for (const measurement of reports.fontAudit?.measurements || []) {
    const item = findInventoryItem(items, measurement.target);
    if (item) item.dimensions.typography = detectorDimension(measurement, 'font-audit');
  }
  for (const measurement of reports.fontAudit?.skipped || []) {
    const item = findInventoryItem(items, measurement.target);
    if (item && item.dimensions.typography?.status === 'pending') {
      item.dimensions.typography = { status: 'skipped', reason: measurement.reason, source: 'font-audit' };
    }
  }

  for (const measurement of reports.colorAudit?.textMeasurements || []) {
    const item = findInventoryItem(items, measurement.target);
    if (item) item.dimensions.textColor = detectorDimension(measurement, 'color-audit');
  }
  for (const measurement of reports.colorAudit?.backgroundMeasurements || []) {
    const item = findInventoryItem(items, measurement.target);
    if (item) item.dimensions.backgroundColor = detectorDimension(measurement, 'color-audit');
  }

  resolveContentDimensions(items, reports.contentAudit, { contentRequired });
  resolveAssetDimensions(items, reports.edgeAudit);

  for (const item of items) {
    for (const dimension of ['radius', 'shadow', 'opacity']) {
      if (item.dimensions[dimension]?.status === 'pending') {
        item.dimensions[dimension] = {
          status: 'skipped',
          reason: '暂无独立属性反解器;由局部像素、region 和 diff 审计覆盖',
          source: 'audit-fusion',
        };
      }
    }
    if (item.dimensions.geometry?.status === 'pending') {
      item.dimensions.geometry = {
        status: 'skipped',
        reason: '该元素无稳定墨迹 bbox;由 region/diff/structure 审计覆盖',
        source: 'audit-fusion',
      };
    }
  }

  applyDimensionOverrides(items, overrides?.dimensions || []);
  inventory.summary = summarizeInventoryCoverage(items);
  inventory.generatedAt = new Date().toISOString();
  inventory.fused = true;
  return inventory;
}

export function collectFindings(config, reports) {
  const findings = [];
  const hasFont = Boolean(reports.fontAudit);
  const hasColor = Boolean(reports.colorAudit);
  for (const finding of reports.fullAudit?.findings || []) {
    if (hasFont && finding.dimension === 'typography') continue;
    if (hasColor && ['textColor', 'backgroundColor'].includes(finding.dimension)) continue;
    findings.push(finding);
  }
  findings.push(...(reports.fontAudit?.findings || []));
  findings.push(...(reports.colorAudit?.findings || []));
  findings.push(...(reports.contentAudit?.findings || []));
  if (config.responsive?.enabled) findings.push(...(reports.responsiveAudit?.findings || []));
  findings.push(...(reports.structureAudit?.findings || []));
  findings.push(...buildRegionFindings(reports.regionScores, config.quality.minRegionSimilarity));
  const imagePixels = reports.foregroundScore?.pixels || 1;
  findings.push(...buildDiffFindings(reports.diffComponents, imagePixels));
  for (const raw of reports.edgeAudit?.summary?.findings || []) {
    findings.push(makeFinding({
      detector: 'asset-edge-audit',
      code: raw.kind || 'asset-edge',
      dimension: 'asset',
      severity: raw.severity === 'high' ? 'P0' : 'P1',
      title: `${raw.file}: ${raw.message}`,
      target: { file: raw.file },
      actual: raw.line || raw.halo || null,
      confidence: raw.kind === 'hairline' ? 0.72 : 0.68,
      nextAction: '复核资产边缘;确认污染则重新清理，合法边缘则记录 waiver',
    }));
  }
  for (const asset of reports.assetReport?.assets || []) {
    if (asset.pass) continue;
    findings.push(makeFinding({
      detector: 'asset-plan',
      code: 'asset-plan-gate',
      dimension: 'asset',
      severity: 'P1',
      title: `${asset.id} 资产计划未通过`,
      target: { file: asset.output || '', elementId: asset.id },
      actual: { issues: asset.issues },
      nextAction: '补齐 mask 分类或重建策略后重新运行 asset-plan',
    }));
  }
  return findings;
}

function resolveContentDimensions(items, contentAudit, { contentRequired }) {
  const entries = new Map((contentAudit?.entries || []).map((entry) => [entry.selector, entry]));
  for (const item of items) {
    if (item.dimensions.content?.status !== 'pending') continue;
    const entry = entries.get(item.domPath) || entries.get(item.selector);
    if (entry) {
      item.dimensions.content = {
        status: entry.pass ? 'pass' : 'fail',
        reason: entry.pass ? `content manifest ${entry.policy} matched` : entry.reason,
        source: 'content-audit',
      };
    } else if (!contentRequired || (contentAudit?.manifestPresent && !contentAudit?.requireAllVisible)) {
      item.dimensions.content = {
        status: 'skipped',
        reason: contentAudit?.manifestPresent
          ? '非关键可见内容;当前 manifest 未要求全量逐项登记'
          : 'content manifest not required for this legacy plan',
        source: 'content-audit',
      };
    }
  }
}

function resolveAssetDimensions(items, edgeAudit) {
  const reports = edgeAudit?.reports || [];
  for (const item of items) {
    if (item.dimensions.asset?.status !== 'pending') continue;
    const src = assetSource(item);
    const report = reports.find((candidate) => src && reportMatchesSource(candidate.file, src));
    if (report) {
      item.dimensions.asset = {
        status: report.pass ? 'pass' : 'fail',
        reason: report.pass ? 'PNG asset edge audit passed' : `${report.findings.length} asset edge finding(s)`,
        source: 'asset-edge-audit',
      };
    } else if (item.tag === 'svg' || src.toLowerCase().endsWith('.svg')) {
      item.dimensions.asset = {
        status: 'skipped',
        reason: 'vector asset由全图和局部 diff 覆盖;PNG 边缘审计不适用',
        source: 'audit-fusion',
      };
    } else if (!src || src.startsWith('data:')) {
      item.dimensions.asset = {
        status: 'skipped',
        reason: 'CSS/内联程序化视觉无独立文件资产;由全图、region 和 diff 审计覆盖',
        source: 'audit-fusion',
      };
    }
  }
}

function assetSource(item) {
  const direct = String(item.attrs?.src || '').trim();
  if (direct) return direct.split(/[?#]/)[0];
  const background = String(item.css?.backgroundImage || '');
  const match = background.match(/url\((['"]?)(.*?)\1\)/i);
  return String(match?.[2] || '').trim().split(/[?#]/)[0];
}

function reportMatchesSource(file, source) {
  const normalizedFile = String(file || '').replaceAll('\\', '/');
  const normalizedSource = decodeURIComponent(String(source || ''))
    .replace(/^\.\//, '')
    .replace(/^\//, '')
    .replaceAll('\\', '/');
  return Boolean(normalizedSource) && (
    normalizedFile.endsWith(normalizedSource) ||
    normalizedFile.endsWith(normalizedSource.split('/').pop())
  );
}

function applyDimensionOverrides(items, overrides) {
  for (const override of overrides) {
    const item = items.find((candidate) => candidate.id === override.elementId || candidate.auditId === override.elementId);
    if (!item || !item.dimensions?.[override.dimension]) continue;
    item.dimensions[override.dimension] = {
      status: override.status === 'pass' ? 'pass' : 'skipped',
      reason: `manual ${override.status || 'waiver'}: ${override.reason || 'no reason provided'}`,
      source: 'audit-overrides',
    };
  }
}

function applyFindingOverrides(findings, overrides) {
  const byId = new Map((overrides || []).map((override) => [override.findingId, override]));
  return findings.map((finding) => {
    const override = byId.get(finding.id);
    if (!override) return finding;
    return {
      ...finding,
      status: override.status || 'waived',
      reason: override.reason || 'manual waiver',
    };
  });
}

function detectorDimension(measurement, source) {
  return {
    status: measurement.status,
    value: measurement,
    reason: measurement.status === 'fail' ? `${source} threshold exceeded` : `${source} measured`,
    source,
  };
}

function findInventoryItem(items, target = {}) {
  if (target.elementId) {
    const byId = items.find((item) => item.id === target.elementId || item.auditId === target.elementId);
    if (byId) return byId;
  }

  if (target.selector) {
    const exact = items.find((item) => item.domPath === target.selector || item.auditId === target.selector);
    if (exact) return exact;
    const selectorMatches = items.filter((item) => item.selector === target.selector);
    if (selectorMatches.length === 1) return selectorMatches[0];
    if (selectorMatches.length > 1 && target.rect) return nearestItem(selectorMatches, target.rect);
  }

  if (target.displaySelector) {
    const displayMatches = items.filter((item) => item.selector === target.displaySelector);
    if (displayMatches.length === 1) return displayMatches[0];
    if (displayMatches.length > 1 && target.rect) return nearestItem(displayMatches, target.rect);
  }

  if (!target.rect) return null;
  return nearestItem(items, target.rect);
}

function nearestItem(items, rect) {
  let best = null;
  let bestDistance = Infinity;
  for (const item of items) {
    const distance = rectDistance(item.rect, rect);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return bestDistance <= 4 ? best : null;
}

function rectDistance(a = {}, b = {}) {
  return Math.abs((a.x || 0) - (b.x || 0)) +
    Math.abs((a.y || 0) - (b.y || 0)) +
    Math.abs((a.width || 0) - (b.width || 0)) +
    Math.abs((a.height || 0) - (b.height || 0));
}

function pickRect(value) {
  return {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

async function main(argv = process.argv.slice(2)) {
  const name = argv.find((item) => !item.startsWith('--'));
  const json = argv.includes('--json');
  if (!name) throw new Error('用法: node scripts/audit-fusion.mjs <name> [--json]');
  const config = resolveRestoreConfig(name, { root: ROOT });
  const outDir = join(ROOT, 'output', name);
  const inventory = readJson(join(outDir, 'visual-inventory.json'));
  if (!inventory) throw new Error(`缺少 output/${name}/visual-inventory.json`);
  const reports = {
    foregroundScore: readJson(join(outDir, 'foreground-score.json')),
    diffComponents: readJson(join(outDir, 'diff-components.json')) || [],
    regionScores: readJson(join(outDir, 'region-score.json')) || [],
    structureAudit: readJson(join(outDir, 'structure-audit.json')),
    colorAudit: readJson(join(outDir, 'color-audit.json')),
    fontAudit: readJson(join(outDir, 'font-audit.json')),
    fullAudit: readJson(join(outDir, 'full-audit.json')),
    contentAudit: readJson(join(outDir, 'content-audit.json')),
    responsiveAudit: config.responsive.enabled ? readJson(join(outDir, 'responsive-audit.json')) : null,
    edgeAudit: readJson(join(outDir, 'assets', 'edge-audit.json')),
    assetReport: readJson(join(outDir, 'assets', 'asset-report.json')),
  };
  const overrides = readJson(join(ROOT, 'pages', name, 'audit-overrides.json'));
  const current = applyFindingOverrides(collectFindings(config, reports), overrides?.findings);
  const previousFile = readJson(join(outDir, 'findings.json'));
  const findings = reconcileFindings(current, previousFile?.findings || []);
  const fusedInventory = applyAuditResults(inventory, reports, {
    contentRequired: config.policy.contentRequired,
    overrides,
  });
  for (const finding of findings.filter(findingIsOpen)) {
    const item = findInventoryItem(fusedInventory.items, finding.target);
    if (!item || !item.dimensions[finding.dimension]) continue;
    item.dimensions[finding.dimension] = {
      status: 'fail',
      reason: finding.title,
      source: finding.detector,
      findingId: finding.id,
    };
  }
  fusedInventory.summary = summarizeInventoryCoverage(fusedInventory.items);
  const result = {
    version: 1,
    name,
    generatedAt: new Date().toISOString(),
    summary: summarizeFindings(findings),
    findings,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'findings.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(outDir, 'visual-inventory.json'), `${JSON.stringify(fusedInventory, null, 2)}\n`);
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`审计融合: open ${result.summary.open}, resolved ${result.summary.resolved}, inventory unresolved ${fusedInventory.summary.unresolved.count}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(error.message); process.exit(1); });
