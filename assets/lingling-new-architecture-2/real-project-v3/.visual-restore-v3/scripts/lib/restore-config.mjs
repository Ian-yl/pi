import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConvergence } from './convergence.mjs';

export const PROJECT_ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../..'));

export const DEFAULT_MOBILE_PROFILES = Object.freeze([
  { id: 'compact-320x568', width: 320, height: 568 },
  { id: 'small-360x640', width: 360, height: 640 },
  { id: 'legacy-375x667', width: 375, height: 667 },
  { id: 'modern-390x844', width: 390, height: 844 },
  { id: 'wide-430x932', width: 430, height: 932 },
]);

export const DEFAULT_DESKTOP_PROFILES = Object.freeze([
  { id: 'compact-1024x768', width: 1024, height: 768 },
  { id: 'laptop-1280x720', width: 1280, height: 720 },
  { id: 'laptop-1366x768', width: 1366, height: 768 },
  { id: 'desktop-1440x900', width: 1440, height: 900 },
  { id: 'wide-1920x1080', width: 1920, height: 1080 },
]);

export const DEFAULT_RESPONSIVE_RULES = Object.freeze({
  maxHorizontalOverflow: 1,
  maxViewportDrift: 1,
  minTouchTarget: 44,
  minInlineTarget: 24,
  minInputFontSize: 16,
  requireSemanticControls: true,
  safeArea: 'auto',
});

// Desktop mode: pointer input, so touch-target and iOS zoom rules are disabled (0 = off).
export const DEFAULT_DESKTOP_RESPONSIVE_RULES = Object.freeze({
  maxHorizontalOverflow: 1,
  maxViewportDrift: 1,
  minTouchTarget: 0,
  minInlineTarget: 0,
  minInputFontSize: 0,
  requireSemanticControls: true,
  safeArea: 'off',
});

export function isMobileRestore({ platform = 'unknown', viewport = {} } = {}) {
  const platformName = String(platform || '').toLowerCase();
  if (/mobile|ios|android|pwa|webview/.test(platformName)) return true;
  const width = Number(viewport.width);
  const height = Number(viewport.height);
  return Number.isFinite(width) && Number.isFinite(height) && width <= 600 && height > width;
}

export function normalizeResponsiveProfiles(value, referenceViewport = {}, mode = 'mobile') {
  const requested = value === 'auto' || !Array.isArray(value)
    ? (mode === 'desktop' ? DEFAULT_DESKTOP_PROFILES : DEFAULT_MOBILE_PROFILES)
    : value;
  const profiles = [];
  const bySize = new Map();

  for (const [index, raw] of requested.entries()) {
    const width = positiveInteger(raw?.width);
    const height = positiveInteger(raw?.height);
    if (!width || !height) continue;
    const key = `${width}x${height}`;
    if (bySize.has(key)) continue;
    const profile = {
      id: normalizeProfileId(raw?.id || key, `profile-${index + 1}`),
      width,
      height,
      reference: false,
    };
    bySize.set(key, profile);
    profiles.push(profile);
  }

  const referenceWidth = positiveInteger(referenceViewport.width);
  const referenceHeight = positiveInteger(referenceViewport.height);
  if (referenceWidth && referenceHeight) {
    const key = `${referenceWidth}x${referenceHeight}`;
    const existing = bySize.get(key);
    if (existing) {
      existing.reference = true;
    } else {
      profiles.push({
        id: `reference-${key}`,
        width: referenceWidth,
        height: referenceHeight,
        reference: true,
      });
    }
  }

  return profiles;
}

export function normalizeResponsiveAudit(value, context = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const inferred = isMobileRestore(context);
  const mode = input.mode === 'desktop' || input.mode === 'mobile'
    ? input.mode
    : (inferred ? 'mobile' : 'desktop');
  const enabled = value === false ? false : Boolean(input.enabled ?? inferred);
  if (!enabled) {
    return {
      enabled: false,
      mode,
      profiles: [],
      rules: normalizeResponsiveRules(input.rules, mode),
    };
  }

  return {
    enabled: true,
    mode,
    profiles: normalizeResponsiveProfiles(input.profiles ?? 'auto', context.viewport, mode),
    rules: normalizeResponsiveRules(input.rules, mode),
  };
}

export function readRestorePlan(name, { root = PROJECT_ROOT } = {}) {
  const path = join(root, 'pages', name, 'restore-plan.json');
  if (!existsSync(path)) return { path, plan: null };
  return { path, plan: JSON.parse(readFileSync(path, 'utf8')) };
}

export function resolveRestoreConfig(name, overrides = {}) {
  if (!name) throw new Error('restore name is required');
  const root = resolve(overrides.root || PROJECT_ROOT);
  const { path: planPath, plan } = readRestorePlan(name, { root });
  const sourcePath = locateDesignPath(name, {
    root,
    source: overrides.source || plan?.source,
  });
  const source = relative(root, sourcePath);
  const target = plan?.quality?.target || inferTarget(sourcePath);
  const thresholds = plan?.quality?.thresholds || {};
  const dpr = finite(overrides.dpr, plan?.viewport?.dpr, 1);
  const fullSimilarity = finite(
    overrides.minScore,
    thresholds.fullSimilarity,
    target === 'png' ? thresholds.pngSimilarity : thresholds.jpegSimilarity,
    target === 'png' ? 97 : 95,
  );
  const foregroundSimilarity = finite(
    overrides.minForeground,
    thresholds.foregroundSimilarity,
    85,
  );
  const minRegionSimilarity = finite(
    overrides.minRegion,
    thresholds.minRegionSimilarity,
    Math.max(0, fullSimilarity - 2),
  );
  const v3Plan = Number(plan?.version) >= 3;
  const platform = plan?.platform || 'unknown';
  const viewport = {
    width: finite(plan?.viewport?.width, null),
    height: finite(plan?.viewport?.height, null),
    dpr,
  };
  const responsive = normalizeResponsiveAudit(plan?.responsiveAudit, { platform, viewport });

  return {
    version: plan?.version || 3,
    name,
    root,
    planPath,
    plan,
    source,
    sourcePath,
    target,
    platform,
    viewport,
    responsive,
    capture: {
      adapter: plan?.capture?.adapter || 'static',
      path: plan?.capture?.path || `pages/${name}/index.html`,
      url: plan?.capture?.url || `/pages/${name}/index.html`,
      startCommand: plan?.capture?.startCommand || '',
      readyUrl: plan?.capture?.readyUrl || '',
      cwd: plan?.capture?.cwd || '.',
      fullPage: plan?.capture?.fullPage !== false,
      timeoutMs: finite(plan?.capture?.timeoutMs, 45_000),
      watch: normalizeStringList(plan?.capture?.watch),
    },
    quality: {
      target,
      threshold: finite(overrides.threshold, thresholds.pixelmatchThreshold, 0.1),
      fullSimilarity,
      foregroundSimilarity,
      minRegionSimilarity,
      maxStructureDx: finite(thresholds.maxStructureDx, 2),
      maxStructureDy: finite(thresholds.maxStructureDy, 1.5),
      maxColorDeltaE: finite(thresholds.maxColorDeltaE, 3),
      maxFontDiff: finite(thresholds.maxFontDiff, 1.2),
      maxRegression: finite(thresholds.maxRegression, 0.2),
    },
    convergence: normalizeConvergence(plan?.convergence),
    regions: normalizeRegions(plan?.regions || []),
    policy: {
      contentRequired: Boolean(plan?.auditPolicy?.contentRequired ?? plan?.quality?.contentRequired ?? v3Plan),
      contentScope: plan?.auditPolicy?.contentScope || (v3Plan ? 'all-visible' : 'critical'),
      assetRequired: Boolean(plan?.auditPolicy?.assetRequired ?? plan?.quality?.assetRequired ?? false),
      responsiveRequired: Boolean(plan?.auditPolicy?.responsiveRequired ?? responsive.enabled),
      strictSkipped: Boolean(plan?.auditPolicy?.strictSkipped ?? false),
    },
    artifacts: plan?.artifacts || { required: [], optional: [] },
  };
}

function normalizeResponsiveRules(value = {}, mode = 'mobile') {
  const base = mode === 'desktop' ? DEFAULT_DESKTOP_RESPONSIVE_RULES : DEFAULT_RESPONSIVE_RULES;
  const safeArea = ['auto', 'required', 'off'].includes(value?.safeArea) ? value.safeArea : base.safeArea;
  return {
    maxHorizontalOverflow: finite(value?.maxHorizontalOverflow, base.maxHorizontalOverflow),
    maxViewportDrift: finite(value?.maxViewportDrift, base.maxViewportDrift),
    minTouchTarget: finite(value?.minTouchTarget, base.minTouchTarget),
    minInlineTarget: finite(value?.minInlineTarget, base.minInlineTarget),
    minInputFontSize: finite(value?.minInputFontSize, base.minInputFontSize),
    requireSemanticControls: Boolean(value?.requireSemanticControls ?? base.requireSemanticControls),
    safeArea,
  };
}

function normalizeProfileId(value, fallback) {
  const id = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || fallback;
}

function positiveInteger(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function locateDesignPath(name, { root = PROJECT_ROOT, source = null } = {}) {
  const candidates = [];
  if (source) candidates.push(resolve(root, source));
  for (const extension of ['png', 'jpg', 'jpeg', 'webp']) {
    candidates.push(join(root, 'designs', `${name}.${extension}`));
  }
  const hit = [...new Set(candidates)].find((candidate) => existsSync(candidate));
  if (!hit) throw new Error(`找不到设计图: ${source || `designs/${name}.{png,jpg,jpeg,webp}`}`);
  return hit;
}

export function normalizeRegions(regions) {
  if (!Array.isArray(regions)) return [];
  return regions
    .map((region, index) => ({
      name: String(region.name || region.id || `Region-${index + 1}`),
      x: Number(region.x ?? region.rect?.x ?? region.rect?.[0]),
      y: Number(region.y ?? region.rect?.y ?? region.rect?.[1]),
      width: Number(region.width ?? region.w ?? region.rect?.width ?? region.rect?.w ?? region.rect?.[2]),
      height: Number(region.height ?? region.h ?? region.rect?.height ?? region.rect?.h ?? region.rect?.[3]),
      required: region.required !== false,
      minSimilarity: Number.isFinite(Number(region.minSimilarity)) ? Number(region.minSimilarity) : null,
    }))
    .filter((region) => [region.x, region.y, region.width, region.height].every(Number.isFinite));
}

function inferTarget(sourcePath) {
  return extname(sourcePath).toLowerCase() === '.png' ? 'png' : 'jpeg-or-screenshot';
}

function normalizeStringList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function finite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}
