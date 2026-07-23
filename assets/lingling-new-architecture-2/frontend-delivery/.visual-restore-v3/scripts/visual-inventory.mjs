// Full visual inventory for V3 restoration audits.
// Usage:
//   node scripts/visual-inventory.mjs <name> [--dpr=1] [--json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import { openAuditPage } from './lib/browser-target.mjs';
import { resolveRestoreConfig } from './lib/restore-config.mjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
export const DIMENSIONS = [
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
];

export function classifyElementKind(element) {
  const tag = String(element.tag || '').toLowerCase();
  const role = String(element.role || '').toLowerCase();
  const cls = String(element.className || element.selector || '').toLowerCase();
  const text = String(element.text || element.ariaLabel || element.placeholder || '').trim();
  const rect = element.rect || {};
  const css = element.css || {};
  const hasFileBackground = /\burl\(/i.test(String(css.backgroundImage || ''));

  if (['input', 'textarea', 'select'].includes(tag)) return 'input';
  if (tag === 'button' || role === 'button' || /\b(btn|button|cta)\b/.test(cls)) return 'button';
  if (['img', 'picture', 'video', 'canvas'].includes(tag)) return 'image';
  if (tag === 'svg' || role === 'img' && (rect.width || 0) <= 96 && (rect.height || 0) <= 96) return 'icon';
  if ((rect.width <= 2 && rect.height >= 8) || (rect.height <= 2 && rect.width >= 8)) return 'line';
  if (/\b(card|panel|sheet|modal|tile|stat|item|box)\b/.test(cls)) return 'card';
  if (hasFileBackground && !text) return 'image';
  if (text) return 'text';
  return 'container';
}

export function buildDimensionsForElement(element) {
  const kind = element.kind || classifyElementKind(element);
  const css = element.css || {};
  const text = String(element.text || element.placeholder || element.ariaLabel || element.attrs?.alt || '').trim();
  const hasText = Boolean(text);
  const hasBg = hasVisibleBackground(css);
  const hasBorder = Number(css.borderTopWidth || 0) > 0 ||
    Number(css.borderRightWidth || 0) > 0 ||
    Number(css.borderBottomWidth || 0) > 0 ||
    Number(css.borderLeftWidth || 0) > 0;
  const hasRadius = parseCssNumber(css.borderTopLeftRadius) > 0 ||
    parseCssNumber(css.borderTopRightRadius) > 0 ||
    parseCssNumber(css.borderBottomRightRadius) > 0 ||
    parseCssNumber(css.borderBottomLeftRadius) > 0;
  const hasShadow = css.boxShadow && css.boxShadow !== 'none';
  const hasOpacity = Number(css.opacity ?? 1) < 1 ||
    (css.filter && css.filter !== 'none') ||
    (css.backdropFilter && css.backdropFilter !== 'none');
  const hasAsset = ['img', 'picture', 'video', 'canvas', 'svg'].includes(String(element.tag || '').toLowerCase()) ||
    /\burl\(/i.test(String(css.backgroundImage || ''));

  return {
    geometry: pending('visible element bbox captured'),
    typography: hasText || ['input', 'button'].includes(kind)
      ? pending('text-bearing element')
      : skipped('no text-bearing style'),
    textColor: hasText || ['input', 'button'].includes(kind)
      ? pending('text color must be checked against design sample')
      : skipped('no text content'),
    backgroundColor: hasBg
      ? pending('visible fill/background must be checked')
      : skipped('no visible background fill'),
    border: hasBorder
      ? pending('visible border must be checked')
      : skipped('no declared border'),
    radius: hasRadius
      ? pending('corner radius must be checked')
      : skipped('no declared radius'),
    shadow: hasShadow
      ? pending('shadow must be checked')
      : skipped('no declared shadow'),
    opacity: hasOpacity
      ? pending('opacity/filter/backdrop must be checked')
      : skipped('fully opaque/no filter'),
    asset: hasAsset
      ? pending('image/svg/background asset must pass asset audit')
      : skipped('not an asset element'),
    content: hasText
      ? pending('visible content must match or be documented as mock')
      : skipped(hasAsset ? 'decorative visual has no text/ARIA/alt content' : 'no visible semantic content'),
  };
}

export function summarizeInventoryCoverage(items, { maxUnresolvedItems = Infinity } = {}) {
  const summary = {
    total: items.length,
    byKind: {},
    dimensions: {},
    unresolved: {
      count: 0,
      items: [],
    },
  };

  for (const dimension of DIMENSIONS) {
    summary.dimensions[dimension] = {
      pass: 0,
      fail: 0,
      pending: 0,
      skipped: 0,
      missing: 0,
    };
  }

  for (const item of items) {
    summary.byKind[item.kind] = (summary.byKind[item.kind] || 0) + 1;
    for (const dimension of DIMENSIONS) {
      const status = item.dimensions?.[dimension]?.status || 'missing';
      if (!summary.dimensions[dimension][status] && summary.dimensions[dimension][status] !== 0) {
        summary.dimensions[dimension][status] = 0;
      }
      summary.dimensions[dimension][status]++;
      if (status === 'pending' || status === 'fail' || status === 'missing') {
        summary.unresolved.count++;
        if (summary.unresolved.items.length < maxUnresolvedItems) {
          summary.unresolved.items.push({
            id: item.id,
            kind: item.kind,
            selector: item.selector,
            text: item.text,
            dimension,
            status,
            reason: item.dimensions?.[dimension]?.reason || '',
            findingId: item.dimensions?.[dimension]?.findingId || '',
          });
        }
      }
    }
  }

  return summary;
}

export function makeStableId(item, index) {
  const key = [
    item.kind,
    item.auditId || item.attrs?.dataVrId || item.domPath || item.selector,
    item.text || item.ariaLabel || item.placeholder || '',
  ].join('|');
  const prefix = item.auditId || item.attrs?.dataVrId || `${item.kind}-${String(index + 1).padStart(3, '0')}`;
  return `${sanitizeId(prefix)}-${hashString(key)}`;
}

export async function collectVisualInventory(name, { dpr = null, config = null } = {}) {
  const targetConfig = config || resolveRestoreConfig(name, { root: ROOT, dpr });
  const resolvedDpr = targetConfig.viewport.dpr;
  const outDir = join(ROOT, 'output', name);
  const designPath = join(outDir, 'design.png');
  const actualPath = join(outDir, 'actual.png');
  if (!existsSync(designPath) || !existsSync(actualPath)) {
    throw new Error(`缺少 output/${name}/design.png 或 actual.png,请先运行 npm run verify ${name}`);
  }

  const design = PNG.sync.read(readFileSync(designPath));
  const session = await openAuditPage(targetConfig, {
    imageWidth: design.width,
    imageHeight: design.height,
  });
  try {
    const page = session.page;

    const rawItems = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        if (rect.right < 0 || rect.bottom < 0 || rect.left > innerWidth || rect.top > innerHeight) continue;

        const directText = [...el.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent.trim())
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        const before = pseudoSnapshot(el, '::before');
        const after = pseudoSnapshot(el, '::after');

        out.push({
          selector: selectorName(el),
          domPath: domPath(el),
          auditId: el.getAttribute('data-vr-id') || '',
          tag: el.tagName.toLowerCase(),
          idAttr: el.id || '',
          className: typeof el.className === 'string' ? el.className : '',
          role: el.getAttribute('role') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          placeholder: el.getAttribute('placeholder') || '',
          text: directText.slice(0, 120),
          rect: {
            x: round(rect.left),
            y: round(rect.top),
            width: round(rect.width),
            height: round(rect.height),
          },
          css: {
            display: cs.display,
            position: cs.position,
            zIndex: cs.zIndex,
            opacity: cs.opacity,
            fontFamily: cs.fontFamily,
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
            lineHeight: cs.lineHeight,
            letterSpacing: cs.letterSpacing,
            color: cs.color,
            backgroundColor: cs.backgroundColor,
            backgroundImage: cs.backgroundImage,
            borderTopWidth: parseFloat(cs.borderTopWidth) || 0,
            borderRightWidth: parseFloat(cs.borderRightWidth) || 0,
            borderBottomWidth: parseFloat(cs.borderBottomWidth) || 0,
            borderLeftWidth: parseFloat(cs.borderLeftWidth) || 0,
            borderTopColor: cs.borderTopColor,
            borderRightColor: cs.borderRightColor,
            borderBottomColor: cs.borderBottomColor,
            borderLeftColor: cs.borderLeftColor,
            borderTopLeftRadius: cs.borderTopLeftRadius,
            borderTopRightRadius: cs.borderTopRightRadius,
            borderBottomRightRadius: cs.borderBottomRightRadius,
            borderBottomLeftRadius: cs.borderBottomLeftRadius,
            boxShadow: cs.boxShadow,
            filter: cs.filter,
            backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
            overflow: cs.overflow,
          },
          attrs: {
            src: el.getAttribute('src') || '',
            alt: el.getAttribute('alt') || '',
            href: el.getAttribute('href') || '',
            viewBox: el.getAttribute('viewBox') || '',
            dataVrId: el.getAttribute('data-vr-id') || '',
          },
          pseudo: { before, after },
          childrenCount: el.children.length,
        });
      }
      return out;

      function selectorName(el) {
        if (el.getAttribute('data-vr-id')) return `[data-vr-id="${el.getAttribute('data-vr-id')}"]`;
        if (el.id) return `#${el.id}`;
        const cls = typeof el.className === 'string'
          ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3)
          : [];
        const base = el.tagName.toLowerCase() + (cls.length ? `.${cls.join('.')}` : '');
        const parent = el.parentElement;
        if (!parent) return base;
        const siblings = [...parent.children].filter((node) => node.tagName === el.tagName);
        if (siblings.length <= 1) return base;
        return `${base}:nth-of-type(${siblings.indexOf(el) + 1})`;
      }

      function domPath(el) {
        const parts = [];
        let node = el;
        while (node && node !== document.body) {
          if (node.getAttribute?.('data-vr-id')) {
            parts.unshift(`[data-vr-id="${node.getAttribute('data-vr-id')}"]`);
            break;
          }
          if (node.id) {
            parts.unshift(`#${node.id}`);
            break;
          }
          const tag = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
          const suffix = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(node) + 1})` : '';
          parts.unshift(`${tag}${suffix}`);
          node = parent;
        }
        return `body>${parts.join('>')}`;
      }

      function pseudoSnapshot(el, pseudo) {
        const ps = getComputedStyle(el, pseudo);
        const content = ps.content;
        const width = parseFloat(ps.width) || 0;
        const height = parseFloat(ps.height) || 0;
        const visible = ps.display !== 'none' &&
          content !== 'none' &&
          content !== 'normal' &&
          (width > 0 || height > 0 || (content && content !== '""'));
        return visible
          ? {
            content,
            display: ps.display,
            width: round(width),
            height: round(height),
            backgroundColor: ps.backgroundColor,
            color: ps.color,
          }
          : null;
      }

      function round(value) {
        return Math.round(value * 100) / 100;
      }
    });

    return rawItems.map((raw, index) => {
      const kind = classifyElementKind(raw);
      const item = {
        id: '',
        kind,
        ...raw,
        rectPx: {
          x: Math.round(raw.rect.x * resolvedDpr),
          y: Math.round(raw.rect.y * resolvedDpr),
          width: Math.round(raw.rect.width * resolvedDpr),
          height: Math.round(raw.rect.height * resolvedDpr),
        },
      };
      item.dimensions = buildDimensionsForElement(item);
      item.id = makeStableId(item, index);
      return item;
    });
  } finally {
    await session.close();
  }
}

function parseArgs(argv) {
  const args = { name: null, dpr: null, json: false };
  for (const item of argv) {
    if (item === '--json') args.json = true;
    else if (item.startsWith('--dpr=')) args.dpr = Number(item.slice('--dpr='.length));
    else if (!args.name) args.name = item;
    else throw new Error(`未知参数: ${item}`);
  }
  if (!args.name) throw new Error('用法: node scripts/visual-inventory.mjs <name> [--dpr=1] [--json]');
  if (args.dpr !== null && (!Number.isFinite(args.dpr) || args.dpr <= 0)) throw new Error('--dpr 必须是正数');
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = resolveRestoreConfig(args.name, { root: ROOT, dpr: args.dpr });
  const dpr = config.viewport.dpr;
  const items = await collectVisualInventory(args.name, { config });
  const summary = summarizeInventoryCoverage(items);
  const result = {
    version: 3,
    name: args.name,
    generatedAt: new Date().toISOString(),
    dpr,
    summary,
    items,
  };

  const outDir = join(ROOT, 'output', args.name);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'visual-inventory.json'), `${JSON.stringify(result, null, 2)}\n`);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`视觉盘点: ${summary.total} 个可见元素, 已写 output/${args.name}/visual-inventory.json`);
    console.log(`类型: ${Object.entries(summary.byKind).map(([kind, count]) => `${kind}×${count}`).join(', ')}`);
    console.log(`未闭环维度: ${summary.unresolved.count} 项(pending/fail/missing; skipped 均含原因)`);
  }
}

function pending(reason) {
  return { status: 'pending', reason };
}

function skipped(reason) {
  return { status: 'skipped', reason };
}

function hasVisibleBackground(css) {
  if (css.backgroundImage && css.backgroundImage !== 'none') return true;
  const bg = css.backgroundColor || '';
  if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return false;
  const alpha = bg.match(/rgba?\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)?.[1];
  return alpha === undefined || Number(alpha) > 0;
}

function parseCssNumber(value) {
  const n = parseFloat(String(value || '0'));
  return Number.isFinite(n) ? n : 0;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

function sanitizeId(value) {
  return String(value || 'element')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'element';
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
