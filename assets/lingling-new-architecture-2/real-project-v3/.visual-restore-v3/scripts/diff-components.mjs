// 自动提取 diff.png 中的红色差异连通块,按面积排序输出。
// 用法:
//   node scripts/diff-components.mjs <name> [--min=30] [--top=30] [--regions="Header:x,y,w,h; ..."] [--json]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import {
  componentRegion,
  connectedDiffComponents,
  defaultRegionsFor,
  parseRegions,
} from './lib/image-metrics.mjs';
import { resolveRestoreConfig } from './lib/restore-config.mjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
const name = args.find((arg) => !arg.startsWith('--'));

const opt = (key, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : fallback;
};

if (!name) {
  console.error('用法: node scripts/diff-components.mjs <name> [--min=30] [--top=30] [--json]');
  process.exit(1);
}

const diff = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'diff.png')));
const minPixels = Number(opt('min', 30));
const topN = Number(opt('top', 30));
const json = args.includes('--json');
const config = resolveRestoreConfig(name, { root: ROOT });
const regions = opt('regions')
  ? parseRegions(opt('regions'))
  : config.regions.length
    ? config.regions
    : defaultRegionsFor(diff.width, diff.height);

const components = connectedDiffComponents(diff, { minPixels })
  .map((component) => ({
    ...component,
    region: componentRegion(component, regions),
  }));

writeFileSync(join(ROOT, 'output', name, 'diff-components.json'), `${JSON.stringify(components, null, 2)}\n`);

if (json) {
  console.log(JSON.stringify(components.slice(0, topN), null, 2));
} else {
  console.log(`差异连通块: ${components.length} 个(min=${minPixels}px), 已写 output/${name}/diff-components.json\n`);
  for (const component of components.slice(0, topN)) {
    console.log(
      `${String(component.count).padStart(6)} px  ` +
        `${component.region.padEnd(8)}  ` +
        `x=${component.x}, y=${component.y}, w=${component.width}, h=${component.height}`,
    );
  }
}
