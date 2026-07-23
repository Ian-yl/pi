// 全量审计器:全部可见元素 × 全部可测维度(位置 dy / 字号 / 文字色 / 背景色 / 边框色),
// 一次跑完。原则:任何元素、任何维度,要么给出测量结果,要么明确记录跳过原因 —— 禁止静默遗漏。
// 用法: node scripts/full-audit.mjs <name> [--dpr=2]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import { openAuditPage } from './lib/browser-target.mjs';
import { makeFinding, summarizeFindings } from './lib/findings.mjs';
import { resolveRestoreConfig } from './lib/restore-config.mjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const name = process.argv[2];
if (!name) throw new Error('用法: node scripts/full-audit.mjs <name> [--dpr=2]');
const cliDpr = Number((process.argv.find((a) => a.startsWith('--dpr=')) || '').split('=')[1] || NaN);
const config = resolveRestoreConfig(name, { dpr: cliDpr, root: ROOT });
const dpr = config.viewport.dpr;
const POS_LIMIT = config.quality.maxStructureDy;
const FONT_LIMIT = config.quality.maxFontDiff;
const TEXT_COLOR_LIMIT = 55;
const BACKGROUND_LIMIT = 22;
const BORDER_LIMIT = 26;

const D = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'design.png')));
const A = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'actual.png')));
const px = (img, x, y) => {
  x = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  y = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const i = (img.width * y + x) << 2;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const med = (a) => a.sort((m, n) => m - n)[a.length >> 1];
const medColor = (ps) => [med(ps.map((p) => p[0])), med(ps.map((p) => p[1])), med(ps.map((p) => p[2]))];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const parseCss = (s) => {
  const m = s?.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  return m ? { c: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
};

// 墨段(与 font-audit v2 同):返回中心墨段 {y1,y2} 或 null
function inkSeg(img, X, Y, W, H) {
  const edge = [];
  for (let x = X; x < X + W; x += 3) edge.push(px(img, x, Y), px(img, x, Y + H - 1));
  const bg = medColor(edge);
  const rows = [];
  for (let y = Y; y < Y + H; y++) {
    let hit = 0;
    for (let x = X; x < X + W; x++) if (dist(px(img, x, y), bg) > 64) hit++;
    rows.push(hit >= 2);
  }
  const segs = [];
  let s = -1, gap = 0;
  for (let i = 0; i <= rows.length; i++) {
    if (i < rows.length && rows[i]) { if (s < 0) s = i; gap = 0; }
    else if (s >= 0 && (++gap > 1 || i === rows.length)) { segs.push([s, i - gap]); s = -1; gap = 0; }
  }
  if (!segs.length) return null;
  const mid = H / 2;
  segs.sort((a, b) => Math.abs((a[0] + a[1]) / 2 - mid) - Math.abs((b[0] + b[1]) / 2 - mid));
  return { y1: Y + segs[0][0], y2: Y + segs[0][1] };
}
// 文字核心色:离背景最远 25% 像素均值
function textColor(img, X, Y, W, H) {
  const all = [];
  for (let y = Y; y < Y + H; y++) for (let x = X; x < X + W; x++) all.push(px(img, x, y));
  if (all.length < 30) return null;
  const bg = medColor([...all]);
  const far = all.map((p) => ({ p, d: dist(p, bg) })).sort((a, b) => b.d - a.d);
  if (far[Math.floor(far.length * 0.1)].d < 50) return null;
  const core = far.slice(0, Math.max(6, Math.floor(all.length * 0.1))).map((o) => o.p);
  return core.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / core.length);
}

const session = await openAuditPage(config, { imageWidth: D.width, imageHeight: D.height });
const page = session.page;
const els = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter((c) => c !== 'abs')[0] || '' : '';
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    out.push({
      sel: el.tagName.toLowerCase() + (cls ? '.' + cls : ''),
      domPath: stableSelector(el),
      text: text.slice(0, 12),
      x: r.x, y: r.y, w: r.width, h: r.height,
      fs: parseFloat(cs.fontSize),
      lh: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2,
      color: cs.color,
      bg: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : null,
      bw: parseFloat(cs.borderTopWidth) || 0,
      bc: cs.borderTopColor,
      tag: el.tagName,
      hasText: !!text,
      isLeafText: !!text && el.children.length === 0,
      multiline: !!text && r.height > (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4) * 1.6,
    });
  }
  return out;

  function stableSelector(el) {
    if (el.getAttribute('data-vr-id')) return `[data-vr-id="${el.getAttribute('data-vr-id')}"]`;
    if (el.id) return `#${el.id}`;
    const parts = [];
    let node = el;
    while (node && node !== document.body) {
      const parent = node.parentElement;
      if (!parent) break;
      const tag = node.tagName.toLowerCase();
      const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
      parts.unshift(`${tag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''}`);
      node = parent;
    }
    return `body>${parts.join('>')}`;
  }
});
await session.close();

const issues = { pos: [], font: [], tcolor: [], bgcolor: [], border: [] };
const skips = {};
const skip = (why) => (skips[why] = (skips[why] || 0) + 1);
let measured = 0;
const measurements = [];

for (const el of els) {
  const record = { target: targetFor(el), dimensions: {} };
  const pad = 2 * dpr;
  const X = Math.max(0, Math.round(el.x * dpr) - pad);
  const Y = Math.max(0, Math.round(el.y * dpr) - pad);
  const W = Math.min(D.width - X, Math.round(el.w * dpr) + pad * 2);
  const H = Math.min(D.height - Y, Math.round(el.h * dpr) + pad * 2);
  if (W <= 4 || H <= 4) {
    skip('区域越界');
    for (const dimension of ['geometry', 'typography', 'textColor', 'backgroundColor', 'border']) {
      record.dimensions[dimension] = skippedDimension('区域越界');
    }
    measurements.push(record);
    continue;
  }
  let did = false;

  // 维度1+2:位置与字号(叶子文字元素,单行)
  if (el.isLeafText && !el.multiline) {
    const dSeg = inkSeg(D, X, Y, W, H);
    const aSeg = inkSeg(A, X, Y, W, H);
    if (dSeg && aSeg) {
      did = true;
      const dy = (dSeg.y1 - aSeg.y1) / dpr;
      const dInk = dSeg.y2 - dSeg.y1 + 1, aInk = aSeg.y2 - aSeg.y1 + 1;
      const dfs = (el.fs * dInk) / aInk;
      record.dimensions.geometry = measuredDimension(Math.abs(dy) >= POS_LIMIT, { dy: Number(dy.toFixed(2)) }, { maxAbsDy: POS_LIMIT });
      record.dimensions.typography = measuredDimension(Math.abs(dfs - el.fs) >= FONT_LIMIT, { fontSize: el.fs, designFontSize: Number(dfs.toFixed(2)) }, { maxFontDiff: FONT_LIMIT });
      if (Math.abs(dy) >= POS_LIMIT) issues.pos.push({ el, dy, v: `dy ${dy > 0 ? '+' : ''}${dy.toFixed(1)}` });
      if (Math.abs(dfs - el.fs) >= FONT_LIMIT) issues.font.push({ el, designFontSize: dfs, v: `fs ${el.fs} → ${dfs.toFixed(1)}` });
      // 维度3:文字色
      const dc = textColor(D, X, Y, W, H), ac = textColor(A, X, Y, W, H);
      if (dc && ac) {
        const delta = dist(dc, ac);
        record.dimensions.textColor = measuredDimension(delta > TEXT_COLOR_LIMIT, { designColor: hex(dc), actualColor: hex(ac), delta: Number(delta.toFixed(2)) }, { maxDelta: TEXT_COLOR_LIMIT });
        if (delta > TEXT_COLOR_LIMIT) issues.tcolor.push({ el, designColor: dc, actualColor: ac, delta, v: `${hex(ac)} → ${hex(dc)}` });
      } else record.dimensions.textColor = skippedDimension('文字核心色不可稳定测量');
    } else {
      skip('墨不可测(对比度低/空区)');
      record.dimensions.geometry = skippedDimension('文字墨迹不可稳定测量');
      record.dimensions.typography = skippedDimension('文字墨迹不可稳定测量');
      record.dimensions.textColor = skippedDimension('文字墨迹不可稳定测量');
    }
  } else if (el.isLeafText && el.multiline) {
    skip('多行文字(需人工比对)');
    record.dimensions.geometry = skippedDimension('多行文字需人工复核');
    record.dimensions.typography = skippedDimension('多行文字需人工复核');
    record.dimensions.textColor = skippedDimension('多行文字需人工复核');
  } else {
    record.dimensions.geometry = skippedDimension('非叶子文字元素由结构/局部 diff 审计');
    record.dimensions.typography = skippedDimension('无可独立测量的单行文字');
    record.dimensions.textColor = skippedDimension('无可独立测量的单行文字');
  }

  // 维度4:背景色(有底色的块,取内缩中心中位)
  if (el.bg && el.w >= 16 && el.h >= 12) {
    const inset = Math.max(3, Math.min(el.w, el.h) / 5) * dpr;
    const dps = [], aps = [];
    for (let y = Y + inset; y < Y + H - inset; y += 2) for (let x = X + inset; x < X + W - inset; x += 2) {
      dps.push(px(D, x, y)); aps.push(px(A, x, y));
    }
    if (dps.length > 20) {
      did = true;
      const dbg = medColor(dps), abg = medColor(aps);
      const delta = dist(dbg, abg);
      record.dimensions.backgroundColor = measuredDimension(delta > BACKGROUND_LIMIT, { designColor: hex(dbg), actualColor: hex(abg), delta: Number(delta.toFixed(2)) }, { maxDelta: BACKGROUND_LIMIT });
      if (delta > BACKGROUND_LIMIT) issues.bgcolor.push({ el, designColor: dbg, actualColor: abg, delta, v: `${hex(abg)} → ${hex(dbg)}` });
    } else {
      skip('背景区过小');
      record.dimensions.backgroundColor = skippedDimension('背景区过小');
    }
  } else record.dimensions.backgroundColor = skippedDimension('无可见背景填充');

  // 维度5:边框色(border ≥1px 的元素,采样四边中段边框线)
  if (el.bw >= 1 && el.w > 30 && el.h > 14) {
    const bwp = Math.max(1, Math.round(el.bw * dpr));
    const samp = (img) => {
      const ps = [];
      const midY = Math.round(el.y * dpr) + Math.floor(bwp / 2);
      const botY = Math.round((el.y + el.h) * dpr) - 1 - Math.floor(bwp / 2);
      for (let x = X + Math.round(W * 0.3); x < X + Math.round(W * 0.7); x += 2) {
        ps.push(px(img, x, midY), px(img, x, botY));
      }
      return medColor(ps);
    };
    const dbc = samp(D), abc = samp(A);
    did = true;
    const delta = dist(dbc, abc);
    record.dimensions.border = measuredDimension(delta > BORDER_LIMIT, { designColor: hex(dbc), actualColor: hex(abc), delta: Number(delta.toFixed(2)) }, { maxDelta: BORDER_LIMIT });
    if (delta > BORDER_LIMIT) issues.border.push({ el, designColor: dbc, actualColor: abc, delta, v: `${hex(abc)} → ${hex(dbc)}` });
  } else record.dimensions.border = skippedDimension('无可见边框或边框区域过小');

  if (did) measured++;
  else if (!el.hasText && !el.bg && el.bw < 1) skip('无可测属性(纯布局容器/图标)');
  measurements.push(record);
}

const findings = [
  ...issues.pos.map((issue) => findingFor(issue, 'geometry', 'vertical-position-delta', `垂直位置偏差 ${issue.dy.toFixed(1)}px`, { dy: Number(issue.dy.toFixed(2)) }, { maxAbsDy: POS_LIMIT })),
  ...issues.font.map((issue) => findingFor(issue, 'typography', 'font-size-delta', `字号 ${issue.el.fs} → ${issue.designFontSize.toFixed(1)}`, { fontSize: issue.el.fs }, { designFontSize: Number(issue.designFontSize.toFixed(2)), maxFontDiff: FONT_LIMIT })),
  ...issues.tcolor.map((issue) => findingFor(issue, 'textColor', 'text-color-delta', `文字色 ${hex(issue.actualColor)} → ${hex(issue.designColor)}`, { color: hex(issue.actualColor), delta: Number(issue.delta.toFixed(2)) }, { color: hex(issue.designColor), maxDelta: TEXT_COLOR_LIMIT })),
  ...issues.bgcolor.map((issue) => findingFor(issue, 'backgroundColor', 'background-color-delta', `背景色 ${hex(issue.actualColor)} → ${hex(issue.designColor)}`, { color: hex(issue.actualColor), delta: Number(issue.delta.toFixed(2)) }, { color: hex(issue.designColor), maxDelta: BACKGROUND_LIMIT })),
  ...issues.border.map((issue) => findingFor(issue, 'border', 'border-color-delta', `边框色 ${hex(issue.actualColor)} → ${hex(issue.designColor)}`, { color: hex(issue.actualColor), delta: Number(issue.delta.toFixed(2)) }, { color: hex(issue.designColor), maxDelta: BORDER_LIMIT })),
];
const result = {
  version: 1,
  name,
  generatedAt: new Date().toISOString(),
  dpr,
  summary: { elements: els.length, measured, skips, ...summarizeFindings(findings) },
  measurements,
  findings,
};
writeFileSync(join(ROOT, 'output', name, 'full-audit.json'), `${JSON.stringify(result, null, 2)}\n`);

console.log(`\n═════ 全量审计 · ${name} ═════`);
console.log(`元素总数 ${els.length} | 有测量 ${measured} | 跳过明细: ${Object.entries(skips).map(([k, v]) => `${k}×${v}`).join(', ') || '无'}`);
const P = (list, title) => {
  console.log(`\n── ${title}(${list.length} 项)──`);
  list.slice(0, 25).forEach(({ el, v }) => console.log(`  ${el.sel.slice(0, 20).padEnd(20)} ${(el.text || '').padEnd(12)} ${v}`));
  if (list.length > 25) console.log(`  ...余 ${list.length - 25} 项`);
};
P(issues.pos, `位置偏差(|dy|≥${POS_LIMIT}px)`);
P(issues.font, `字号偏差(|Δ|≥${FONT_LIMIT}px,幅度按侵蚀打折采纳)`);
P(issues.tcolor, `文字色偏差(ΔRGB>${TEXT_COLOR_LIMIT})`);
P(issues.bgcolor, `背景色偏差(ΔRGB>${BACKGROUND_LIMIT})`);
P(issues.border, `边框色偏差(ΔRGB>${BORDER_LIMIT})`);

function targetFor(el) {
  return {
    selector: el.domPath || el.sel,
    displaySelector: el.sel,
    text: el.text,
    rect: { x: el.x, y: el.y, width: el.w, height: el.h },
  };
}

function measuredDimension(fail, value, threshold) {
  return { status: fail ? 'fail' : 'pass', value, threshold, source: 'full-audit' };
}

function skippedDimension(reason) {
  return { status: 'skipped', reason, source: 'full-audit' };
}

function findingFor(issue, dimension, code, title, actual, expected) {
  return makeFinding({
    detector: 'full-audit',
    code,
    dimension,
    severity: dimension === 'geometry' ? 'P1' : 'P2',
    title: `${issue.el.sel}: ${title}`,
    target: targetFor(issue.el),
    expected,
    actual,
    confidence: dimension === 'geometry' ? 0.8 : 0.72,
    nextAction: `复核 ${dimension} 测量并批量修正同类元素`,
  });
}
