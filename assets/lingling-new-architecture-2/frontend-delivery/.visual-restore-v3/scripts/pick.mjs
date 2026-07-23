// 取色对比:输出 design 与 actual 在同一坐标的颜色值与差值(默认 3×3 均值抗噪)。
// 用法: node scripts/pick.mjs <name> "x,y; x,y; ..." [--r=1]
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const [name, ptsStr] = process.argv.slice(2);
const R = Number((process.argv.find((a) => a.startsWith('--r=')) || '').split('=')[1] || 1);

if (!name || !ptsStr) {
  console.error('用法: node scripts/pick.mjs <name> "x,y; x,y" [--r=1]');
  process.exit(1);
}

const load = (f) => PNG.sync.read(readFileSync(join(ROOT, 'output', name, f)));
const design = load('design.png');
const actual = load('actual.png');

function avg(img, x, y) {
  const s = [0, 0, 0];
  let n = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const px = Math.max(0, Math.min(img.width - 1, x + dx));
      const py = Math.max(0, Math.min(img.height - 1, y + dy));
      const i = (img.width * py + px) << 2;
      s[0] += img.data[i]; s[1] += img.data[i + 1]; s[2] += img.data[i + 2];
      n++;
    }
  }
  return s.map((v) => Math.round(v / n));
}

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

for (const item of ptsStr.split(';')) {
  const s = item.trim();
  if (!s) continue;
  const [x, y] = s.split(',').map(Number);
  const d = avg(design, x, y);
  const a = avg(actual, x, y);
  const delta = d.map((v, i) => a[i] - v);
  console.log(
    `(${x},${y})  design ${hex(d)} rgb(${d.join(',')})  |  actual ${hex(a)} rgb(${a.join(',')})  |  Δ ${delta.map((v) => (v >= 0 ? '+' : '') + v).join(',')}`,
  );
}
