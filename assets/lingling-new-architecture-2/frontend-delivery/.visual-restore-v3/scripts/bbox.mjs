// 元素精确定位:在指定区域内找出"亮于阈值"像素的包围盒,对比 design 与 actual 的偏移。
// 用法: node scripts/bbox.mjs <name> <x> <y> <w> <h> [--lum=90] [--label=xxx]
//   多组区域可用分号一次传入: node scripts/bbox.mjs <name> "label1:x,y,w,h,lum; label2:x,y,w,h"
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
const name = args[0];

const load = (f) => PNG.sync.read(readFileSync(join(ROOT, 'output', name, f)));
const design = load('design.png');
const actual = load('actual.png');

function bbox(img, X, Y, W, H, lum) {
  let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1, count = 0;
  for (let y = Y; y < Y + H && y < img.height; y++) {
    for (let x = X; x < X + W && x < img.width; x++) {
      const i = (img.width * y + x) << 2;
      const L = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      if (L > lum) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
        count++;
      }
    }
  }
  return count ? { x1, y1, x2, y2, w: x2 - x1 + 1, h: y2 - y1 + 1, count } : null;
}

function report(label, X, Y, W, H, lum) {
  const d = bbox(design, X, Y, W, H, lum);
  const a = bbox(actual, X, Y, W, H, lum);
  const fmt = (b) => (b ? `x[${b.x1}-${b.x2}] y[${b.y1}-${b.y2}] w${b.w} h${b.h}` : '(空)');
  let off = '';
  if (d && a) off = `  → 偏移 dx=${a.x1 - d.x1},${a.x2 - d.x2} dy=${a.y1 - d.y1},${a.y2 - d.y2}`;
  console.log(`${label} (lum>${lum})\n  design ${fmt(d)}\n  actual ${fmt(a)}${off}`);
}

// 多组: "label:x,y,w,h[,lum]; ..."
if (args[1] && args[1].includes(':')) {
  for (const spec of args[1].split(';')) {
    const s = spec.trim();
    if (!s) continue;
    const [label, nums] = s.split(':');
    const [x, y, w, h, lum = 90] = nums.split(',').map(Number);
    report(label.trim(), x, y, w, h, lum);
  }
} else {
  const [x, y, w, h] = args.slice(1, 5).map(Number);
  const lum = Number((args.find((a) => a.startsWith('--lum=')) || '').split('=')[1] || 90);
  report('区域', x, y, w, h, lum);
}
