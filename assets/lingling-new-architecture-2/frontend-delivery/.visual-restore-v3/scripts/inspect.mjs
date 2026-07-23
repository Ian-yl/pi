// 局部对照放大镜:裁出 design 与 actual 的同一区域,上下拼接输出,用于逐像素校准。
// 用法: node scripts/inspect.mjs <name> <x> <y> <w> <h> [outfile]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const [name, xs, ys, ws, hs, outfile = '/tmp/inspect.png'] = process.argv.slice(2);
if (!name || !hs) {
  console.error('用法: node scripts/inspect.mjs <name> <x> <y> <w> <h> [outfile]');
  process.exit(1);
}

const load = (f) => PNG.sync.read(readFileSync(join(ROOT, 'output', name, f)));
const design = load('design.png');
const actual = load('actual.png');

const X = Math.max(0, +xs), Y = Math.max(0, +ys);
const W = Math.min(+ws, design.width - X);
const H = Math.min(+hs, design.height - Y);

const GAP = 6;
const out = new PNG({ width: W, height: H * 2 + GAP });
out.data.fill(120); // 灰色分隔
PNG.bitblt(design, out, X, Y, W, H, 0, 0);
if (X + W <= actual.width && Y + H <= actual.height) {
  PNG.bitblt(actual, out, X, Y, W, H, 0, H + GAP);
}
writeFileSync(outfile, PNG.sync.write(out));
console.log(`上=design 下=actual @(${X},${Y}) ${W}×${H} → ${outfile}`);
