// 差异归因分析:统计 diff.png 中差异像素(红色)在各功能区域的分布,并输出网格热点。
// 用法: node scripts/diffmap.mjs <name>
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const name = process.argv[2];

const img = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'diff.png')));
const { width: W, height: H, data } = img;

// pixelmatch 差异像素为红色系
const isDiff = (x, y) => {
  const i = (W * y + x) << 2;
  return data[i] > 180 && data[i + 1] < 120 && data[i + 2] < 120;
};

// launchpad 功能区域(与页面布局对应,卡片区分「卡内 UI 密集区」之外的部分即透底区)
const REGIONS = {
  侧边栏: [0, 0, 224, 1024],
  顶部导航: [224, 0, 1312, 90],
  'Hero文字区': [224, 90, 560, 300],
  'Hero右侧背景': [784, 90, 752, 300],
  统计卡: [240, 428, 500, 144],
  统计卡右侧背景: [740, 390, 796, 214],
  正在进行卡: [240, 604, 648, 295],
  即将开始卡: [925, 604, 562, 295],
  卡间缝隙带: [888, 604, 37, 295],
  底部功能条: [240, 931, 1247, 75],
  其余边缘: null, // 兜底
};

let total = 0;
const counts = Object.fromEntries(Object.keys(REGIONS).map((k) => [k, 0]));
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!isDiff(x, y)) continue;
    total++;
    let hit = false;
    for (const [k, r] of Object.entries(REGIONS)) {
      if (!r) continue;
      if (x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]) {
        counts[k]++;
        hit = true;
        break;
      }
    }
    if (!hit) counts['其余边缘']++;
  }
}

console.log(`总差异像素: ${total.toLocaleString()}(${((total / (W * H)) * 100).toFixed(2)}% 面积)\n`);
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
for (const [k, c] of sorted) {
  const pct = ((c / total) * 100).toFixed(1);
  console.log(`${String(pct).padStart(5)}%  ${c.toLocaleString().padStart(9)} px  ${k}`);
}

// 32px 网格热点 top 12
const GS = 32;
const grid = new Map();
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!isDiff(x, y)) continue;
    const key = `${Math.floor(x / GS) * GS},${Math.floor(y / GS) * GS}`;
    grid.set(key, (grid.get(key) || 0) + 1);
  }
}
console.log('\n热点网格 top12(32×32 块,坐标为左上角):');
[...grid.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([k, c]) => console.log(`  (${k})  ${c} px`));
