// Audit extracted PNG assets for residual UI hairlines and transparent-edge halos.
// Usage:
//   node scripts/asset-edge-audit.mjs <name> [--asset=pages/<name>/assets/foo.png]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));

export function detectBrightHairlines(img, {
  minRun = 24,
  minContrast = 36,
  bright = 235,
  dark = 28,
  maxThickness = 3,
} = {}) {
  const vertical = scanAxis(img, 'vertical', { minRun, minContrast, bright, dark, maxThickness });
  const horizontal = scanAxis(img, 'horizontal', { minRun, minContrast, bright, dark, maxThickness });
  return [...vertical, ...horizontal].sort((a, b) => b.score - a.score);
}

export function detectAlphaHalo(img, {
  minAlpha = 8,
  maxAlpha = 220,
  transparentAlpha = 8,
  whiteThreshold = 230,
  blackThreshold = 25,
  opaqueAlpha = 230,
  mismatchThreshold = 70,
} = {}) {
  const result = {
    total: 0,
    white: 0,
    black: 0,
    colored: 0,
    suspicious: 0,
    suspiciousWhite: 0,
    suspiciousBlack: 0,
    samples: [],
  };

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (img.width * y + x) << 2;
      const alpha = img.data[o + 3];
      if (alpha < minAlpha || alpha > maxAlpha) continue;
      if (!touchesTransparent(img, x, y, transparentAlpha)) continue;
      const rgb = [img.data[o], img.data[o + 1], img.data[o + 2]];
      const lum = luminanceRgb(rgb);
      const nearestOpaque = nearestOpaqueColor(img, x, y, opaqueAlpha);
      const suspicious = nearestOpaque && colorDistance(rgb, nearestOpaque) >= mismatchThreshold;
      result.total++;
      const isWhite = rgb.every((v) => v >= whiteThreshold);
      const isBlack = lum <= blackThreshold;
      if (isWhite) result.white++;
      else if (isBlack) result.black++;
      else result.colored++;
      if (suspicious && (isWhite || isBlack)) {
        result.suspicious++;
        if (isWhite) result.suspiciousWhite++;
        if (isBlack) result.suspiciousBlack++;
        if (result.samples.length < 20) {
          result.samples.push({ x, y, rgba: [...rgb, alpha], nearestOpaque });
        }
      }
    }
  }

  return result;
}

export function auditAssetImage(img, { file = '', zones = [] } = {}) {
  const hairlines = detectBrightHairlines(img);
  const halo = detectAlphaHalo(img);
  const alphaPixels = countAlphaPixels(img);
  const findings = [];

  for (const line of hairlines.slice(0, 20)) {
    const zone = classifyLineZone(line, zones);
    line.zone = zone;
    if (line.score >= 0.55 && !['preserve', 'protected'].includes(zone?.kind)) {
      findings.push({
        kind: 'hairline',
        severity: line.score >= 0.8 ? 'high' : 'medium',
        message: `${line.tone} ${line.orientation} hairline at ${line.orientation === 'vertical' ? `x=${line.x}` : `y=${line.y}`}`,
        line,
        zone,
      });
    }
  }

  const suspiciousThreshold = Math.max(3, Math.ceil(halo.total * 0.08));
  if (alphaPixels > 0 && halo.suspicious >= suspiciousThreshold) {
    const severity = halo.suspicious / halo.total > 0.45 ? 'high' : 'medium';
    findings.push({
      kind: 'alpha-halo',
      severity,
      message: `suspicious transparent edge pixels: ${halo.suspicious}/${halo.total}, white ${halo.suspiciousWhite}, black ${halo.suspiciousBlack}`,
      halo,
    });
  }

  return {
    file,
    width: img.width,
    height: img.height,
    alphaPixels,
    hairlines: hairlines.slice(0, 30),
    halo,
    findings,
    pass: findings.length === 0,
  };
}

export function summarizeAssetFindings(reports) {
  const findings = reports.flatMap((report) => report.findings.map((finding) => ({
    file: report.file,
    ...finding,
  })));
  return {
    totalAssets: reports.length,
    passAssets: reports.filter((report) => report.pass).length,
    failAssets: reports.filter((report) => !report.pass).length,
    findings,
  };
}

function scanAxis(img, orientation, options) {
  const primaryLen = orientation === 'vertical' ? img.width : img.height;
  const secondaryLen = orientation === 'vertical' ? img.height : img.width;
  const candidates = [];
  let group = null;

  for (let primary = 0; primary < primaryLen; primary++) {
    const run = longestLineRun(img, orientation, primary, options);
    if (!run || run.length < options.minRun) {
      if (group) {
        candidates.push(finishGroup(group, orientation));
        group = null;
      }
      continue;
    }

    const point = {
      primary,
      ...run,
      score: Math.min(1, run.length / Math.max(options.minRun * 2, 1)) * Math.min(1, run.contrast / 90),
    };

    if (group && primary <= group.end + 1 && group.tone === point.tone && primary - group.start < options.maxThickness) {
      group.end = primary;
      group.points.push(point);
    } else {
      if (group) candidates.push(finishGroup(group, orientation));
      group = { start: primary, end: primary, tone: point.tone, points: [point] };
    }
  }

  if (group) candidates.push(finishGroup(group, orientation));
  return candidates;
}

function longestLineRun(img, orientation, primary, { minContrast, bright, dark }) {
  const secondaryLen = orientation === 'vertical' ? img.height : img.width;
  let best = null;
  let active = null;

  for (let secondary = 0; secondary < secondaryLen; secondary++) {
    const x = orientation === 'vertical' ? primary : secondary;
    const y = orientation === 'vertical' ? secondary : primary;
    const lum = opaqueLuminanceAt(img, x, y);
    const leftLum = orientation === 'vertical' && primary > 0 ? opaqueLuminanceAt(img, primary - 1, secondary) : null;
    const rightLum = orientation === 'vertical' && primary < img.width - 1 ? opaqueLuminanceAt(img, primary + 1, secondary) : null;
    const upLum = orientation === 'horizontal' && primary > 0 ? opaqueLuminanceAt(img, secondary, primary - 1) : null;
    const downLum = orientation === 'horizontal' && primary < img.height - 1 ? opaqueLuminanceAt(img, secondary, primary + 1) : null;
    const neighbors = [leftLum, rightLum, upLum, downLum].filter((v) => v !== null);
    const neighborLum = neighbors.length && lum !== null ? median(neighbors) : lum;
    const contrast = lum === null || neighborLum === null ? 0 : Math.abs(lum - neighborLum);
    const tone = lum === null ? null : lum >= bright ? 'bright' : lum <= dark ? 'dark' : null;
    const lineLike = tone && contrast >= minContrast;

    if (lineLike) {
      if (!active) active = { start: secondary, end: secondary, length: 1, tone, contrast };
      else {
        active.end = secondary;
        active.length++;
        active.contrast = Math.max(active.contrast, contrast);
      }
    } else if (active) {
      best = betterRun(best, active);
      active = null;
    }
  }

  return betterRun(best, active);
}

function finishGroup(group, orientation) {
  const best = group.points.sort((a, b) => b.score - a.score)[0];
  const base = {
    orientation,
    tone: group.tone,
    thickness: group.end - group.start + 1,
    start: group.start,
    end: group.end,
    runStart: best.start,
    runEnd: best.end,
    length: best.length,
    contrast: Math.round(best.contrast),
    score: Number(best.score.toFixed(3)),
  };
  if (orientation === 'vertical') {
    base.x = Math.round((group.start + group.end) / 2);
    base.y = best.start;
  } else {
    base.y = Math.round((group.start + group.end) / 2);
    base.x = best.start;
  }
  return base;
}

function touchesTransparent(img, x, y, transparentAlpha) {
  for (let yy = y - 1; yy <= y + 1; yy++) {
    for (let xx = x - 1; xx <= x + 1; xx++) {
      if (xx === x && yy === y) continue;
      if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue;
      const o = (img.width * yy + xx) << 2;
      if (img.data[o + 3] <= transparentAlpha) return true;
    }
  }
  return false;
}

function countAlphaPixels(img) {
  let count = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.data[(i << 2) + 3] < 255) count++;
  }
  return count;
}

function betterRun(a, b) {
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

function opaqueLuminanceAt(img, x, y) {
  const o = (img.width * y + x) << 2;
  if (img.data[o + 3] < 230) return null;
  return luminanceRgb([img.data[o], img.data[o + 1], img.data[o + 2]]);
}

function nearestOpaqueColor(img, x, y, opaqueAlpha) {
  let best = null;
  let bestDistance = Infinity;
  for (let radius = 1; radius <= 3; radius++) {
    for (let yy = y - radius; yy <= y + radius; yy++) {
      for (let xx = x - radius; xx <= x + radius; xx++) {
        if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue;
        const offset = (img.width * yy + xx) << 2;
        if (img.data[offset + 3] < opaqueAlpha) continue;
        const distance = Math.hypot(xx - x, yy - y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = [img.data[offset], img.data[offset + 1], img.data[offset + 2]];
        }
      }
    }
    if (best) return best;
  }
  return null;
}

function colorDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function classifyLineZone(line, zones) {
  if (!zones.length) return null;
  const x = line.orientation === 'vertical' ? line.x : line.x + line.length / 2;
  const y = line.orientation === 'vertical' ? line.y + line.length / 2 : line.y;
  const precedence = ['preserve', 'protected', 'glass', 'reconstruct', 'ui', 'vector', 'mock'];
  return zones
    .filter((zone) => pointInRect(x, y, zone.rect))
    .sort((a, b) => precedence.indexOf(b.kind) - precedence.indexOf(a.kind))[0] || null;
}

function pointInRect(x, y, rect) {
  const [rx, ry, rw, rh] = Array.isArray(rect)
    ? rect
    : [rect?.x, rect?.y, rect?.width ?? rect?.w, rect?.height ?? rect?.h];
  return [rx, ry, rw, rh].every(Number.isFinite) && x >= rx && y >= ry && x < rx + rw && y < ry + rh;
}

function luminanceRgb([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function median(values) {
  return [...values].sort((a, b) => a - b)[values.length >> 1];
}

function parseArgs(argv) {
  const args = { name: null, assets: [], includeOutput: false };
  for (const item of argv) {
    if (item.startsWith('--asset=')) args.assets.push(resolve(ROOT, item.slice('--asset='.length)));
    else if (item === '--include-output') args.includeOutput = true;
    else if (!args.name) args.name = item;
    else throw new Error(`未知参数: ${item}`);
  }
  if (!args.name) throw new Error('用法: node scripts/asset-edge-audit.mjs <name> [--asset=...] [--include-output]');
  return args;
}

function listPngAssets(name, explicitAssets, { includeOutput = false } = {}) {
  if (explicitAssets.length) return explicitAssets;
  const roots = [join(ROOT, 'pages', name, 'assets')];
  if (includeOutput) roots.push(join(ROOT, 'output', name, 'assets'));
  const files = [];
  for (const root of roots.filter((dir) => existsSync(dir))) walk(root, files);
  return [...new Set(files)].sort();
}

function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (extname(entry.name).toLowerCase() === '.png') files.push(full);
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const files = listPngAssets(args.name, args.assets, { includeOutput: args.includeOutput });
  const assetPlan = readAssetPlan(args.name);
  const reports = [];

  for (const file of files) {
    const img = PNG.sync.read(readFileSync(file));
    const relativeFile = relativeToRoot(file);
    const plannedAsset = assetPlan?.assets?.find((asset) => normalizePath(asset.output) === normalizePath(relativeFile));
    reports.push(auditAssetImage(img, { file: relativeFile, zones: plannedAsset?.zones || [] }));
  }

  const result = {
    version: 3,
    name: args.name,
    generatedAt: new Date().toISOString(),
    summary: summarizeAssetFindings(reports),
    reports,
  };
  const outDir = join(ROOT, 'output', args.name, 'assets');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'edge-audit.json'), `${JSON.stringify(result, null, 2)}\n`);

  console.log(`资源边缘审计: ${reports.length} 个 PNG, 失败 ${result.summary.failAssets} 个, 已写 output/${args.name}/assets/edge-audit.json`);
  for (const finding of result.summary.findings.slice(0, 20)) {
    console.log(`! ${finding.file}: ${finding.message}`);
  }
  if (result.summary.findings.length > 20) console.log(`  ...余 ${result.summary.findings.length - 20} 项`);
}

function readAssetPlan(name) {
  const path = join(ROOT, 'pages', name, 'asset-plan.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function normalizePath(value) {
  return String(value || '').replace(/^\.\//, '').replaceAll('\\', '/');
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
