// 素材切图:从 output/<name>/design.png 裁出矩形,保存为 pages/<name>/assets/ 下的独立素材文件。
// 用法: node scripts/cut.mjs <name> "file.png:x,y,w,h; file2.png:x,y,w,h"
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const [name, specStr] = process.argv.slice(2);
if (!name || !specStr) {
  console.error('用法: node scripts/cut.mjs <name> "file.png:x,y,w,h; ..."');
  process.exit(1);
}

const src = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'design.png')));
const outDir = join(ROOT, 'pages', name, 'assets');
mkdirSync(outDir, { recursive: true });

for (const item of specStr.split(';')) {
  const s = item.trim();
  if (!s) continue;
  const [file, nums] = s.split(':');
  const [x, y, w, h] = nums.split(',').map(Number);
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(src, out, x, y, w, h, 0, 0);
  writeFileSync(join(outDir, file.trim()), PNG.sync.write(out));
  console.log(`✂ ${file.trim()}  ${w}×${h} @(${x},${y})`);
}
