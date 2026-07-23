// 结构审计:从实现 DOM 抽取常见 UI 结构,再在 design/actual 图上做 bbox 与控件细项检查。
// 用法:
//   node scripts/structure-audit.mjs <name> --dpr=2 [--json]

import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import {
  bboxByLum,
  verticalHairlines,
} from './lib/image-metrics.mjs';
import { openAuditPage } from './lib/browser-target.mjs';
import { makeFinding, summarizeFindings } from './lib/findings.mjs';
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
  console.error('用法: node scripts/structure-audit.mjs <name> --dpr=2 [--json]');
  process.exit(1);
}

const designPath = join(ROOT, 'output', name, 'design.png');
const actualPath = join(ROOT, 'output', name, 'actual.png');
if (!existsSync(designPath) || !existsSync(actualPath)) {
  console.error(`缺少 output/${name}/design.png 或 actual.png,请先运行 verify`);
  process.exit(1);
}

const cliDpr = Number(opt('dpr', NaN));
const config = resolveRestoreConfig(name, { dpr: cliDpr, root: ROOT });
const dpr = config.viewport.dpr;
const json = args.includes('--json');
const design = PNG.sync.read(readFileSync(designPath));
const actual = PNG.sync.read(readFileSync(actualPath));

const elements = await collectElements(config, design);
const reports = elements.map((element) => auditElement(element, design, actual, dpr));
const findings = reports.flatMap((report) => findingsForReport(report, config));
const result = {
  version: 2,
  name,
  generatedAt: new Date().toISOString(),
  dpr,
  summary: { reports: reports.length, ...summarizeFindings(findings) },
  reports,
  findings,
};

writeFileSync(join(ROOT, 'output', name, 'structure-audit.json'), `${JSON.stringify(result, null, 2)}\n`);

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`结构审计: ${reports.length} 项, 已写 output/${name}/structure-audit.json\n`);
  for (const report of reports) {
    const flags = [];
    if (report.bbox?.dx && Math.max(Math.abs(report.bbox.dx.left), Math.abs(report.bbox.dx.right)) > 4) flags.push('x');
    if (report.bbox?.dy && Math.max(Math.abs(report.bbox.dy.top), Math.abs(report.bbox.dy.bottom)) > 4) flags.push('y');
    if (report.hairlines && report.hairlines.design !== report.hairlines.actual) flags.push('hairline');
    const mark = flags.length ? '!' : ' ';
    console.log(
      `${mark} ${report.kind.padEnd(8)} ${report.selector.padEnd(12)} ` +
        `dom=(${report.rect.x},${report.rect.y},${report.rect.width}×${report.rect.height}) ` +
        `${report.bbox ? `dx=${report.bbox.dx.left},${report.bbox.dx.right} dy=${report.bbox.dy.top},${report.bbox.dy.bottom}` : 'bbox=(空)'}` +
        `${report.hairlines ? ` hairlines d/a=${report.hairlines.design}/${report.hairlines.actual}` : ''}`,
    );
  }
}

function findingsForReport(report, restoreConfig) {
  const findings = [];
  if (report.bbox) {
    const maxDx = Math.max(Math.abs(report.bbox.dx.left), Math.abs(report.bbox.dx.right));
    const maxDy = Math.max(Math.abs(report.bbox.dy.top), Math.abs(report.bbox.dy.bottom));
    if (maxDx > restoreConfig.quality.maxStructureDx || maxDy > restoreConfig.quality.maxStructureDy) {
      findings.push(makeFinding({
        detector: 'structure-audit',
        code: 'bbox-offset',
        dimension: 'geometry',
        severity: 'P1',
        title: `${report.selector} 结构偏移 dx=${maxDx.toFixed(1)} dy=${maxDy.toFixed(1)}`,
        target: { selector: report.selector, rect: report.rect, kind: report.kind },
        expected: report.bbox.design,
        actual: report.bbox.actual,
        threshold: {
          maxDx: restoreConfig.quality.maxStructureDx,
          maxDy: restoreConfig.quality.maxStructureDy,
        },
        confidence: 0.86,
        nextAction: '修正控件位置或尺寸，并检查全页同类结构',
      }));
    }
  }
  if (report.hairlines && report.hairlines.design !== report.hairlines.actual) {
    findings.push(makeFinding({
      detector: 'structure-audit',
      code: 'divider-count-mismatch',
      dimension: 'border',
      severity: 'P1',
      title: `${report.selector} 竖分割线数量不一致`,
      target: { selector: report.selector, rect: report.rect, kind: report.kind },
      expected: { count: report.hairlines.design, x: report.hairlines.designX },
      actual: { count: report.hairlines.actual, x: report.hairlines.actualX },
      confidence: 0.9,
      nextAction: '补齐或移除竖分割线，并复核所有输入框结构件',
    }));
  }
  return findings;
}

async function collectElements(targetConfig, designImg) {
  const session = await openAuditPage(targetConfig, {
    imageWidth: designImg.width,
    imageHeight: designImg.height,
  });
  try {
    return await session.page.evaluate(() => {
      const groups = [
        { kind: 'Input', selector: '.inp, input, textarea', lum: 25, checkHairlines: true },
        { kind: 'Button', selector: 'button, .btn-reg, [class*="btn"]', lum: 40 },
        { kind: 'Card', selector: '.card, [class*="card"]', lum: 25 },
        { kind: 'TabBar', selector: '.tabbar, [class*="tabbar"]', lum: 25 },
        { kind: 'Fab', selector: '.fab, [class*="fab"]', lum: 40 },
      ];
      const seen = new Set();
      const out = [];

      for (const group of groups) {
        for (const el of document.querySelectorAll(group.selector)) {
          const rect = el.getBoundingClientRect();
          const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}:${group.kind}`;
          if (seen.has(key) || rect.width < 4 || rect.height < 4) continue;
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
          seen.add(key);
          out.push({
            kind: group.kind,
            selector: selectorName(el),
            lum: group.lum,
            checkHairlines: !!group.checkHairlines,
            rect: {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
            },
          });
        }
      }

      return out;

      function selectorName(el) {
        if (el.id) return `#${el.id}`;
        if (el.className && typeof el.className === 'string') {
          return `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`;
        }
        return el.tagName.toLowerCase();
      }
    });
  } finally {
    await session.close();
  }
}

function auditElement(element, designImg, actualImg, scale) {
  const pad = Math.max(4, Math.round(6 * scale));
  const region = {
    x: Math.round(element.rect.x * scale) - pad,
    y: Math.round(element.rect.y * scale) - pad,
    width: Math.round(element.rect.width * scale) + pad * 2,
    height: Math.round(element.rect.height * scale) + pad * 2,
  };
  const designBox = bboxByLum(designImg, region, element.lum);
  const actualBox = bboxByLum(actualImg, region, element.lum);
  const report = {
    kind: element.kind,
    selector: element.selector,
    rect: {
      x: Math.round(element.rect.x * scale),
      y: Math.round(element.rect.y * scale),
      width: Math.round(element.rect.width * scale),
      height: Math.round(element.rect.height * scale),
    },
    bbox: null,
  };

  if (designBox && actualBox) {
    report.bbox = {
      design: designBox,
      actual: actualBox,
      dx: {
        left: actualBox.x - designBox.x,
        right: actualBox.x2 - designBox.x2,
      },
      dy: {
        top: actualBox.y - designBox.y,
        bottom: actualBox.y2 - designBox.y2,
      },
    };
  }

  if (element.checkHairlines) {
    const inner = {
      x: Math.round(element.rect.x * scale),
      y: Math.round(element.rect.y * scale),
      width: Math.round(element.rect.width * scale),
      height: Math.round(element.rect.height * scale),
    };
    const designLines = verticalHairlines(designImg, inner);
    const actualLines = verticalHairlines(actualImg, inner);
    report.hairlines = {
      design: designLines.length,
      actual: actualLines.length,
      designX: designLines.map((line) => Math.round((line.x + line.x2) / 2)),
      actualX: actualLines.map((line) => Math.round((line.x + line.x2) / 2)),
    };
  }

  return report;
}
