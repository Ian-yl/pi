// 分区相似度:按区域分别计算 pixelmatch mismatch,避免全图分数掩盖局部问题。
// 用法:
//   node scripts/region-score.mjs <name> [--regions="Header:x,y,w,h; Form:x,y,w,h"] [--threshold=0.1] [--json]

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import {
  defaultRegionsFor,
  diffCountsByRegion,
  parseRegions,
  regionScores,
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
  console.error('用法: node scripts/region-score.mjs <name> [--regions="Header:x,y,w,h; ..."] [--json]');
  process.exit(1);
}

const design = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'design.png')));
const actual = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'actual.png')));
const diff = PNG.sync.read(readFileSync(join(ROOT, 'output', name, 'diff.png')));
const cliThreshold = Number(opt('threshold', NaN));
const config = resolveRestoreConfig(name, { threshold: cliThreshold, root: ROOT });
const threshold = config.quality.threshold;
const json = args.includes('--json');
const regions = opt('regions')
  ? parseRegions(opt('regions'))
  : config.regions.length
    ? config.regions
    : defaultRegionsFor(Math.max(design.width, actual.width), Math.max(design.height, actual.height));

const scores = regionScores(design, actual, regions, { threshold });
const attribution = diffCountsByRegion(diff, regions);
const enriched = scores.map((score) => ({
  ...score,
  required: regions.find((region) => region.name === score.name)?.required !== false,
  minSimilarity: regions.find((region) => region.name === score.name)?.minSimilarity ?? config.quality.minRegionSimilarity,
  diffPixelsFromReport: attribution.counts[score.name] || 0,
  shareOfTotalDiff: attribution.total
    ? Number((((attribution.counts[score.name] || 0) / attribution.total) * 100).toFixed(2))
    : 0,
}));

writeFileSync(join(ROOT, 'output', name, 'region-score.json'), `${JSON.stringify(enriched, null, 2)}\n`);

if (json) {
  console.log(JSON.stringify(enriched, null, 2));
} else {
  console.log(`分区相似度(已写 output/${name}/region-score.json)\n`);
  for (const score of [...enriched].sort((a, b) => a.similarity - b.similarity)) {
    console.log(
      `${score.similarity.toFixed(2).padStart(6)}%  ` +
        `${String(score.mismatch).padStart(7)} / ${String(score.pixels).padEnd(8)} px  ` +
        `${String(score.shareOfTotalDiff.toFixed(1)).padStart(5)}% diff  ` +
        `${score.name}`,
    );
  }
}
