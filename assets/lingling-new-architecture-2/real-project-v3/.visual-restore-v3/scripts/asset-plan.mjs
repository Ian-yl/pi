// 视觉资源提取计划审计:
//   读取 pages/<name>/asset-plan.json,生成 mask/overlay/report,用于约束背景图、插图、
//   主体图等资源从设计稿中提取时的可恢复性和质量边界。
//
// 用法:
//   node scripts/asset-plan.mjs <name> [--plan=pages/<name>/asset-plan.json]
//
// 该工具不直接修图;它把"哪些像素原样保留、哪些是 UI 污染、哪些只能重建"显性化。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));

export const KIND_META = {
  preserve: {
    label: '原样保留',
    color: [34, 197, 94, 180],
    description: '设计图中可见且应原样保留的真实图片内容',
  },
  ui: {
    label: 'UI 污染',
    color: [239, 68, 68, 190],
    description: '文字、按钮、卡片、导航等前端代码应重建的界面元素',
  },
  glass: {
    label: '磨砂遮挡',
    color: [168, 85, 247, 185],
    description: '被 backdrop/glass 混合过的区域,只能恢复低频背景',
  },
  reconstruct: {
    label: '需重建',
    color: [245, 158, 11, 185],
    description: '被实心元素遮挡或缺失的图片内容,需要插值/inpaint/生成式重建',
  },
  vector: {
    label: '矢量重建',
    color: [59, 130, 246, 180],
    description: '图标、logo、徽章等不应切位图,应 SVG/图标库/矢量重建',
  },
  mock: {
    label: 'Mock/伪字',
    color: [20, 184, 166, 180],
    description: 'AI 伪字、打码、无法辨识内容;前端以语义正确内容清晰替代',
  },
  protected: {
    label: '主体保护',
    color: [236, 72, 153, 170],
    description: '产品、人物、插画主体等禁止修补误伤的区域',
  },
};

const KIND_ORDER = ['preserve', 'protected', 'glass', 'reconstruct', 'ui', 'vector', 'mock'];
const WRITE_PRECEDENCE = new Map(KIND_ORDER.map((kind, index) => [kind, index]));

function usage() {
  console.error('用法: node scripts/asset-plan.mjs <name> [--plan=pages/<name>/asset-plan.json]');
  process.exit(1);
}

function parseArgs(argv) {
  const args = { name: null, plan: null };
  for (const item of argv) {
    if (item.startsWith('--plan=')) args.plan = item.slice('--plan='.length);
    else if (!args.name) args.name = item;
    else usage();
  }
  if (!args.name) usage();
  return args;
}

export function normalizeRect(rect, width, height) {
  const nums = Array.isArray(rect)
    ? rect
    : [rect?.x, rect?.y, rect?.width ?? rect?.w, rect?.height ?? rect?.h];
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(Number(n)))) {
    throw new Error(`rect 必须是 [x,y,w,h]: ${JSON.stringify(rect)}`);
  }
  let [x, y, w, h] = nums.map((n) => Math.round(Number(n)));
  if (w < 0) { x += w; w = Math.abs(w); }
  if (h < 0) { y += h; h = Math.abs(h); }
  const x1 = clamp(x, 0, width);
  const y1 = clamp(y, 0, height);
  const x2 = clamp(x + w, x1, width);
  const y2 = clamp(y + h, y1, height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1, x2, y2 };
}

export function normalizePlan(rawPlan, { width, height, name }) {
  const plan = {
    version: rawPlan.version ?? 1,
    name: rawPlan.name || name,
    source: rawPlan.source || `output/${name}/design.png`,
    assets: [],
  };
  if (!Array.isArray(rawPlan.assets) || rawPlan.assets.length === 0) {
    throw new Error('asset-plan.json 必须包含非空 assets[]');
  }

  plan.assets = rawPlan.assets.map((asset, assetIndex) => {
    if (!asset.id) throw new Error(`assets[${assetIndex}] 缺少 id`);
    if (!Array.isArray(asset.zones) || asset.zones.length === 0) {
      throw new Error(`asset ${asset.id} 缺少 zones[]`);
    }
    return {
      id: asset.id,
      kind: asset.kind || 'unknown',
      output: asset.output || null,
      note: asset.note || '',
      qualityGate: asset.qualityGate || {},
      zones: asset.zones.map((zone, zoneIndex) => {
        const kind = zone.kind || 'reconstruct';
        if (!KIND_META[kind]) throw new Error(`asset ${asset.id} zone[${zoneIndex}] 未知 kind: ${kind}`);
        return {
          id: zone.id || `${asset.id}-${zoneIndex + 1}`,
          kind,
          rect: normalizeRect(zone.rect, width, height),
          note: zone.note || '',
          strategy: zone.strategy || '',
        };
      }),
    };
  });

  return plan;
}

export function summarizePlan(plan, width, height) {
  const totalPixels = width * height;
  return {
    name: plan.name,
    canvas: { width, height, totalPixels },
    assets: plan.assets.map((asset) => summarizeAsset(asset, width, height)),
  };
}

function summarizeAsset(asset, width, height) {
  const totalPixels = width * height;
  const classMap = classifyPixels(asset.zones, width, height);
  const counts = Object.fromEntries(Object.keys(KIND_META).map((kind) => [kind, 0]));
  let classified = 0;
  let overlapPixels = 0;

  for (let i = 0; i < classMap.kind.length; i++) {
    const kindIndex = classMap.kind[i];
    if (kindIndex >= 0) {
      classified++;
      counts[KIND_ORDER[kindIndex]]++;
    }
    if (classMap.hits[i] > 1) overlapPixels++;
  }

  const unknownPixels = totalPixels - classified;
  const reconstructPixels = counts.glass + counts.reconstruct;
  const nonRecoverablePixels = counts.ui + counts.vector + counts.mock + reconstructPixels;
  const maxUnknownPct = Number(asset.qualityGate.maxUnknownPct ?? 65);
  const maxReconstructPct = Number(asset.qualityGate.maxReconstructPct ?? 45);
  const issues = [];

  if (pct(unknownPixels, totalPixels) > maxUnknownPct) {
    issues.push(`unknown ${(pct(unknownPixels, totalPixels)).toFixed(2)}% > ${maxUnknownPct}%`);
  }
  if (pct(reconstructPixels, totalPixels) > maxReconstructPct) {
    issues.push(`reconstruct ${(pct(reconstructPixels, totalPixels)).toFixed(2)}% > ${maxReconstructPct}%`);
  }
  for (const zone of asset.zones) {
    if ((zone.kind === 'glass' || zone.kind === 'reconstruct') && !zone.strategy) {
      issues.push(`${zone.id}(${zone.kind}) 缺少 strategy`);
    }
  }

  return {
    id: asset.id,
    kind: asset.kind,
    output: asset.output,
    note: asset.note,
    counts,
    classifiedPixels: classified,
    unknownPixels,
    overlapPixels,
    reconstructPixels,
    nonRecoverablePixels,
    percentages: {
      classified: round2(pct(classified, totalPixels)),
      unknown: round2(pct(unknownPixels, totalPixels)),
      preserve: round2(pct(counts.preserve, totalPixels)),
      protected: round2(pct(counts.protected, totalPixels)),
      reconstruct: round2(pct(reconstructPixels, totalPixels)),
      ui: round2(pct(counts.ui, totalPixels)),
      vector: round2(pct(counts.vector, totalPixels)),
      mock: round2(pct(counts.mock, totalPixels)),
      overlap: round2(pct(overlapPixels, totalPixels)),
    },
    zones: asset.zones,
    pass: issues.length === 0,
    issues,
  };
}

function classifyPixels(zones, width, height) {
  const kind = new Int8Array(width * height);
  const hits = new Uint8Array(width * height);
  kind.fill(-1);

  for (const zone of zones) {
    const kindIndex = WRITE_PRECEDENCE.get(zone.kind);
    for (let y = zone.rect.y; y < zone.rect.y + zone.rect.height; y++) {
      for (let x = zone.rect.x; x < zone.rect.x + zone.rect.width; x++) {
        const i = y * width + x;
        hits[i]++;
        if (kind[i] < kindIndex) kind[i] = kindIndex;
      }
    }
  }

  return { kind, hits };
}

function renderMask(asset, width, height) {
  const out = new PNG({ width, height });
  out.data.fill(0);
  for (const zone of asset.zones) {
    const color = KIND_META[zone.kind].color;
    for (let y = zone.rect.y; y < zone.rect.y + zone.rect.height; y++) {
      for (let x = zone.rect.x; x < zone.rect.x + zone.rect.width; x++) {
        const o = (width * y + x) << 2;
        out.data[o] = color[0];
        out.data[o + 1] = color[1];
        out.data[o + 2] = color[2];
        out.data[o + 3] = Math.max(out.data[o + 3], color[3]);
      }
    }
  }
  return out;
}

function renderOverlay(source, asset) {
  const out = new PNG({ width: source.width, height: source.height });
  PNG.bitblt(source, out, 0, 0, source.width, source.height, 0, 0);
  for (const zone of asset.zones) {
    const color = KIND_META[zone.kind].color;
    const alpha = color[3] / 255;
    for (let y = zone.rect.y; y < zone.rect.y + zone.rect.height; y++) {
      for (let x = zone.rect.x; x < zone.rect.x + zone.rect.width; x++) {
        const o = (source.width * y + x) << 2;
        out.data[o] = Math.round(out.data[o] * (1 - alpha) + color[0] * alpha);
        out.data[o + 1] = Math.round(out.data[o + 1] * (1 - alpha) + color[1] * alpha);
        out.data[o + 2] = Math.round(out.data[o + 2] * (1 - alpha) + color[2] * alpha);
        out.data[o + 3] = 255;
      }
    }
  }
  return out;
}

function reportHtml(plan, summary) {
  const rows = summary.assets.map((asset) => `
    <tr class="${asset.pass ? '' : 'fail'}">
      <td>${escapeHtml(asset.id)}</td>
      <td>${escapeHtml(asset.kind)}</td>
      <td>${asset.percentages.preserve}%</td>
      <td>${asset.percentages.reconstruct}%</td>
      <td>${asset.percentages.ui}%</td>
      <td>${asset.percentages.unknown}%</td>
      <td>${asset.percentages.overlap}%</td>
      <td>${asset.pass ? 'pass' : escapeHtml(asset.issues.join('; '))}</td>
    </tr>`).join('');

  const zoneRows = summary.assets.flatMap((asset) => asset.zones.map((zone) => `
    <tr>
      <td>${escapeHtml(asset.id)}</td>
      <td><span class="chip" style="background:${rgbaCss(KIND_META[zone.kind].color)}"></span>${escapeHtml(KIND_META[zone.kind].label)}</td>
      <td>${escapeHtml(zone.id)}</td>
      <td>${zone.rect.x},${zone.rect.y},${zone.rect.width},${zone.rect.height}</td>
      <td>${escapeHtml(zone.strategy || '')}</td>
      <td>${escapeHtml(zone.note || '')}</td>
    </tr>`)).join('');

  const masks = summary.assets.map((asset) => `
    <figure>
      <figcaption>${escapeHtml(asset.id)} overlay</figcaption>
      <img src="${escapeHtml(asset.id)}-overlay.png">
    </figure>
    <figure>
      <figcaption>${escapeHtml(asset.id)} mask</figcaption>
      <img src="${escapeHtml(asset.id)}-mask.png">
    </figure>`).join('');

  const legend = Object.entries(KIND_META).map(([kind, meta]) => `
    <div><span class="chip" style="background:${rgbaCss(meta.color)}"></span><b>${escapeHtml(meta.label)}</b> <code>${kind}</code> ${escapeHtml(meta.description)}</div>`).join('');

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${escapeHtml(plan.name)} · asset plan</title>
<style>
  *{box-sizing:border-box} body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:24px;background:#f5f6f8;color:#121826}
  h1{font-size:22px;margin:0 0 12px} h2{font-size:16px;margin:24px 0 10px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
  th,td{text-align:left;border-bottom:1px solid #eef0f3;padding:9px 10px;vertical-align:top} th{background:#f9fafb;color:#4b5563;font-weight:600}
  tr.fail{background:#fff7ed} code{font-size:12px;color:#4b5563}
  .legend{display:grid;gap:6px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px}
  .chip{display:inline-block;width:16px;height:10px;border-radius:3px;margin-right:8px;vertical-align:middle;border:1px solid rgba(0,0,0,.12)}
  .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  figure{margin:0;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:10px}
  figcaption{font-weight:600;color:#374151;margin-bottom:8px} img{width:100%;display:block}
</style>
</head>
<body>
<h1>${escapeHtml(plan.name)} · 视觉资源提取计划</h1>
<div class="legend">${legend}</div>
<h2>资产汇总</h2>
<table>
  <thead><tr><th>asset</th><th>kind</th><th>preserve</th><th>reconstruct</th><th>ui</th><th>unknown</th><th>overlap</th><th>gate</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<h2>分区清单</h2>
<table>
  <thead><tr><th>asset</th><th>kind</th><th>zone</th><th>rect</th><th>strategy</th><th>note</th></tr></thead>
  <tbody>${zoneRows}</tbody>
</table>
<h2>Mask / Overlay</h2>
<div class="grid">${masks}</div>
</body>
</html>`;
}

function readPlanFile(planPath) {
  return JSON.parse(readFileSync(planPath, 'utf8'));
}

function resolvePlanPath(name, argPlan) {
  if (argPlan) return resolve(ROOT, argPlan);
  const candidates = [
    join(ROOT, 'pages', name, 'asset-plan.json'),
    join(ROOT, 'asset-plans', `${name}.json`),
  ];
  const hit = candidates.find((path) => existsSync(path));
  if (!hit) throw new Error(`找不到资产计划: pages/${name}/asset-plan.json`);
  return hit;
}

function resolveSource(name, plan) {
  const candidates = [
    resolve(ROOT, plan.source || ''),
    join(ROOT, 'output', name, 'design.png'),
    join(ROOT, 'designs', `${name}.png`),
  ];
  const hit = candidates.find((path) => existsSync(path));
  if (!hit) throw new Error(`找不到 PNG 源图;先运行 npm run verify ${name},或在 asset-plan.json 指定 source`);
  return hit;
}

function runCli() {
  const { name, plan: rawPlanPath } = parseArgs(process.argv.slice(2));
  const planPath = resolvePlanPath(name, rawPlanPath);
  const rawPlan = readPlanFile(planPath);
  const sourcePath = resolveSource(name, rawPlan);
  const source = PNG.sync.read(readFileSync(sourcePath));
  const plan = normalizePlan(rawPlan, { width: source.width, height: source.height, name });
  const summary = summarizePlan(plan, source.width, source.height);
  const outDir = join(ROOT, 'output', name, 'assets');
  mkdirSync(outDir, { recursive: true });

  for (const asset of plan.assets) {
    writeFileSync(join(outDir, `${asset.id}-mask.png`), PNG.sync.write(renderMask(asset, source.width, source.height)));
    writeFileSync(join(outDir, `${asset.id}-overlay.png`), PNG.sync.write(renderOverlay(source, asset)));
  }
  writeFileSync(join(outDir, 'asset-plan.normalized.json'), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(join(outDir, 'asset-report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(outDir, 'asset-report.html'), reportHtml(plan, summary));

  const failed = summary.assets.filter((asset) => !asset.pass);
  for (const asset of summary.assets) {
    const status = asset.pass ? '✓' : '!';
    console.log(`${status} ${asset.id} preserve ${asset.percentages.preserve}% · reconstruct ${asset.percentages.reconstruct}% · ui ${asset.percentages.ui}% · unknown ${asset.percentages.unknown}%`);
    for (const issue of asset.issues) console.log(`  - ${issue}`);
  }
  console.log(`报告: output/${name}/assets/asset-report.html`);
  if (failed.length) process.exitCode = 1;
}

function pct(value, total) {
  return total ? (value / total) * 100 : 0;
}

function round2(value) {
  return Number(value.toFixed(2));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function rgbaCss([r, g, b, a]) {
  return `rgba(${r},${g},${b},${(a / 255).toFixed(2)})`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
