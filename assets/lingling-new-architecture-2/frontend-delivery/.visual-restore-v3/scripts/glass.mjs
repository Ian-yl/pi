// 磨砂玻璃参数反解:P_in = P_out×(1-α) + C×α
// 沿卡片边缘采样内外像素对(边界处背景近似连续),对每个通道做最小二乘回归,
// 解出磨砂层的真实底色 C 与透明度 α。
// 用法: node scripts/glass.mjs <name> "标签:x,y,w,h; ..."   (x,y,w,h 为卡片矩形)
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const [name, specStr] = process.argv.slice(2);

const img = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'design.png')));
const { width: W, data } = img;

// 5×5 均值采样,抑制噪声与 blur 边缘效应
function avg(x, y) {
  const s = [0, 0, 0];
  let n = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const i = (W * (y + dy) + (x + dx)) << 2;
      s[0] += data[i]; s[1] += data[i + 1]; s[2] += data[i + 2];
      n++;
    }
  }
  return [s[0] / n, s[1] / n, s[2] / n];
}

function solve(label, x, y, w, h) {
  const OUT = 5, IN = 8, CORNER = 22, STEP = 6;
  const pairs = [];
  for (let cx = x + CORNER; cx <= x + w - CORNER; cx += STEP) {
    pairs.push([avg(cx, y - OUT), avg(cx, y + IN)]);           // 上边
    pairs.push([avg(cx, y + h + OUT), avg(cx, y + h - IN)]);   // 下边
  }
  for (let cy = y + CORNER; cy <= y + h - CORNER; cy += STEP) {
    pairs.push([avg(x - OUT, cy), avg(x + IN, cy)]);           // 左边
    pairs.push([avg(x + w + OUT, cy), avg(x + w - IN, cy)]);   // 右边
  }
  const alphas = [], colors = [];
  for (let ch = 0; ch < 3; ch++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    const n = pairs.length;
    for (const [po, pi] of pairs) {
      sx += po[ch]; sy += pi[ch]; sxx += po[ch] * po[ch]; sxy += po[ch] * pi[ch];
    }
    const k = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const b = (sy - k * sx) / n;
    const a = 1 - k;
    alphas.push(a);
    colors.push(b / a);
  }
  const a = alphas.reduce((s, v) => s + v) / 3;
  const c = colors.map((v) => Math.round(Math.max(0, Math.min(255, v))));
  console.log(
    `${label}: α ≈ ${a.toFixed(3)} (R${alphas[0].toFixed(2)}/G${alphas[1].toFixed(2)}/B${alphas[2].toFixed(2)})  底色 ≈ rgb(${c.join(',')})  样本 ${pairs.length}`,
  );
}

for (const item of specStr.split(';')) {
  const s = item.trim();
  if (!s) continue;
  const [label, nums] = s.split(':');
  const [x, y, w, h] = nums.split(',').map(Number);
  solve(label.trim(), x, y, w, h);
}
