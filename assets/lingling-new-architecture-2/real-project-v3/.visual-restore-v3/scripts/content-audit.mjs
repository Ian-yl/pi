// Compare visible frontend content with an explicit content manifest.
// Usage: node scripts/content-audit.mjs <name> [--dpr=2] [--json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFinding, summarizeFindings } from './lib/findings.mjs';
import { openAuditPage } from './lib/browser-target.mjs';
import { resolveRestoreConfig } from './lib/restore-config.mjs';

const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));

export function evaluateContentManifest(manifest, snapshots, { required = false, contentScope = 'critical' } = {}) {
  const findings = [];
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const bySelector = new Map(snapshots.map((snapshot) => [snapshot.selector, snapshot]));
  const results = [];

  if (!manifest) {
    if (required) {
      findings.push(makeFinding({
        detector: 'content-audit',
        code: 'manifest-missing',
        dimension: 'content',
        severity: 'P0',
        title: '缺少严格内容清单 content-manifest.json',
        target: { file: 'pages/<name>/content-manifest.json' },
        nextAction: '登记可读文字、不可辨认 mock 和二维码策略后重新运行 audit',
      }));
    }
    return { status: required ? 'fail' : 'skipped', entries: results, findings };
  }

  if (required && entries.length === 0) {
    findings.push(makeFinding({
      detector: 'content-audit',
      code: 'manifest-empty',
      dimension: 'content',
      severity: 'P0',
      title: '内容清单为空，不能验证页面文案是否一致',
      target: { file: 'pages/<name>/content-manifest.json' },
      nextAction: '从设计图登记所有可读文字；不可辨认内容显式登记为 mock',
    }));
  }

  if (required && contentScope === 'all-visible' && manifest.requireAllVisible !== true) {
    findings.push(makeFinding({
      detector: 'content-audit',
      code: 'all-visible-not-enabled',
      dimension: 'content',
      severity: 'P0',
      title: 'contentScope=all-visible 但 manifest 未启用 requireAllVisible',
      target: { file: 'pages/<name>/content-manifest.json' },
      nextAction: '设置 requireAllVisible=true 并登记审计发现的全部可见内容',
    }));
  }

  for (const [index, entry] of entries.entries()) {
    const id = entry.id || `content-${index + 1}`;
    const selector = String(entry.selector || '');
    const snapshot = bySelector.get(selector);
    const policy = entry.policy || 'exact';
    const expected = normalizeText(entry.expected ?? '');
    const actual = normalizeText(snapshot?.value ?? '');
    let pass = false;
    let reason = '';

    if (!selector) reason = 'manifest entry missing selector';
    else if (!snapshot) reason = 'target element not found or not visible';
    else if (policy === 'mock') pass = actual.length > 0;
    else if (policy === 'contains') pass = actual.includes(expected);
    else pass = actual === expected;

    if (!pass && !reason) reason = `${policy} content mismatch`;
    const result = { id, selector, policy, expected, actual, pass, reason, confidence: entry.confidence ?? null };
    results.push(result);
    if (!pass) {
      findings.push(makeFinding({
        detector: 'content-audit',
        code: snapshot ? 'content-mismatch' : 'content-target-missing',
        dimension: 'content',
        severity: snapshot ? 'P1' : 'P0',
        title: `${id}: ${reason}`,
        target: { elementId: id, selector },
        expected: { text: expected, policy },
        actual: { text: actual },
        confidence: entry.confidence,
        nextAction: policy === 'mock'
          ? '使用清晰且语义合理的 mock 文案，并保留 mock 声明'
          : '修正前端文案或更新经人工确认的内容清单',
      }));
    }
  }

  if (manifest.requireAllVisible || contentScope === 'all-visible') {
    const tracked = new Set(entries.map((entry) => entry.selector).filter(Boolean));
    for (const snapshot of snapshots) {
      if (!snapshot.value || tracked.has(snapshot.selector)) continue;
      findings.push(makeFinding({
        detector: 'content-audit',
        code: 'visible-content-untracked',
        dimension: 'content',
        severity: 'P2',
        title: `可见内容未登记: ${snapshot.value.slice(0, 40)}`,
        target: { selector: snapshot.selector },
        actual: { text: snapshot.value },
        nextAction: '将该内容登记为 exact、contains 或 mock',
      }));
    }
  }

  return { status: findings.length ? 'fail' : 'pass', entries: results, findings };
}

export function resolveVisibleContentValue({
  tagName = '',
  directText = '',
  controlValue = '',
  selectedText = '',
  placeholder = '',
  ariaLabel = '',
  alt = '',
} = {}) {
  const tag = String(tagName).toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    return firstNonEmpty(controlValue, placeholder, ariaLabel, alt);
  }
  if (tag === 'select') {
    return firstNonEmpty(selectedText, ariaLabel, alt);
  }
  return firstNonEmpty(directText, placeholder, ariaLabel, alt);
}

export async function collectContent(name, config) {
  const session = await openAuditPage(config);
  try {
    const page = session.page;
    const candidates = await page.evaluate(() => {
      const entries = [];
      for (const el of document.querySelectorAll('body *')) {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        if (rect.width < 1 || rect.height < 1) continue;
        const directText = [...el.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join(' ')
          .trim();
        const tagName = el.tagName.toLowerCase();
        const controlValue = tagName === 'input' || tagName === 'textarea' ? el.value : '';
        const selectedText = tagName === 'select'
          ? [...el.selectedOptions].map((option) => option.textContent).join(' ')
          : '';
        entries.push({
          selector: stableSelector(el),
          tagName,
          directText,
          controlValue,
          selectedText,
          placeholder: el.getAttribute('placeholder') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          alt: el.getAttribute('alt') || '',
        });
      }
      return entries;

      function stableSelector(el) {
        if (el.getAttribute('data-vr-id')) return `[data-vr-id="${el.getAttribute('data-vr-id')}"]`;
        if (el.id) return `#${el.id}`;
        const parts = [];
        let node = el;
        while (node && node !== document.body) {
          const tag = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (!parent) break;
          const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
          parts.unshift(`${tag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''}`);
          node = parent;
        }
        return `body>${parts.join('>')}`;
      }
    });
    return candidates
      .map(({ selector, ...candidate }) => ({ selector, value: resolveVisibleContentValue(candidate) }))
      .filter((snapshot) => snapshot.value);
  } finally {
    await session.close();
  }
}

function parseArgs(argv) {
  const args = { name: null, dpr: null, json: false };
  for (const item of argv) {
    if (item === '--json') args.json = true;
    else if (item.startsWith('--dpr=')) args.dpr = Number(item.slice(6));
    else if (!args.name) args.name = item;
    else throw new Error(`未知参数: ${item}`);
  }
  if (!args.name) throw new Error('用法: node scripts/content-audit.mjs <name> [--dpr=2] [--json]');
  return args;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = resolveRestoreConfig(args.name, { dpr: args.dpr });
  const manifestPath = join(ROOT, 'pages', args.name, 'content-manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const snapshots = await collectContent(args.name, config);
  const evaluated = evaluateContentManifest(manifest, snapshots, {
    required: config.policy.contentRequired,
    contentScope: config.policy.contentScope,
  });
  const result = {
    version: 1,
    name: args.name,
    generatedAt: new Date().toISOString(),
    manifest: manifest ? `pages/${args.name}/content-manifest.json` : null,
    required: config.policy.contentRequired,
    contentScope: config.policy.contentScope,
    manifestPresent: Boolean(manifest),
    requireAllVisible: Boolean(manifest?.requireAllVisible) || config.policy.contentScope === 'all-visible',
    snapshotCount: snapshots.length,
    status: evaluated.status,
    summary: summarizeFindings(evaluated.findings),
    entries: evaluated.entries,
    findings: evaluated.findings,
  };
  const outDir = join(ROOT, 'output', args.name);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'content-audit.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`内容审计: ${result.status}, manifest ${manifest ? 'present' : 'missing'}, findings ${result.summary.open}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(error.message); process.exit(1); });
