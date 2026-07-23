// CSS 候选扫分:在不修改源码的情况下,批量注入 CSS 候选并按 pixelmatch 相似度排序。
//
// 用法:
//   node scripts/sweep-css.mjs <name> candidates.json --dpr=2 --top=20
//   node scripts/sweep-css.mjs <name> --css=".inp{height:41px}" --label=compact-input --dpr=2
//
// candidates.json 支持:
//   [
//     { "label": "baseline", "css": "" },
//     { "label": "input compact", "css": ".inp{height:41px}" }
//   ]
// 或:
//   { "base": ".card{...}", "candidates": [{ "label": "...", "css": "..." }] }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import pixelmatch from 'pixelmatch';
import { openAuditPage } from './lib/browser-target.mjs';
import { convertRasterToPng } from './lib/raster-image.mjs';
import { resolveRestoreConfig } from './lib/restore-config.mjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--') && !a.endsWith('.json'));
const jsonPath = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));

const opt = (key, fallback = undefined) => {
  const hit = args.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : fallback;
};

const cliDpr = Number(opt('dpr', NaN));
const cliThreshold = Number(opt('threshold', NaN));
const topN = Number(opt('top', 20));
const outPath = opt('out');
const inlineCss = opt('css');
const inlineLabel = opt('label', 'inline');

if (!name) {
  console.error('用法: node scripts/sweep-css.mjs <name> [candidates.json] [--css=...] [--dpr=2]');
  process.exit(1);
}
const config = resolveRestoreConfig(name, { root: ROOT, dpr: cliDpr, threshold: cliThreshold });
const dpr = config.viewport.dpr;
const threshold = config.quality.threshold;

async function locateDesign(pageName, outDir) {
  const png = join(ROOT, 'designs', `${pageName}.png`);
  if (existsSync(png)) return png;
  for (const ext of ['jpg', 'jpeg', 'webp']) {
    const src = join(ROOT, 'designs', `${pageName}.${ext}`);
    if (existsSync(src)) {
      const converted = join(outDir, 'sweep-design.png');
      await convertRasterToPng(src, converted);
      return converted;
    }
  }
  throw new Error(`找不到设计图 designs/${pageName}.png(也支持 .jpg/.jpeg/.webp)`);
}

function padTo(img, width, height) {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  out.data.fill(255);
  PNG.bitblt(img, out, 0, 0, Math.min(img.width, width), Math.min(img.height, height), 0, 0);
  return out;
}

function loadCandidates() {
  if (inlineCss !== undefined) return [{ label: inlineLabel, css: inlineCss }];
  if (!jsonPath) return [{ label: 'baseline', css: '' }];

  const raw = JSON.parse(readFileSync(resolve(jsonPath), 'utf8'));
  if (Array.isArray(raw)) return raw;

  if (raw && Array.isArray(raw.candidates)) {
    const base = raw.base || '';
    return raw.candidates.map((candidate) => ({
      label: candidate.label,
      css: `${base}${candidate.css || ''}`,
    }));
  }

  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([label, css]) => ({ label, css }));
  }

  throw new Error('候选文件必须是数组、{base,candidates} 或 {label: css} 对象');
}

const outDir = join(ROOT, 'output', name);
mkdirSync(outDir, { recursive: true });
const design = PNG.sync.read(readFileSync(await locateDesign(name, outDir)));
const candidates = loadCandidates();

const session = await openAuditPage(config, { imageWidth: design.width, imageHeight: design.height });
const page = session.page;

async function scoreCandidate(candidate) {
  await page.goto(session.targetUrl, { waitUntil: 'networkidle', timeout: config.capture.timeoutMs });
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}${candidate.css || ''}`,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(80);

  const shot = PNG.sync.read(await page.screenshot({ fullPage: config.capture.fullPage, type: 'png' }));
  const width = Math.max(design.width, shot.width);
  const height = Math.max(design.height, shot.height);
  const diff = new PNG({ width, height });
  const mismatch = pixelmatch(
    padTo(design, width, height).data,
    padTo(shot, width, height).data,
    diff.data,
    width,
    height,
    { threshold },
  );

  return {
    label: candidate.label || '(unnamed)',
    similarity: 100 * (1 - mismatch / (width * height)),
    mismatch,
    size: `${shot.width}x${shot.height}`,
  };
}

try {
  const results = [];
  for (const candidate of candidates) results.push(await scoreCandidate(candidate));
  results.sort((a, b) => b.similarity - a.similarity);

  for (const result of results.slice(0, topN)) {
    console.log(`${result.similarity.toFixed(4)} ${result.mismatch} ${result.size} ${result.label}`);
  }

  if (outPath) writeFileSync(resolve(outPath), `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await session.close();
}
