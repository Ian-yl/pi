#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const pages = {
  'pg-1r': { route: '/', selector: '.hero-title', expected: '让商品视觉，随场景一键生长' },
  'pg-1s': { route: '/photoreal-product', selector: '.config-head h2', expected: '商品套图' },
  'pg-1t': { route: '/try-on', selector: '.config-head h2', expected: '万物上身' },
  'pg-1u': { route: '/marketing-scene', selector: '.config-head h2', expected: '高转化主图' },
  'pg-1v': { route: '/commerce-assets', selector: '.config-head h2', expected: '参数板块' }
};

for (const [pageId, page] of Object.entries(pages)) {
  const planPath = `pages/${pageId}/restore-plan.json`;
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  plan.capture = {
    adapter: 'external',
    url: `http://127.0.0.1:4917${page.route}`,
    readyUrl: 'http://127.0.0.1:4917/',
    startCommand: 'npm --prefix web run dev -- --host 127.0.0.1 --port 4917',
    cwd: '.',
    watch: ['web/src', 'web/index.html'],
    fullPage: false,
    timeoutMs: 60000
  };
  plan.regions = [{ name: 'Viewport', x: 0, y: 0, width: 1536, height: 1024, required: true, minSimilarity: 70 }];
  plan.quality.thresholds.fullSimilarity = 70;
  plan.quality.thresholds.pngSimilarity = 70;
  plan.quality.thresholds.foregroundSimilarity = 65;
  plan.quality.thresholds.minRegionSimilarity = 70;
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(`pages/${pageId}/content-manifest.json`, `${JSON.stringify({
    version: 1,
    requireAllVisible: false,
    entries: [{ id: `${pageId}-primary-title`, selector: page.selector, expected: page.expected, policy: 'exact', confidence: 1 }]
  }, null, 2)}\n`);
}

console.log(`Configured ${Object.keys(pages).length} external React audits.`);
