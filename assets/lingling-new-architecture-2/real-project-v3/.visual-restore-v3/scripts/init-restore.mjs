// Initialize a V3 visual restoration plan for a new design.
// Usage:
//   node scripts/init-restore.mjs <name> [--source=designs/<name>.png] [--dpr=1] [--platform=web-desktop] [--force]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import { readRasterSize } from './lib/raster-image.mjs';
import { DEFAULT_CONVERGENCE } from './lib/convergence.mjs';
import { DEFAULT_DESKTOP_RESPONSIVE_RULES, DEFAULT_RESPONSIVE_RULES, isMobileRestore } from './lib/restore-config.mjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));

export function buildDefaultRestorePlan({ name, source, width, height, dpr = 1, platform = 'unknown' }) {
  const cssWidth = Math.max(1, Math.round(width / dpr));
  const cssHeight = Math.max(1, Math.round(height / dpr));
  const isPng = String(source || '').toLowerCase().endsWith('.png');
  const viewport = { width: cssWidth, height: cssHeight, dpr };
  const mobile = isMobileRestore({ platform, viewport });
  const desktop = !mobile && /desktop/i.test(String(platform || ''));
  const responsiveEnabled = mobile || desktop;
  const requiredArtifacts = [
    `output/${name}/design.png`,
    `output/${name}/actual.png`,
    `output/${name}/diff.png`,
    `output/${name}/delta.png`,
    `output/${name}/foreground-score.json`,
    `output/${name}/diff-components.json`,
    `output/${name}/region-score.json`,
    `output/${name}/structure-audit.json`,
    `output/${name}/visual-inventory.json`,
    `output/${name}/color-audit.json`,
    `output/${name}/font-audit.json`,
    `output/${name}/full-audit.json`,
    `output/${name}/content-audit.json`,
    `output/${name}/findings.json`,
    `output/${name}/audit-ledger.json`,
    `output/${name}/run-manifest.json`,
  ];
  if (responsiveEnabled) requiredArtifacts.push(`output/${name}/responsive-audit.json`);

  return {
    version: 3,
    schemaVersion: '3.2',
    name,
    source,
    platform,
    viewport,
    responsiveAudit: {
      enabled: responsiveEnabled,
      mode: mobile ? 'mobile' : 'desktop',
      profiles: 'auto',
      rules: mobile ? { ...DEFAULT_RESPONSIVE_RULES } : { ...DEFAULT_DESKTOP_RESPONSIVE_RULES },
    },
    capture: {
      adapter: 'static',
      path: `pages/${name}/index.html`,
      url: `/pages/${name}/index.html`,
      fullPage: true,
      timeoutMs: 45000,
      watch: [],
    },
    quality: {
      target: isPng ? 'png' : 'jpeg-or-screenshot',
      thresholds: {
        pngSimilarity: 97,
        jpegSimilarity: 95,
        fullSimilarity: isPng ? 97 : 95,
        foregroundSimilarity: 85,
        minRegionSimilarity: isPng ? 95 : 93,
        maxStructureDx: 2,
        maxStructureDy: 1.5,
        maxColorDeltaE: 3,
        maxFontDiff: 1.2,
        maxRegression: 0.2,
      },
    },
    convergence: { ...DEFAULT_CONVERGENCE },
    regions: [],
    auditPolicy: {
      scope: 'all-visible-elements',
      dimensions: [
        'geometry',
        'typography',
        'textColor',
        'backgroundColor',
        'border',
        'radius',
        'shadow',
        'opacity',
        'asset',
        'content',
        'responsive',
        'interaction',
        'semantics',
      ],
      silentOmission: false,
      skippedRequiresReason: true,
      lowClarityTextRule: 'render-clear-text-or-semantic-mock-no-blur',
      assetRule: 'mask-first-clean-assets-no-ui-ghosts',
      contentRequired: true,
      contentScope: 'all-visible',
      assetRequired: false,
      responsiveRequired: responsiveEnabled,
      strictSkipped: false,
    },
    artifacts: {
      required: requiredArtifacts,
      optional: [
        `pages/${name}/asset-plan.json`,
        `output/${name}/assets/asset-report.json`,
        `output/${name}/assets/edge-audit.json`,
      ],
    },
    notes: [
      'Every visible DOM element must appear in visual-inventory.json.',
      'Every audit dimension must be measured, pending, failed, or skipped with a reason.',
      'Blur in the input screenshot is not a frontend blur requirement.',
      'Mobile plans compare pixels only at the reference viewport and audit invariant robustness elsewhere.',
      'Desktop plans must render a fluid application shell: the reference viewport is a comparison baseline, not a fixed production canvas.',
    ],
  };
}

export function parseInitArgs(argv) {
  const args = {
    name: null,
    source: null,
    dpr: 1,
    platform: 'unknown',
    force: false,
  };

  for (const item of argv) {
    if (item === '--force') args.force = true;
    else if (item.startsWith('--source=')) args.source = item.slice('--source='.length);
    else if (item.startsWith('--dpr=')) args.dpr = Number(item.slice('--dpr='.length));
    else if (item.startsWith('--platform=')) args.platform = item.slice('--platform='.length);
    else if (!args.name) args.name = item;
    else throw new Error(`未知参数: ${item}`);
  }

  if (!args.name) throw new Error('用法: node scripts/init-restore.mjs <name> [--source=...] [--dpr=1] [--platform=...] [--force]');
  if (!Number.isFinite(args.dpr) || args.dpr <= 0) throw new Error('--dpr 必须是正数');
  return args;
}

export function locateDesignSource(name, explicitSource = null) {
  const candidates = explicitSource
    ? [resolve(ROOT, explicitSource)]
    : ['png', 'jpg', 'jpeg', 'webp'].map((ext) => join(ROOT, 'designs', `${name}.${ext}`));
  const hit = candidates.find((candidate) => existsSync(candidate));
  if (!hit) throw new Error(`找不到设计图: ${explicitSource || `designs/${name}.{png,jpg,jpeg,webp}`}`);
  return hit;
}

export async function readImageSize(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.png') {
    const img = PNG.sync.read(readFileSync(file));
    return { width: img.width, height: img.height };
  }

  return readRasterSize(file);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseInitArgs(argv);
  const sourcePath = locateDesignSource(args.name, args.source);
  const size = await readImageSize(sourcePath);
  const source = relativeToRoot(sourcePath);
  const plan = buildDefaultRestorePlan({
    name: args.name,
    source,
    width: size.width,
    height: size.height,
    dpr: args.dpr,
    platform: args.platform,
  });

  const pageDir = join(ROOT, 'pages', args.name);
  mkdirSync(pageDir, { recursive: true });
  const planPath = join(pageDir, 'restore-plan.json');
  if (existsSync(planPath) && !args.force) {
    throw new Error(`已存在 ${relativeToRoot(planPath)};如需覆盖请加 --force`);
  }
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`V3 还原计划已生成: ${relativeToRoot(planPath)}`);
  console.log(`画布 ${size.width}×${size.height} @${args.dpr}x → viewport ${plan.viewport.width}×${plan.viewport.height}`);
}

function relativeToRoot(file) {
  return file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
