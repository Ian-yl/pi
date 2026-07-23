// 字体审计:全页每个文字元素,用「墨高比 = 字号比」反推设计稿字号。
//   designFs = myFs × designInkH / actualInkH(同段文字,不依赖字体 cap 系数)
// 输出按偏差排序的全页字号修正清单 —— 一次修完,不点修。
// 用法: node scripts/font-audit.mjs <name> [--dpr=2] [--min-diff=0.8]
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
if (!name) throw new Error('用法: node scripts/font-audit.mjs <name> [--dpr=2] [--min-diff=1.2]');
const cliDpr = Number((process.argv.find((a) => a.startsWith('--dpr=')) || '').split('=')[1] || NaN);
const cliMin = Number((process.argv.find((a) => a.startsWith('--min-diff=')) || '').split('=')[1] || NaN);
const config = resolveRestoreConfig(name, { dpr: cliDpr, root: ROOT });
const dpr = config.viewport.dpr;
const MIN = Number.isFinite(cliMin) ? cliMin : config.quality.maxFontDiff;

const design = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'design.png')));
const actual = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'actual.png')));

const session = await openAuditPage(config, { imageWidth: design.width, imageHeight: design.height });
const page = session.page;

// 收集所有含直接文本的元素(单行优先)
const els = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (!text || text.length < 2) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 6) continue;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    out.push({
      sel: el.tagName.toLowerCase() + (cls ? '.' + cls : ''),
      domPath: stableSelector(el),
      text: text.slice(0, 14),
      x: r.x, y: r.y, w: r.width, h: r.height,
      fs: parseFloat(cs.fontSize),
      lines: Math.round(r.height / parseFloat(cs.lineHeight || cs.fontSize)) || 1,
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

// 区域文字墨高 v2:墨段分割 —— 逐行判墨后按空隙(≥2px)切段,
// 只取「与窗垂直中心最重叠」的墨段(即元素自身行),邻行不再污染。
function inkRange(img, X, Y, W, H) {
  const px = (x, y) => {
    const i = (img.width * y + x) << 2;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const edge = [];
  for (let x = X; x < X + W; x += 3) { edge.push(px(x, Y), px(x, Y + H - 1)); }
  const med = (a) => a.sort((m, n) => m - n)[a.length >> 1];
  const bg = [med(edge.map((p) => p[0])), med(edge.map((p) => p[1])), med(edge.map((p) => p[2]))];
  const rowHit = [];
  for (let y = Y; y < Y + H; y++) {
    let hit = 0;
    for (let x = X; x < X + W; x++) {
      const p = px(x, y);
      if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 110) hit++;
    }
    rowHit.push(hit >= 2);
  }
  // 切墨段(允许段内 1px 空隙)
  const segs = [];
  let s = -1, gap = 0;
  for (let i = 0; i <= rowHit.length; i++) {
    if (i < rowHit.length && rowHit[i]) { if (s < 0) s = i; gap = 0; }
    else if (s >= 0 && (++gap > 1 || i === rowHit.length)) { segs.push([s, i - gap]); s = -1; gap = 0; }
  }
  if (!segs.length) return null;
  const mid = H / 2;
  segs.sort((a, b) => Math.abs((a[0] + a[1]) / 2 - mid) - Math.abs((b[0] + b[1]) / 2 - mid));
  return segs[0][1] - segs[0][0] + 1;
}

const rows = [];
const skipped = [];
for (const el of els) {
  if (el.lines > 1) {
    skipped.push({ target: targetFor(el), status: 'skipped', reason: '多行文字需人工复核' });
    continue;
  }
  const pad = 2 * dpr;
  const X = Math.max(0, Math.round(el.x * dpr) - pad);
  const Y = Math.max(0, Math.round(el.y * dpr) - pad);
  const W = Math.min(design.width - X, Math.round(el.w * dpr) + pad * 2);
  const H = Math.min(design.height - Y, Math.round(el.h * dpr) + pad * 2);
  if (W <= 0 || H <= 0) {
    skipped.push({ target: targetFor(el), status: 'skipped', reason: '测量区域越界' });
    continue;
  }
  const dInk = inkRange(design, X, Y, W, H);
  const aInk = inkRange(actual, X, Y, W, H);
  if (!dInk || !aInk || aInk < 4) {
    skipped.push({ target: targetFor(el), status: 'skipped', reason: '文字墨迹不可稳定测量' });
    continue;
  }
  const designFs = (el.fs * dInk) / aInk;
  rows.push({ ...el, dInk, aInk, designFs, diff: designFs - el.fs });
}

const findings = rows
  .filter((row) => Math.abs(row.diff) >= MIN)
  .map((row) => makeFinding({
    detector: 'font-audit',
    code: 'font-size-delta',
    dimension: 'typography',
    severity: Math.abs(row.diff) >= MIN * 2.5 ? 'P1' : 'P2',
    title: `${row.sel} 字号偏差 ${row.diff >= 0 ? '+' : ''}${row.diff.toFixed(1)}px`,
    target: targetFor(row),
    expected: { fontSize: Number(row.designFs.toFixed(2)), inkHeight: row.dInk },
    actual: { fontSize: row.fs, inkHeight: row.aInk, delta: Number(row.diff.toFixed(2)) },
    threshold: { maxFontDiff: MIN },
    confidence: 0.75,
    nextAction: '结合 inspect 与文字宽度复核后，批量修正同类字号并重新对位',
  }));
const result = {
  version: 1,
  name,
  generatedAt: new Date().toISOString(),
  dpr,
  threshold: { maxFontDiff: MIN },
  summary: {
    visibleTextElements: els.length,
    measured: rows.length,
    skipped: skipped.length,
    aligned: rows.filter((row) => Math.abs(row.diff) < MIN).length,
    ...summarizeFindings(findings),
  },
  measurements: rows.map((row) => ({
    target: targetFor(row),
    fontSize: row.fs,
    designFontSize: Number(row.designFs.toFixed(2)),
    delta: Number(row.diff.toFixed(2)),
    actualInkHeight: row.aInk,
    designInkHeight: row.dInk,
    status: Math.abs(row.diff) >= MIN ? 'fail' : 'pass',
  })),
  skipped,
  findings,
};
writeFileSync(join(ROOT, 'output', name, 'font-audit.json'), `${JSON.stringify(result, null, 2)}\n`);

console.log(`\n═══ 字体审计(墨高比反推;|Δ| ≥ ${MIN}px 需修,按偏差排序)═══`);
console.log('   Δfs   我的fs → 设计fs   墨高(a/d)  元素                    文本');
rows
  .filter((r) => Math.abs(r.diff) >= MIN)
  .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
  .forEach((r) =>
    console.log(
      `${(r.diff >= 0 ? '+' : '') + r.diff.toFixed(1).padStart(5)}   ${String(r.fs).padStart(5)} → ${r.designFs.toFixed(1).padStart(5)}   ${String(r.aInk).padStart(3)}/${String(r.dInk).padEnd(3)}    ${r.sel.slice(0, 22).padEnd(22)}  ${r.text}`,
    ),
  );
const ok = rows.filter((r) => Math.abs(r.diff) < MIN).length;
console.log(`\n共测 ${rows.length} 段单行文字,已对齐(|Δ|<${MIN})${ok} 段;多行元素 ${els.filter((e) => e.lines > 1).length} 段未测(需人工)`);

function targetFor(el) {
  return {
    selector: el.domPath || el.sel,
    displaySelector: el.sel,
    text: el.text,
    rect: { x: el.x, y: el.y, width: el.w, height: el.h },
  };
}
