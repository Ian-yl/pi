// 元素级颜色审计:遍历实现页面的所有元素,按「文字色 / 背景·填充色」两类,
// 对比 CSS 声明色、设计稿实测色、实现截图实测色,按 ΔE(Lab 色差)排序输出。
//
// 原理:实现是 HTML,每个元素的 bbox 与声明色已知。在 design/actual 的同一 bbox 内
// 用亮度聚类分离文字簇与背景簇,取"离背景最远 30% 像素"的均值作为实测文字核心色,
// 取"排除文字后的中位色"作为实测背景色。
//
// 用法: node scripts/color-audit.mjs <name> [--top=20] [--min-de=3]
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
const TOP = Number((process.argv.find((a) => a.startsWith('--top=')) || '').split('=')[1] || 20);

if (!name) {
  console.error('用法: node scripts/color-audit.mjs <name> [--top=20] [--min-de=3]');
  process.exit(1);
}
const cliDpr = Number((process.argv.find((a) => a.startsWith('--dpr=')) || '').split('=')[1] || NaN);
const cliMinDe = Number((process.argv.find((a) => a.startsWith('--min-de=')) || '').split('=')[1] || NaN);
const config = resolveRestoreConfig(name, { dpr: cliDpr, root: ROOT });
const dpr = config.viewport.dpr;
const MIN_DE = Number.isFinite(cliMinDe) ? cliMinDe : config.quality.maxColorDeltaE;

// ---------- 颜色数学 ----------
function rgb2lab([r, g, b]) {
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const lin = (v) => {
    v /= 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const deltaE = (c1, c2) => {
  const [l1, a1, b1] = rgb2lab(c1);
  const [l2, a2, b2] = rgb2lab(c2);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const parseCss = (s) => {
  const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  return m ? { c: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
};

// ---------- 像素采样 ----------
function pixelsIn(img, x, y, w, h, inset = 0) {
  const out = [];
  for (let cy = y + inset; cy < y + h - inset; cy++) {
    for (let cx = x + inset; cx < x + w - inset; cx++) {
      if (cx < 0 || cy < 0 || cx >= img.width || cy >= img.height) continue;
      const i = (img.width * cy + cx) << 2;
      out.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
    }
  }
  return out;
}
const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const medianColor = (px) =>
  px.length ? [median(px.map((p) => p[0])), median(px.map((p) => p[1])), median(px.map((p) => p[2]))] : null;
const mean = (px) => {
  const s = [0, 0, 0];
  for (const p of px) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
  return s.map((v) => v / px.length);
};

// 背景色 = 区域像素的中位色;文字核心色 = 离背景最远 30% 像素的均值
function splitTextBg(px) {
  if (px.length < 40) return null;
  const bg = medianColor(px);
  const byDist = px.map((p) => ({ p, d: dist(p, bg) })).sort((a, b) => b.d - a.d);
  const far = byDist.slice(0, Math.max(10, Math.floor(px.length * 0.12)));
  if (far[far.length - 1].d < 40) return { bg, text: null }; // 没有明显文字簇
  const core = far.slice(0, Math.max(6, Math.floor(far.length * 0.4))).map((o) => o.p);
  return { bg, text: mean(core) };
}
// 背景中位色(剔除文字像素)
function bgOnly(px) {
  if (!px.length) return null;
  const bg0 = medianColor(px);
  const kept = px.filter((p) => dist(p, bg0) < 45);
  return kept.length > px.length * 0.3 ? medianColor(kept) : bg0;
}

// ---------- 主流程 ----------
const design = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'design.png')));
const actual = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'actual.png')));

const session = await openAuditPage(config, { imageWidth: design.width, imageHeight: design.height });
const page = session.page;

const elements = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 10 || r.height < 8 || r.width * r.height > 500000) continue;
    const cls = typeof el.className === 'string' ? el.className.trim() : '';
    if (cls.includes('mosaic')) continue; // 故意模糊的 mock 文字跳过
    const directText = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .trim();
    const bgc = parseFloat(cs.backgroundColor.split(',')[3] ?? '1') !== 0 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
    const isImg = el.tagName === 'IMG';
    if (!directText && !bgc && !isImg) continue;
    out.push({
      sel: el.tagName.toLowerCase() + (cls ? '.' + cls.split(/\s+/).join('.') : ''),
      domPath: stableSelector(el),
      text: directText.slice(0, 10),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      color: cs.color, bg: bgc ? cs.backgroundColor : null,
      fontSize: parseFloat(cs.fontSize), isImg,
      hasText: !!directText,
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

const textRows = [], bgRows = [];
for (const el of elements) {
  const x = Math.round(el.x * dpr);
  const y = Math.round(el.y * dpr);
  const width = Math.round(el.w * dpr);
  const height = Math.round(el.h * dpr);
  const dPx = pixelsIn(design, x, y, width, height);
  const aPx = pixelsIn(actual, x, y, width, height);
  if (!dPx.length) continue;

  if (el.hasText) {
    const dSplit = splitTextBg(dPx);
    const aSplit = splitTextBg(aPx);
    if (dSplit?.text && aSplit?.text) {
      const cssC = parseCss(el.color)?.c;
      textRows.push({
        el, cssC,
        dText: dSplit.text, aText: aSplit.text,
        de: deltaE(dSplit.text, aSplit.text),
      });
    }
  }
  if (el.bg || el.isImg) {
    const inset = Math.round(Math.min(4, Math.floor(Math.min(el.w, el.h) / 5)) * dpr);
    const dBg = bgOnly(pixelsIn(design, x, y, width, height, inset));
    const aBg = bgOnly(pixelsIn(actual, x, y, width, height, inset));
    if (dBg && aBg) {
      bgRows.push({ el, dBg, aBg, de: deltaE(dBg, aBg), kind: el.isImg ? 'img' : 'bg' });
    }
  }
}

const fmt = (c) => (c ? hex(c) : '  --  ');
const textFindings = textRows.filter((row) => row.de >= MIN_DE).map((row) => makeFinding({
  detector: 'color-audit',
  code: 'text-color-delta',
  dimension: 'textColor',
  severity: row.de >= MIN_DE * 4 ? 'P1' : 'P2',
  title: `${row.el.sel} 文字色 ΔE ${row.de.toFixed(1)}`,
  target: { selector: row.el.domPath || row.el.sel, displaySelector: row.el.sel, text: row.el.text, rect: pickRect(row.el) },
  expected: { color: hex(row.dText) },
  actual: { color: hex(row.aText), cssColor: row.cssC ? hex(row.cssC) : null, deltaE: Number(row.de.toFixed(2)) },
  threshold: { maxDeltaE: MIN_DE },
  confidence: row.el.fontSize < 13 ? 0.65 : 0.82,
  nextAction: '使用 pick/inspect 复核笔画核心色，并批量修正同类文字',
}));
const backgroundFindings = bgRows.filter((row) => row.de >= MIN_DE).map((row) => makeFinding({
  detector: 'color-audit',
  code: 'background-color-delta',
  dimension: 'backgroundColor',
  severity: row.de >= MIN_DE * 4 ? 'P1' : 'P2',
  title: `${row.el.sel} 背景色 ΔE ${row.de.toFixed(1)}`,
  target: { selector: row.el.domPath || row.el.sel, displaySelector: row.el.sel, text: row.el.text, rect: pickRect(row.el) },
  expected: { color: hex(row.dBg) },
  actual: { color: hex(row.aBg), deltaE: Number(row.de.toFixed(2)) },
  threshold: { maxDeltaE: MIN_DE },
  confidence: 0.8,
  nextAction: '复核纯色采样区后修正背景或填充色',
}));
const findings = [...textFindings, ...backgroundFindings];
const result = {
  version: 1,
  name,
  generatedAt: new Date().toISOString(),
  dpr,
  threshold: { maxDeltaE: MIN_DE },
  summary: { elements: elements.length, textMeasurements: textRows.length, backgroundMeasurements: bgRows.length, ...summarizeFindings(findings) },
  textMeasurements: textRows.map(serializeTextRow),
  backgroundMeasurements: bgRows.map(serializeBackgroundRow),
  findings,
};
writeFileSync(join(ROOT, 'output', name, 'color-audit.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`\n═══ 文字色偏差(实测 actual ↔ design,ΔE ≥ ${MIN_DE},top ${TOP})═══`);
console.log('  ΔE   元素                            文本        css声明   design实测  actual实测');
textRows
  .filter((r) => r.de >= MIN_DE)
  .sort((a, b) => b.de - a.de)
  .slice(0, TOP)
  .forEach((r) =>
    console.log(
      `${r.de.toFixed(1).padStart(5)}  ${r.el.sel.slice(0, 30).padEnd(30)}  ${r.el.text.padEnd(8)}  ${fmt(r.cssC)}   ${fmt(r.dText)}     ${fmt(r.aText)}`,
    ),
  );

console.log(`\n═══ 背景/填充色偏差(actual ↔ design,ΔE ≥ ${MIN_DE},top ${TOP})═══`);
console.log('  ΔE   元素                            类型  design实测  actual实测');
bgRows
  .filter((r) => r.de >= MIN_DE)
  .sort((a, b) => b.de - a.de)
  .slice(0, TOP)
  .forEach((r) =>
    console.log(
      `${r.de.toFixed(1).padStart(5)}  ${r.el.sel.slice(0, 30).padEnd(30)}  ${r.kind.padEnd(4)}  ${fmt(r.dBg)}     ${fmt(r.aBg)}`,
    ),
  );
console.log(`\n共审计 ${elements.length} 个元素(文字 ${textRows.length} / 背景·填充 ${bgRows.length})。建议:文字色以 design实测 为准修 css;小字(<13px)受 JPEG 侵蚀,design实测 会偏向背景色,酌情参考。`);

function pickRect(el) {
  return { x: el.x, y: el.y, width: el.w, height: el.h };
}

function serializeTextRow(row) {
  return {
    target: { selector: row.el.domPath || row.el.sel, displaySelector: row.el.sel, text: row.el.text, rect: pickRect(row.el) },
    cssColor: row.cssC ? hex(row.cssC) : null,
    designColor: hex(row.dText),
    actualColor: hex(row.aText),
    deltaE: Number(row.de.toFixed(2)),
    status: row.de >= MIN_DE ? 'fail' : 'pass',
  };
}

function serializeBackgroundRow(row) {
  return {
    target: { selector: row.el.domPath || row.el.sel, displaySelector: row.el.sel, text: row.el.text, rect: pickRect(row.el) },
    kind: row.kind,
    designColor: hex(row.dBg),
    actualColor: hex(row.aBg),
    deltaE: Number(row.de.toFixed(2)),
    status: row.de >= MIN_DE ? 'fail' : 'pass',
  };
}
