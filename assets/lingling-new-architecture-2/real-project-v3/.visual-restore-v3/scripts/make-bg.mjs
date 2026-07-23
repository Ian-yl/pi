// 从设计图生成"干净背景图":擦除全部 UI(含半透明磨砂卡片),得到可用于真实开发的连续背景素材。
//
// 两类擦除:
//   erase(纯插值)     — 不透明 UI(文字/按钮/侧边栏等):四边加权插值重建 + 水平柔化
//   eraseCard(融合)    — 磨砂卡片:中心用反 alpha 混合恢复卡下真实纹理(去掉卡片颜色成分),
//                        边缘 24px 渐变过渡到四边插值 —— 背景中不留卡片形状边界,又保住纹理
//   scrubCard(低频重建) — 后处理:用更远边界采样整块重建磨砂区域,清除残留细边/直线。
// 顺序:先 erase 全部(含卡内不透明小元素),再 eraseCard 整卡融合,最后 scrubCard 去幽灵线。
// 用法: node scripts/make-bg.mjs <name>
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));

const SPECS = {
  launchpad: {
    out: 'pages/launchpad/assets/hero-bg.png',
    erase: [
      // 侧边栏
      [22, 22, 186, 48],
      [16, 92, 194, 470],
      [22, 678, 190, 76],
      [22, 758, 190, 80],
      [24, 940, 186, 34],
      // 顶部:搜索框整块、右侧按钮组
      [234, 20, 282, 48],
      [1214, 20, 300, 48],
      // Hero 文字
      [234, 120, 424, 124],
      [234, 248, 304, 34],
      [234, 314, 464, 54],
      // 统计卡整块(周围是清晰雾山纹理,反混合的模糊质感会露块,用纯插值)
      [234, 424, 512, 152],
      // 正在进行卡内不透明内容(两列)
      [260, 618, 136, 30], [796, 616, 78, 34],
      [262, 676, 222, 56], [260, 748, 244, 42], [466, 744, 72, 46],
      [260, 816, 148, 16], [460, 794, 78, 42], [410, 846, 130, 40], [260, 852, 130, 22],
      [587, 676, 222, 56], [587, 748, 244, 42], [793, 744, 72, 46],
      [587, 816, 148, 16], [787, 794, 78, 42], [737, 846, 130, 40], [587, 852, 136, 22],
      [562, 672, 4, 214],
      // 即将开始卡内不透明内容(三行)
      [945, 616, 156, 36], [1396, 618, 78, 30],
      [945, 676, 58, 58], [1010, 676, 184, 48], [1214, 682, 86, 44], [1376, 676, 92, 50],
      [945, 748, 58, 58], [1010, 748, 184, 48], [1214, 754, 86, 44], [1376, 748, 92, 50],
      [945, 820, 58, 58], [1010, 820, 184, 48], [1214, 826, 86, 44], [1376, 820, 92, 50],
      // 底部功能条内容
      [252, 940, 280, 54], [564, 940, 280, 54], [876, 940, 280, 54], [1188, 940, 280, 54],
    ],
    // c/a 与页面 CSS 中对应磨砂元素的底色/透明度一致。
    // 仅用于暗水面/光晕弥散区(纹理融合不露块);清晰纹理区(统计卡/搜索框)用纯插值
    eraseCard: [
      { r: [238, 602, 652, 299], c: [109, 133, 203], a: 0.10 },   // 正在进行卡
      { r: [923, 602, 566, 299], c: [109, 133, 203], a: 0.10 },   // 即将开始卡
      { r: [238, 929, 1251, 79], c: [109, 133, 203], a: 0.10 },   // 底部功能条
    ],
    // 磨砂框反混合会保留真实纹理,但也会放大设计图里已经混入的细边/直线。
    // 这些区域最终会再经过 CSS backdrop-filter,高频纹理价值很低;这里改用低频重建兜底清理。
    scrubCard: [
      [228, 418, 524, 164, 14, 8, 12, 0.58],    // 统计卡
      [228, 592, 672, 319, 16, 9, 12, 0.62],    // 正在进行卡
      [913, 592, 586, 319, 16, 9, 12, 0.62],    // 即将开始卡
      [228, 919, 1269, 99, 16, 8, 12, 0.58],    // 底部功能条
    ],
    polishErase: [
      // 低频混合后仍容易露出的细亮线/边框:进度条、按钮、分割线、底部图标组
      [258, 818, 154, 16], [450, 790, 92, 50], [408, 844, 134, 44],
      [585, 818, 154, 16], [777, 790, 92, 50], [735, 844, 134, 44],
      [558, 668, 12, 220],
      [1372, 674, 100, 54], [1372, 746, 100, 54], [1372, 818, 100, 54],
      [228, 924, 1269, 10],
      [250, 938, 284, 58], [562, 938, 284, 58], [874, 938, 284, 58], [1186, 938, 284, 58],
    ],
  },
};

const name = process.argv[2];
const spec = SPECS[name];
if (!spec) {
  console.error(`未定义 ${name} 的背景清理 spec(编辑 scripts/make-bg.mjs 添加)`);
  process.exit(1);
}

const img = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'design.png')));
const { width: W, height: H, data } = img;

const idx = (x, y) => (W * y + x) << 2;
const getPx = (x, y) => {
  x = Math.max(0, Math.min(W - 1, x));
  y = Math.max(0, Math.min(H - 1, y));
  const i = idx(x, y);
  return [data[i], data[i + 1], data[i + 2]];
};

// 四边加权插值(1/距离^1.5),返回 Float32 缓冲,不直接写回
function interp(x, y, w, h) {
  return interpWithOffset(x, y, w, h, 2);
}

function interpWithOffset(x, y, w, h, sampleOffset = 2) {
  const top = [], bot = [], lef = [], rig = [];
  for (let cx = x; cx < x + w; cx++) {
    top[cx - x] = getPx(cx, y - sampleOffset);
    bot[cx - x] = getPx(cx, y + h - 1 + sampleOffset);
  }
  for (let cy = y; cy < y + h; cy++) {
    lef[cy - y] = getPx(x - sampleOffset, cy);
    rig[cy - y] = getPx(x + w - 1 + sampleOffset, cy);
  }
  const buf = new Float32Array(w * h * 3);
  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
      const dT = cy - y + 1, dB = y + h - cy, dL = cx - x + 1, dR = x + w - cx;
      const wT = dT ** -1.5, wB = dB ** -1.5, wL = dL ** -1.5, wR = dR ** -1.5;
      const sw = wT + wB + wL + wR;
      const T = top[cx - x], B = bot[cx - x], L = lef[cy - y], R = rig[cy - y];
      const o = ((cy - y) * w + (cx - x)) * 3;
      for (let k = 0; k < 3; k++) buf[o + k] = (T[k] * wT + B[k] * wB + L[k] * wL + R[k] * wR) / sw;
    }
  }
  return buf;
}

function writeBuf(x, y, w, h, buf) {
  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
      const o = ((cy - y) * w + (cx - x)) * 3;
      const i = idx(cx, cy);
      data[i] = Math.round(Math.max(0, Math.min(255, buf[o])));
      data[i + 1] = Math.round(Math.max(0, Math.min(255, buf[o + 1])));
      data[i + 2] = Math.round(Math.max(0, Math.min(255, buf[o + 2])));
      data[i + 3] = 255;
    }
  }
}

// 区域内水平柔化,融合插值痕迹
function softenH(x, y, w, h, R = 4) {
  for (let cy = y; cy < y + h; cy++) {
    const row = [];
    for (let cx = x - R; cx < x + w + R; cx++) row.push(getPx(cx, cy));
    for (let cx = x; cx < x + w; cx++) {
      const s = [0, 0, 0];
      for (let o = -R; o <= R; o++) {
        const p = row[cx - x + R + o];
        s[0] += p[0]; s[1] += p[1]; s[2] += p[2];
      }
      const i = idx(cx, cy);
      const n = R * 2 + 1;
      data[i] = Math.round(s[0] / n);
      data[i + 1] = Math.round(s[1] / n);
      data[i + 2] = Math.round(s[2] / n);
    }
  }
}

function erase(x, y, w, h) {
  writeBuf(x, y, w, h, interp(x, y, w, h));
  softenH(x, y, w, h);
}

function boxBlurRect(x, y, w, h, R = 5) {
  const src = new Uint8Array(w * h * 3);
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const si = (cy * w + cx) * 3;
      const di = idx(x + cx, y + cy);
      src[si] = data[di];
      src[si + 1] = data[di + 1];
      src[si + 2] = data[di + 2];
    }
  }
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const sum = [0, 0, 0];
      let n = 0;
      for (let oy = -R; oy <= R; oy++) {
        const yy = Math.max(0, Math.min(h - 1, cy + oy));
        for (let ox = -R; ox <= R; ox++) {
          const xx = Math.max(0, Math.min(w - 1, cx + ox));
          const si = (yy * w + xx) * 3;
          sum[0] += src[si];
          sum[1] += src[si + 1];
          sum[2] += src[si + 2];
          n++;
        }
      }
      const di = idx(x + cx, y + cy);
      data[di] = Math.round(sum[0] / n);
      data[di + 1] = Math.round(sum[1] / n);
      data[di + 2] = Math.round(sum[2] / n);
    }
  }
}

function scrubCard(x, y, w, h, sampleOffset = 12, blurRadius = 8, feather = 10, strength = 1) {
  const before = new Uint8Array(w * h * 3);
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const si = (cy * w + cx) * 3;
      const di = idx(x + cx, y + cy);
      before[si] = data[di];
      before[si + 1] = data[di + 1];
      before[si + 2] = data[di + 2];
    }
  }
  writeBuf(x, y, w, h, interpWithOffset(x, y, w, h, sampleOffset));
  boxBlurRect(x, y, w, h, blurRadius);
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const d = Math.min(cx, w - 1 - cx, cy, h - 1 - cy);
      let t = Math.min(1, d / feather);
      t = t * t * (3 - 2 * t);
      t *= strength;
      const si = (cy * w + cx) * 3;
      const di = idx(x + cx, y + cy);
      for (let k = 0; k < 3; k++) {
        data[di + k] = Math.round(before[si + k] * (1 - t) + data[di + k] * t);
      }
    }
  }
}

function erasePolish(x, y, w, h) {
  writeBuf(x, y, w, h, interpWithOffset(x, y, w, h, 8));
  boxBlurRect(x, y, w, h, 3);
}

// 磨砂卡:反混合恢复纹理(中心)+ 四边插值(边缘),按到边界距离 smoothstep 融合
function eraseCard(x, y, w, h, c, a) {
  const I = interp(x, y, w, h);
  const F = 24; // 融合带宽
  const buf = new Float32Array(w * h * 3);
  for (let cy = y; cy < y + h; cy++) {
    for (let cx = x; cx < x + w; cx++) {
      const o = ((cy - y) * w + (cx - x)) * 3;
      const d = Math.min(cy - y, y + h - 1 - cy, cx - x, x + w - 1 - cx);
      let t = Math.min(1, d / F);
      t = t * t * (3 - 2 * t); // smoothstep
      const i = idx(cx, cy);
      for (let k = 0; k < 3; k++) {
        const un = (data[i + k] - c[k] * a) / (1 - a); // unblend:去掉卡片颜色成分
        buf[o + k] = I[o + k] * (1 - t) + un * t;
      }
    }
  }
  writeBuf(x, y, w, h, buf);
  softenH(x, y, w, h, 2); // 轻柔化压 unblend 放大的 JPEG 噪声
}

for (const [x, y, w, h] of spec.erase) erase(x, y, w, h);
for (const { r: [x, y, w, h], c, a } of spec.eraseCard) eraseCard(x, y, w, h, c, a);
for (const [x, y, w, h, sampleOffset, blurRadius, feather, strength] of spec.scrubCard || []) {
  scrubCard(x, y, w, h, sampleOffset, blurRadius, feather, strength);
}
for (const [x, y, w, h] of spec.polishErase || []) erasePolish(x, y, w, h);

writeFileSync(join(ROOT, spec.out), PNG.sync.write(img));
console.log(`✅ 干净背景已生成: ${spec.out}(纯插值 ${spec.erase.length} 处,磨砂融合 ${spec.eraseCard.length} 处,低频清理 ${(spec.scrubCard || []).length} 处,局部抛光 ${(spec.polishErase || []).length} 处)`);
