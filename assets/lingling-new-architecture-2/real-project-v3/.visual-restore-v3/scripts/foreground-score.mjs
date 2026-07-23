// Foreground/content-weighted similarity.
// Full-canvas pixel scores can be inflated by blank background. This metric compares
// only salient pixels: edges and pixels that differ from the page's dominant color.
// Usage:
//   node scripts/foreground-score.mjs <name> [--threshold=0.1] [--json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import pixelmatch from 'pixelmatch';
import { isRedDiffPixel } from './lib/image-metrics.mjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));

export function salientMask(img, {
  bgThreshold = 32,
  edgeThreshold = 26,
  dilate = 1,
  stride = 3,
} = {}) {
  const bg = dominantMedianColor(img, stride);
  const raw = new Uint8Array(img.width * img.height);

  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const idx = y * img.width + x;
      const p = rgbAt(img, x, y);
      const bgDist = colorDist(p, bg);
      const edge = localEdge(img, x, y);
      if (bgDist >= bgThreshold || edge >= edgeThreshold) raw[idx] = 1;
    }
  }

  return dilate > 0 ? dilateMask(raw, img.width, img.height, dilate) : raw;
}

export function foregroundScore(design, actual, { threshold = 0.1 } = {}) {
  const W = Math.max(design.width, actual.width);
  const H = Math.max(design.height, actual.height);
  const d = padTo(design, W, H);
  const a = padTo(actual, W, H);
  const diff = new PNG({ width: W, height: H });
  const mismatch = pixelmatch(d.data, a.data, diff.data, W, H, { threshold });
  const dMask = salientMask(d);
  const aMask = salientMask(a);

  let salientPixels = 0;
  let foregroundMismatch = 0;
  for (let i = 0; i < W * H; i++) {
    const salient = dMask[i] || aMask[i];
    if (!salient) continue;
    salientPixels++;
    if (isRedDiffPixel(diff.data, i << 2)) foregroundMismatch++;
  }

  return {
    width: W,
    height: H,
    pixels: W * H,
    fullMismatch: mismatch,
    fullSimilarity: round4(100 * (1 - mismatch / (W * H))),
    salientPixels,
    salientRatio: round4((100 * salientPixels) / (W * H)),
    foregroundMismatch,
    foregroundSimilarity: salientPixels
      ? round4(100 * (1 - foregroundMismatch / salientPixels))
      : 100,
  };
}

function dominantMedianColor(img, stride) {
  const rs = [];
  const gs = [];
  const bs = [];
  for (let y = 0; y < img.height; y += stride) {
    for (let x = 0; x < img.width; x += stride) {
      const o = (img.width * y + x) << 2;
      if (img.data[o + 3] < 10) continue;
      rs.push(img.data[o]);
      gs.push(img.data[o + 1]);
      bs.push(img.data[o + 2]);
    }
  }
  return [median(rs), median(gs), median(bs)];
}

function localEdge(img, x, y) {
  const p = rgbAt(img, x, y);
  let edge = 0;
  if (x > 0) edge = Math.max(edge, colorDist(p, rgbAt(img, x - 1, y)));
  if (x < img.width - 1) edge = Math.max(edge, colorDist(p, rgbAt(img, x + 1, y)));
  if (y > 0) edge = Math.max(edge, colorDist(p, rgbAt(img, x, y - 1)));
  if (y < img.height - 1) edge = Math.max(edge, colorDist(p, rgbAt(img, x, y + 1)));
  return edge;
}

function dilateMask(mask, width, height, radius) {
  const out = new Uint8Array(mask);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let yy = Math.max(0, y - radius); yy <= Math.min(height - 1, y + radius); yy++) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(width - 1, x + radius); xx++) {
          out[yy * width + xx] = 1;
        }
      }
    }
  }
  return out;
}

function padTo(img, W, H) {
  if (img.width === W && img.height === H) return img;
  const out = new PNG({ width: W, height: H });
  out.data.fill(255);
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

function rgbAt(img, x, y) {
  const o = (img.width * y + x) << 2;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

function colorDist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function median(values) {
  if (!values.length) return 255;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function round4(value) {
  return Number(value.toFixed(4));
}

function parseArgs(argv) {
  const args = { name: null, threshold: 0.1, json: false };
  for (const item of argv) {
    if (item === '--json') args.json = true;
    else if (item.startsWith('--threshold=')) args.threshold = Number(item.slice('--threshold='.length));
    else if (!args.name) args.name = item;
    else throw new Error(`未知参数: ${item}`);
  }
  if (!args.name) throw new Error('用法: node scripts/foreground-score.mjs <name> [--threshold=0.1] [--json]');
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const outDir = join(ROOT, 'output', args.name);
  const designPath = join(outDir, 'design.png');
  const actualPath = join(outDir, 'actual.png');
  if (!existsSync(designPath) || !existsSync(actualPath)) {
    throw new Error(`缺少 output/${args.name}/design.png 或 actual.png,请先运行 npm run verify ${args.name}`);
  }
  const design = PNG.sync.read(readFileSync(designPath));
  const actual = PNG.sync.read(readFileSync(actualPath));
  const result = {
    version: 3,
    name: args.name,
    generatedAt: new Date().toISOString(),
    threshold: args.threshold,
    ...foregroundScore(design, actual, { threshold: args.threshold }),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'foreground-score.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`前景相似度: ${result.foregroundSimilarity.toFixed(2)}% · 全图 ${result.fullSimilarity.toFixed(2)}% · salient ${result.salientRatio.toFixed(2)}%`);
    console.log(`报告: output/${args.name}/foreground-score.json`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
