// Build the V3 remediation queue from audit outputs.
// Usage:
//   node scripts/audit-queue.mjs <name> [--top=120] [--json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));

const PRIORITY_ORDER = new Map([
  ['P0', 0],
  ['P1', 1],
  ['P2', 2],
  ['P3', 3],
]);

export function priorityForQueueItem(item) {
  if (['P0', 'P1', 'P2', 'P3'].includes(item.severity)) return item.severity;
  if (item.status === 'missing' || item.type === 'missing-artifact' || item.type === 'failed-command') return 'P0';
  if (item.type === 'asset-edge' && item.severity === 'high') return 'P0';
  if (item.type === 'asset-edge') return 'P1';
  if (item.dimension === 'asset' || item.dimension === 'content') return 'P1';
  if (['geometry', 'typography', 'textColor', 'backgroundColor', 'border'].includes(item.dimension)) return 'P2';
  return 'P3';
}

export function buildRemediationQueue({
  name,
  ledger = null,
  inventory = null,
  edgeAudit = null,
  findings = null,
  top = Infinity,
} = {}) {
  const items = [];

  const activeFindingIds = new Set();
  for (const finding of findings?.findings || []) {
    if (!['open', 'regressed', 'blocked'].includes(finding.status)) continue;
    activeFindingIds.add(finding.id);
    items.push(withPriority({
      type: 'finding',
      source: finding.detector,
      findingId: finding.id,
      title: finding.title,
      severity: finding.severity,
      status: finding.status,
      dimension: finding.dimension,
      selector: finding.target?.selector || '',
      region: finding.target?.region || '',
      file: finding.target?.file || '',
      target: finding.target || {},
      expected: finding.expected,
      actual: finding.actual,
      evidence: finding.evidence,
      confidence: finding.confidence,
      nextAction: finding.nextAction || `复核 ${finding.detector} finding 后重新运行 npm run vr:audit -- ${name}`,
    }));
  }

  for (const command of ledger?.commands || []) {
    if (command.status !== 'fail' && command.status !== 'warn') continue;
    items.push(withPriority({
      type: command.status === 'fail' ? 'failed-command' : 'warning-command',
      source: 'audit-ledger',
      title: `${command.id} ${command.status}`,
      command: command.id,
      status: command.status,
      evidence: command.log || command.stderrTail?.join('\n') || command.stdoutTail?.join('\n') || '',
      nextAction: command.status === 'fail'
        ? `先修复 ${command.id} 脚本失败,再重新运行 npm run vr:audit -- ${name}`
        : `查看 ${command.id} 日志并判断是否需要修复或豁免`,
    }));
  }

  for (const artifact of ledger?.artifacts?.required || []) {
    if (artifact.exists) continue;
    items.push(withPriority({
      type: 'missing-artifact',
      source: 'audit-ledger',
      title: `缺少必需产物 ${artifact.path}`,
      status: 'missing',
      artifact: artifact.path,
      nextAction: `重新运行 npm run vr:audit -- ${name},若仍缺失则检查对应脚本输出`,
    }));
  }

  for (const finding of edgeAudit?.summary?.findings || []) {
    items.push(withPriority({
      type: 'asset-edge',
      source: 'asset-edge-audit',
      title: `${finding.file}: ${finding.message}`,
      file: finding.file,
      kind: finding.kind,
      severity: finding.severity || 'medium',
      evidence: finding.message,
      nextAction: assetNextAction(finding, name),
    }));
  }

  for (const item of inventory?.summary?.unresolved?.items || []) {
    if (item.findingId && activeFindingIds.has(item.findingId)) continue;
    items.push(withPriority({
      type: 'visual-dimension',
      source: 'visual-inventory',
      title: `${item.id} ${item.dimension} ${item.status}`,
      id: item.id,
      kind: item.kind,
      selector: item.selector,
      text: item.text || '',
      dimension: item.dimension,
      status: item.status,
      reason: item.reason || '',
      nextAction: inventoryNextAction(item, name),
    }));
  }

  const sorted = items
    .sort((a, b) => {
      const p = PRIORITY_ORDER.get(a.priority) - PRIORITY_ORDER.get(b.priority);
      if (p) return p;
      return scoreItem(b) - scoreItem(a);
    })
  const visibleItems = Number.isFinite(top) ? sorted.slice(0, top) : sorted;

  return {
    version: 3,
    name,
    generatedAt: new Date().toISOString(),
    summary: summarizeQueue(items),
    truncated: visibleItems.length < sorted.length,
    items: visibleItems,
  };
}

function withPriority(item) {
  return {
    priority: priorityForQueueItem(item),
    ...item,
  };
}

function summarizeQueue(items) {
  const summary = {
    total: items.length,
    byPriority: {},
    byType: {},
    byDimension: {},
  };
  for (const item of items) {
    summary.byPriority[item.priority] = (summary.byPriority[item.priority] || 0) + 1;
    summary.byType[item.type] = (summary.byType[item.type] || 0) + 1;
    if (item.dimension) summary.byDimension[item.dimension] = (summary.byDimension[item.dimension] || 0) + 1;
  }
  return summary;
}

function scoreItem(item) {
  if (item.severity === 'high') return 100;
  if (item.type === 'asset-edge') return 80;
  if (item.dimension === 'asset') return 70;
  if (item.dimension === 'content') return 65;
  if (item.dimension === 'geometry') return 60;
  if (item.dimension === 'typography') return 50;
  if (item.dimension === 'textColor' || item.dimension === 'backgroundColor') return 45;
  return 10;
}

function assetNextAction(finding, name) {
  if (finding.kind === 'hairline') {
    return `打开 ${finding.file},按 finding 坐标复核细线;修复资源后运行 npm run vr:asset-edge -- ${name} 和 npm run vr:audit -- ${name}`;
  }
  if (finding.kind === 'alpha-halo') {
    return `重新提取透明 PNG 或调整去背景阈值,检查棋盘格无白边/黑边后运行 npm run vr:asset-edge -- ${name}`;
  }
  return `复核资源问题并重新运行 npm run vr:asset-edge -- ${name}`;
}

function inventoryNextAction(item, name) {
  const target = item.selector || item.id;
  switch (item.dimension) {
    case 'geometry':
      return `对 ${target} 做 bbox/overlay 复核,修正位置或尺寸后运行 npm run vr:audit -- ${name}`;
    case 'typography':
      return `对 ${target} 跑 font/full 审计或 inspect 放大,确认字号/字重/行高后批量修同类文本`;
    case 'textColor':
    case 'backgroundColor':
      return `对 ${target} 用 color-audit/pick 取色,修正同类颜色并看 delta 热力`;
    case 'border':
    case 'radius':
      return `对 ${target} 用 structure-audit/overlay 复核边框、圆角、分割线`;
    case 'asset':
      return `确认 ${target} 是否已进入 asset-plan/asset-edge-audit,资源污染需先清理再接入页面`;
    case 'content':
      return `确认 ${target} 文案可读性;不可辨认则语义 mock 并记录,不要用 blur`;
    default:
      return `复核 ${target} 的 ${item.dimension} 维度并在下一轮 audit 中销号`;
  }
}

function parseArgs(argv) {
  const args = { name: null, top: Infinity, json: false };
  for (const item of argv) {
    if (item === '--json') args.json = true;
    else if (item.startsWith('--top=')) args.top = Number(item.slice('--top='.length));
    else if (!args.name) args.name = item;
    else throw new Error(`未知参数: ${item}`);
  }
  if (!args.name) throw new Error('用法: node scripts/audit-queue.mjs <name> [--top=120] [--json]');
  if (args.top !== Infinity && (!Number.isFinite(args.top) || args.top <= 0)) throw new Error('--top 必须是正数');
  return args;
}

function readJsonIfExists(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const outDir = join(ROOT, 'output', args.name);
  const queue = buildRemediationQueue({
    name: args.name,
    top: args.top,
    ledger: readJsonIfExists(join(outDir, 'audit-ledger.json')),
    inventory: readJsonIfExists(join(outDir, 'visual-inventory.json')),
    edgeAudit: readJsonIfExists(join(outDir, 'assets', 'edge-audit.json')),
    findings: readJsonIfExists(join(outDir, 'findings.json')),
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'remediation-queue.json'), `${JSON.stringify(queue, null, 2)}\n`);

  if (args.json) {
    console.log(JSON.stringify(queue, null, 2));
  } else {
    console.log(`修复队列: ${queue.summary.total} 项, 已写 output/${args.name}/remediation-queue.json`);
    console.log(`优先级: ${Object.entries(queue.summary.byPriority).map(([p, n]) => `${p}×${n}`).join(', ') || '无'}`);
    for (const item of queue.items.slice(0, 12)) {
      console.log(`${item.priority} ${item.type} ${item.title}`);
    }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
