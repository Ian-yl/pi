// 把 pages/<name>/ 的渲染截图保存为 designs/<name>.png。
// 用途:① 冒烟测试(自己截自己,verify 应得 ~100%);② 以现有页面截图作为还原基准。
//
// 用法: npm run snapshot <name> [-- --width=1440 --height=900 --dpr=1]

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { capturePage, ROOT } from './verify.mjs';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? Number(hit.split('=')[1]) : d;
};

if (!name) {
  console.error('用法: npm run snapshot <name> [-- --width=1440 --height=900 --dpr=1]');
  process.exit(1);
}

const dpr = opt('dpr', 1);
const width = opt('width', 1440) * dpr;
const height = opt('height', 900) * dpr;

const dest = join(ROOT, 'designs', `${name}.png`);
if (existsSync(dest)) {
  console.error(`designs/${name}.png 已存在,如需覆盖请先手动删除(避免误覆盖真实设计图)`);
  process.exit(1);
}

const buf = await capturePage(name, { width, height, dpr });
writeFileSync(dest, buf);
console.log(`✅ 已保存 designs/${name}.png(viewport ${width / dpr}×${height / dpr} @${dpr}x)`);
