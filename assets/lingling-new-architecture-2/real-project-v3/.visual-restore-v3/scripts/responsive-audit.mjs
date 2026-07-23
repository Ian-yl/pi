// Multi-viewport robustness audit (mobile and desktop modes).
// Usage: node scripts/responsive-audit.mjs <name> [--json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAuditPage } from './lib/browser-target.mjs';
import { makeFinding, summarizeFindings } from './lib/findings.mjs';
import { DEFAULT_RESPONSIVE_RULES, resolveRestoreConfig } from './lib/restore-config.mjs';

const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));

export async function auditResponsiveTarget(config, {
  outputDir = join(config.root, 'output', config.name),
  writeScreenshots = true,
} = {}) {
  const responsive = config.responsive || { enabled: false, profiles: [], rules: DEFAULT_RESPONSIVE_RULES };
  const profiles = responsive.profiles || [];
  const responsiveDir = join(outputDir, 'responsive');
  mkdirSync(outputDir, { recursive: true });
  if (writeScreenshots) mkdirSync(responsiveDir, { recursive: true });

  if (!responsive.enabled) {
    const report = buildResponsiveReport(config.name, responsive, [], [], { skipped: true, reason: 'responsive audit disabled' });
    writeFileSync(join(outputDir, 'responsive-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const probes = [];
  let session = null;
  try {
    session = await openAuditPage(config, { freeze: false });
    await session.page.close();

    for (const profile of profiles) {
      probes.push(await captureResponsiveProfile(session, config, profile, responsive.rules, {
        responsiveDir,
        writeScreenshots,
        mode: responsive.mode || 'mobile',
      }));
    }
  } catch (error) {
    const remaining = profiles.filter((profile) => !probes.some((probe) => probe.id === profile.id));
    for (const profile of remaining) {
      probes.push({
        id: profile.id,
        reference: Boolean(profile.reference),
        requested: { width: profile.width, height: profile.height },
        captureError: error.message,
      });
    }
  } finally {
    await session?.close();
  }

  const findings = probes.flatMap((probe) => evaluateResponsiveProbe(probe, responsive.rules));
  const report = buildResponsiveReport(config.name, responsive, probes, findings);
  writeFileSync(join(outputDir, 'responsive-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function captureResponsiveProfile(session, config, profile, rules, {
  responsiveDir,
  writeScreenshots,
  mode = 'mobile',
}) {
  let context = null;
  const errors = [];
  const screenshotPath = writeScreenshots ? join(responsiveDir, `${profile.id}.png`) : '';
  const screenshot = screenshotPath ? relative(config.root, screenshotPath).replaceAll('\\', '/') : '';
  const mobileEmulation = mode !== 'desktop';

  try {
    context = await session.browser.newContext({
      viewport: { width: profile.width, height: profile.height },
      deviceScaleFactor: 1,
      isMobile: mobileEmulation,
      hasTouch: mobileEmulation,
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push({ type: 'page', message: error.message }));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push({ type: 'console', message: message.text() });
    });
    page.on('requestfailed', (request) => {
      errors.push({
        type: 'request',
        message: `${request.method()} ${request.url()} ${request.failure()?.errorText || 'failed'}`,
      });
    });

    await page.goto(session.targetUrl, {
      waitUntil: 'networkidle',
      timeout: config.capture?.timeoutMs || 45_000,
    });
    await page.addStyleTag({
      content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
    });
    await page.evaluate(() => document.fonts.ready);
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: false, type: 'png' });
    const probe = await collectResponsiveProbe(page, profile, rules);
    return {
      ...probe,
      reference: Boolean(profile.reference),
      screenshot,
      errors: dedupeErrors(errors),
    };
  } catch (error) {
    return {
      id: profile.id,
      reference: Boolean(profile.reference),
      requested: { width: profile.width, height: profile.height },
      screenshot,
      errors: dedupeErrors(errors),
      captureError: error.message,
    };
  } finally {
    await context?.close();
  }
}

async function collectResponsiveProbe(page, profile, rules) {
  return page.evaluate(({ requested, profileId, responsiveRules }) => {
    const html = document.documentElement;
    const body = document.body;
    const scrolling = document.scrollingElement || html;
    const htmlStyle = getComputedStyle(html);
    const bodyStyle = getComputedStyle(body);
    const bodyRect = body.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const scrollWidth = Math.max(html.scrollWidth, body.scrollWidth, scrolling.scrollWidth);
    const scrollHeight = Math.max(html.scrollHeight, body.scrollHeight, scrolling.scrollHeight);
    const hiddenX = [htmlStyle.overflowX, bodyStyle.overflowX].some((value) => ['hidden', 'clip'].includes(value));
    const hiddenY = [htmlStyle.overflowY, bodyStyle.overflowY].some((value) => ['hidden', 'clip'].includes(value));
    const widthMismatch = Math.abs(bodyRect.width - requested.width) > responsiveRules.maxViewportDrift;
    const heightMismatch = Math.abs(bodyRect.height - requested.height) > responsiveRules.maxViewportDrift;

    const semanticSelector = [
      'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
      '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]',
      '[role="radio"]', '[role="switch"]', '[role="textbox"]', '[role="combobox"]',
      '[role="searchbox"]', '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const formPattern = /(^|[\s_-])(input|inp|field|textbox|select|password|email|phone)([\s_-]|$)/i;
    const controlPattern = /(^|[\s_-])(btn|button|tab|action|control|submit|register)([\s_-]|$)/i;
    const all = [...document.querySelectorAll('*')];
    const visible = all.filter(isVisible);
    const candidates = new Set(visible.filter((element) => element.matches(semanticSelector)));

    for (const element of visible) {
      const identity = `${element.id || ''} ${typeof element.className === 'string' ? element.className : ''}`;
      const heuristic = formPattern.test(identity) || controlPattern.test(identity) ||
        element.hasAttribute('data-vr-control') || element.hasAttribute('data-vr-kind');
      if (!heuristic) continue;
      const hasMoreSpecificDescendant = [...element.querySelectorAll('*')].some((descendant) => {
        const descendantIdentity = `${descendant.id || ''} ${typeof descendant.className === 'string' ? descendant.className : ''}`;
        return isVisible(descendant) && (
          descendant.matches(semanticSelector) || formPattern.test(descendantIdentity) ||
          controlPattern.test(descendantIdentity) || descendant.hasAttribute('data-vr-control')
        );
      });
      if (!hasMoreSpecificDescendant) candidates.add(element);
    }

    const controlEntries = [...candidates].map((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const tag = element.tagName.toLowerCase();
      const role = String(element.getAttribute('role') || '').toLowerCase();
      const identity = `${element.id || ''} ${typeof element.className === 'string' ? element.className : ''}`;
      const formLike = formPattern.test(identity) || ['input', 'textarea', 'select'].includes(tag) ||
        ['textbox', 'combobox', 'searchbox'].includes(role) || element.dataset.vrKind === 'input';
      const semantic = element.matches(semanticSelector);
      const inline = tag === 'a' && style.display === 'inline';
      const primary = element.hasAttribute('data-vr-primary') || formLike ||
        ['button', 'input', 'textarea', 'select'].includes(tag) ||
        /primary|submit|register|login|nav|tab/i.test(identity) ||
        ['button', 'tab', 'textbox', 'combobox', 'searchbox'].includes(role);
      const clipping = clippingState(element, rect, {
        viewport,
        scrollWidth,
        scrollHeight,
        hiddenX,
        hiddenY,
        position: style.position,
      });
      return {
        element,
        visible: visibleRectOf(element, rect),
        value: {
          id: stableElementId(element, index),
          selector: displaySelector(element),
          tag,
          role,
          text: String(element.getAttribute('aria-label') || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
          primary,
          inline,
          semantic,
          formLike,
          clipped: clipping.clipped,
          unreachable: clipping.unreachable,
          width: round(rect.width),
          height: round(rect.height),
          fontSize: round(parseFloat(style.fontSize)),
          rect: rectValue(rect),
          position: style.position,
          overlaps: [],
        },
      };
    });

    for (let left = 0; left < controlEntries.length; left++) {
      for (let right = left + 1; right < controlEntries.length; right++) {
        const a = controlEntries[left];
        const b = controlEntries[right];
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
        // 只比较可见矩形:被滚动容器裁掉的部分不构成视觉重叠
        if (a.visible.width <= 0 || a.visible.height <= 0 || b.visible.width <= 0 || b.visible.height <= 0) continue;
        const overlap = overlapArea(a.visible, b.visible);
        const smaller = Math.min(a.visible.width * a.visible.height, b.visible.width * b.visible.height);
        if (overlap >= 64 && overlap / Math.max(1, smaller) >= 0.25) {
          a.value.overlaps.push(b.value.id);
          b.value.overlaps.push(a.value.id);
        }
      }
    }

    const clippedText = [];
    for (const [index, element] of visible.entries()) {
      if (!hasDirectText(element)) continue;
      const style = getComputedStyle(element);
      const clipX = ['hidden', 'clip'].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
      const clipY = ['hidden', 'clip'].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      if (!clipX && !clipY) continue;
      clippedText.push({
        id: stableElementId(element, index),
        selector: displaySelector(element),
        axis: clipY ? 'vertical' : 'horizontal',
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
      });
    }

    const viewportMeta = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '';
    const styleText = [...document.querySelectorAll('style')].map((node) => node.textContent || '').join('\n');
    const stylesheetText = [...document.styleSheets].flatMap((sheet) => {
      try { return [...sheet.cssRules].map((rule) => rule.cssText); } catch { return []; }
    }).join('\n');
    const usesInsets = /safe-area-inset-(top|right|bottom|left)/i.test(`${styleText}\n${stylesheetText}`);
    const edgeControls = controlEntries
      .filter(({ value }) => ['fixed', 'sticky'].includes(value.position))
      .filter(({ value }) => value.rect.top <= 2 || value.rect.bottom >= viewport.height - 2)
      .map(({ value }) => value.id);
    const safeAreaRequired = responsiveRules.safeArea === 'required' ||
      (responsiveRules.safeArea === 'auto' && /viewport-fit\s*=\s*cover/i.test(viewportMeta));

    return {
      id: profileId,
      requested,
      viewport,
      document: {
        scrollWidth,
        scrollHeight,
        clientWidth: html.clientWidth,
        clientHeight: html.clientHeight,
        horizontalOverflow: Math.max(0, scrollWidth - viewport.width),
      },
      root: {
        width: round(bodyRect.width),
        height: round(bodyRect.height),
        overflowHidden: hiddenX || hiddenY,
        fixedCanvas: widthMismatch || ((hiddenX || hiddenY) && heightMismatch),
        htmlOverflow: `${htmlStyle.overflowX}/${htmlStyle.overflowY}`,
        bodyOverflow: `${bodyStyle.overflowX}/${bodyStyle.overflowY}`,
      },
      controls: controlEntries.map(({ value }) => value),
      clippedText,
      safeArea: {
        mode: responsiveRules.safeArea,
        required: safeAreaRequired,
        usesInsets,
        viewportFitCover: /viewport-fit\s*=\s*cover/i.test(viewportMeta),
        edgeControls,
      },
    };

    function isVisible(element) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 &&
        rect.width > 0 && rect.height > 0 && !element.closest('[aria-hidden="true"]');
    }

    function clippingState(element, rect, metrics) {
      let clipped = false;
      let unreachable = false;
      let paneScrollable = false;
      if (metrics.hiddenX) {
        if (rect.right <= 0 || rect.left >= metrics.viewport.width) unreachable = true;
        else if (rect.left < 0 || rect.right > metrics.viewport.width) clipped = true;
      }
      if (metrics.hiddenY) {
        if (rect.bottom <= 0 || rect.top >= metrics.viewport.height) unreachable = true;
        else if (rect.top < 0 || rect.bottom > metrics.viewport.height) clipped = true;
      }
      if (['fixed', 'sticky'].includes(metrics.position)) {
        if (rect.right <= 0 || rect.left >= metrics.viewport.width || rect.bottom <= 0 || rect.top >= metrics.viewport.height) {
          unreachable = true;
        } else if (rect.left < 0 || rect.right > metrics.viewport.width || rect.top < 0 || rect.bottom > metrics.viewport.height) {
          clipped = true;
        }
      }

      for (let ancestor = element.parentElement; ancestor && ancestor !== body; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const scrollsX = ['auto', 'scroll'].includes(style.overflowX);
        const scrollsY = ['auto', 'scroll'].includes(style.overflowY);
        if (scrollsX || scrollsY) {
          // 内容面板滚动模型:元素落在滚动容器的可滚动内容范围内即视为可达
          const parentRect = ancestor.getBoundingClientRect();
          const contentLeft = rect.left - parentRect.left + ancestor.scrollLeft;
          const contentTop = rect.top - parentRect.top + ancestor.scrollTop;
          const reachableX = !scrollsX || (contentLeft + rect.width > 0 && contentLeft < ancestor.scrollWidth);
          const reachableY = !scrollsY || (contentTop + rect.height > 0 && contentTop < ancestor.scrollHeight);
          if (reachableX && reachableY) paneScrollable = true;
        }
        const clipsX = ['hidden', 'clip'].includes(style.overflowX);
        const clipsY = ['hidden', 'clip'].includes(style.overflowY);
        if (!clipsX && !clipsY) continue;
        const parentRect = ancestor.getBoundingClientRect();
        if ((clipsX && (rect.right <= parentRect.left || rect.left >= parentRect.right)) ||
            (clipsY && (rect.bottom <= parentRect.top || rect.top >= parentRect.bottom))) {
          unreachable = true;
        } else if ((clipsX && (rect.left < parentRect.left || rect.right > parentRect.right)) ||
                   (clipsY && (rect.top < parentRect.top || rect.bottom > parentRect.bottom))) {
          clipped = true;
        }
      }

      if (!paneScrollable && (rect.top >= metrics.scrollHeight || rect.left >= metrics.scrollWidth)) unreachable = true;
      return { clipped, unreachable };
    }

    function stableElementId(element, index) {
      return element.getAttribute('data-vr-id') || element.id || `${element.tagName.toLowerCase()}-${index + 1}`;
    }

    function displaySelector(element) {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const classes = typeof element.className === 'string'
        ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
        : [];
      return `${element.tagName.toLowerCase()}${classes.map((name) => `.${CSS.escape(name)}`).join('')}`;
    }

    function hasDirectText(element) {
      return [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    }

    function visibleRectOf(element, rect) {
      // 逐层与非 visible overflow 的祖先盒相交,得到实际可见矩形(根级滚动内容不受影响)
      let left = rect.left;
      let top = rect.top;
      let right = rect.right;
      let bottom = rect.bottom;
      for (let ancestor = element.parentElement; ancestor && ancestor !== body; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const clipsX = style.overflowX !== 'visible';
        const clipsY = style.overflowY !== 'visible';
        if (!clipsX && !clipsY) continue;
        const parentRect = ancestor.getBoundingClientRect();
        if (clipsX) {
          left = Math.max(left, parentRect.left);
          right = Math.min(right, parentRect.right);
        }
        if (clipsY) {
          top = Math.max(top, parentRect.top);
          bottom = Math.min(bottom, parentRect.bottom);
        }
      }
      return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    }

    function rectValue(rect) {
      return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height), top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom), left: round(rect.left) };
    }

    function overlapArea(a, b) {
      const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return width * height;
    }

    function round(value) {
      return Math.round(Number(value) * 100) / 100;
    }
  }, {
    requested: { width: profile.width, height: profile.height },
    profileId: profile.id,
    responsiveRules: rules,
  });
}

function buildResponsiveReport(name, responsive, probes, findings, extra = {}) {
  const findingSummary = summarizeFindings(findings);
  const blockingFindings = findings.filter((finding) => ['P0', 'P1'].includes(finding.severity)).length;
  const failedProfiles = new Set(findings
    .filter((finding) => ['P0', 'P1'].includes(finding.severity))
    .map((finding) => finding.evidence?.profile)
    .filter(Boolean));
  return {
    version: 1,
    schemaVersion: '3.2',
    name,
    generatedAt: new Date().toISOString(),
    mode: responsive.mode || 'mobile',
    rules: responsive.rules || { ...DEFAULT_RESPONSIVE_RULES },
    summary: {
      status: extra.skipped ? 'skipped' : blockingFindings ? 'fail' : findings.length ? 'warn' : 'pass',
      profiles: probes.length,
      passedProfiles: Math.max(0, probes.length - failedProfiles.size),
      failedProfiles: failedProfiles.size,
      findings: findings.length,
      blockingFindings,
      bySeverity: findingSummary.bySeverity,
      byDimension: findingSummary.byDimension,
      ...extra,
    },
    profiles: probes,
    findings,
  };
}

function dedupeErrors(errors) {
  const seen = new Set();
  return errors.filter((error) => {
    const key = `${error.type}:${error.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function evaluateResponsiveProbe(probe = {}, ruleOverrides = {}) {
  const rules = { ...DEFAULT_RESPONSIVE_RULES, ...ruleOverrides };
  const findings = [];
  const profileId = String(probe.id || 'unknown-profile');
  const requested = probe.requested || {};
  const viewport = probe.viewport || {};
  const viewportDx = Math.abs(number(viewport.width) - number(requested.width));
  const viewportDy = Math.abs(number(viewport.height) - number(requested.height));

  if (probe.captureError) {
    findings.push(responsiveFinding(probe, {
      code: 'profile-capture-failed',
      severity: 'P0',
      title: `${profileId} 视口采集失败`,
      actual: { message: probe.captureError },
      anchor: `${profileId}:capture`,
      nextAction: '修复页面启动、路由或浏览器错误后重新执行完整移动端审计',
    }));
    return findings;
  }

  if (Math.max(viewportDx, viewportDy) > rules.maxViewportDrift) {
    findings.push(responsiveFinding(probe, {
      code: 'viewport-drift',
      severity: 'P1',
      title: `${profileId} 有效 viewport 与请求尺寸不一致`,
      expected: requested,
      actual: viewport,
      threshold: { maxViewportDrift: rules.maxViewportDrift },
      anchor: `${profileId}:viewport`,
      nextAction: '移除撑大 layout viewport 的固定根宽度或最小宽度，并复核 viewport meta',
    }));
  }

  const horizontalOverflow = number(probe.document?.horizontalOverflow);
  if (horizontalOverflow > rules.maxHorizontalOverflow) {
    findings.push(responsiveFinding(probe, {
      code: 'horizontal-overflow',
      severity: 'P1',
      title: `${profileId} 页面横向溢出 ${horizontalOverflow}px`,
      expected: { maxHorizontalOverflow: rules.maxHorizontalOverflow },
      actual: { horizontalOverflow },
      anchor: `${profileId}:horizontal-overflow`,
      nextAction: '定位超出视口的固定宽度、绝对定位或不可收缩内容，并检查所有移动宽度',
    }));
  }

  if (probe.root?.fixedCanvas) {
    findings.push(responsiveFinding(probe, {
      code: 'fixed-root-canvas',
      severity: 'P1',
      title: `${profileId} 根画布被固定为 ${number(probe.root.width)}x${number(probe.root.height)}`,
      expected: { fixedCanvas: false },
      actual: probe.root,
      anchor: `${profileId}:root-canvas`,
      nextAction: '将根画布改为流式尺寸，并让页面高度由内容、视口和安全区共同决定',
    }));
  }

  for (const control of probe.controls || []) {
    const target = controlTarget(profileId, control);
    const anchor = `${profileId}:${control.id || control.selector || control.tag || 'control'}`;
    if (control.unreachable) {
      findings.push(responsiveFinding(probe, {
        code: 'control-inaccessible',
        dimension: 'interaction',
        severity: control.primary ? 'P0' : 'P1',
        title: `${profileId} 控件不可通过滚动或点击到达: ${controlLabel(control)}`,
        target,
        actual: control,
        anchor: `${anchor}:unreachable`,
        nextAction: '移除祖先裁切或固定高度，保证控件在该视口中可滚动到达',
      }));
    }
    if (control.clipped) {
      findings.push(responsiveFinding(probe, {
        code: 'control-clipped',
        dimension: 'interaction',
        severity: 'P1',
        title: `${profileId} 控件被裁切: ${controlLabel(control)}`,
        target,
        actual: control,
        anchor: `${anchor}:clipped`,
        nextAction: '修复控件尺寸、定位或祖先 overflow，使其完整显示',
      }));
    }
    if ((control.overlaps || []).length) {
      findings.push(responsiveFinding(probe, {
        code: 'control-overlap',
        dimension: 'interaction',
        severity: 'P1',
        title: `${profileId} 交互控件重叠: ${controlLabel(control)}`,
        target,
        actual: { overlaps: control.overlaps },
        anchor: `${anchor}:overlap`,
        nextAction: '调整响应式布局和固定控件层级，消除可见点击区域重叠',
      }));
    }
    if (rules.requireSemanticControls && control.formLike && !control.semantic) {
      findings.push(responsiveFinding(probe, {
        code: 'non-semantic-form-control',
        dimension: 'semantics',
        severity: 'P1',
        title: `${profileId} 表单外观元素不是可输入控件: ${controlLabel(control)}`,
        target,
        expected: { semantic: true },
        actual: { tag: control.tag, semantic: control.semantic },
        anchor: `${anchor}:semantic`,
        nextAction: '使用 input、textarea、select 或语义正确且可键盘操作的控件实现',
      }));
    }

    const minTarget = control.inline ? rules.minInlineTarget : rules.minTouchTarget;
    if (number(control.width) < minTarget || number(control.height) < minTarget) {
      const code = control.inline ? 'inline-target-small' : 'touch-target-small';
      findings.push(responsiveFinding(probe, {
        code,
        dimension: 'interaction',
        severity: control.inline ? 'P2' : control.primary ? 'P1' : 'P2',
        title: `${profileId} 触控区域过小: ${controlLabel(control)} ${number(control.width)}x${number(control.height)}`,
        target,
        expected: { minWidth: minTarget, minHeight: minTarget },
        actual: { width: number(control.width), height: number(control.height) },
        anchor: `${anchor}:target-size`,
        nextAction: '扩大可点击区域但保持视觉尺寸，或重新安排相邻控件间距',
      }));
    }

    if (isTextEntry(control) && number(control.fontSize) < rules.minInputFontSize) {
      findings.push(responsiveFinding(probe, {
        code: 'input-font-small',
        dimension: 'typography',
        severity: 'P2',
        title: `${profileId} 输入控件字号 ${number(control.fontSize)}px 可能触发 iOS 自动缩放`,
        target,
        expected: { minInputFontSize: rules.minInputFontSize },
        actual: { fontSize: number(control.fontSize) },
        anchor: `${anchor}:input-font`,
        nextAction: '将移动端输入文字设为至少 16px，并通过内部排版保持视觉层级',
      }));
    }
  }

  for (const text of probe.clippedText || []) {
    findings.push(responsiveFinding(probe, {
      code: 'text-clipped',
      dimension: 'typography',
      severity: 'P1',
      title: `${profileId} 文字被${text.axis === 'vertical' ? '垂直' : '水平'}裁切: ${text.selector || text.id || 'text'}`,
      target: { region: profileId, elementId: text.id || '', selector: text.selector || '' },
      actual: text,
      anchor: `${profileId}:${text.id || text.selector || 'text'}:text-clipped`,
      nextAction: '允许文字换行或增大容器，不得用隐藏溢出来掩盖内容',
    }));
  }

  if (probe.safeArea?.required && !probe.safeArea?.usesInsets && (probe.safeArea?.edgeControls || []).length) {
    findings.push(responsiveFinding(probe, {
      code: 'safe-area-missing',
      severity: 'P1',
      title: `${profileId} 贴边固定控件未处理安全区`,
      actual: probe.safeArea,
      anchor: `${profileId}:safe-area`,
      nextAction: '使用 env(safe-area-inset-*) 为贴边 fixed/sticky 控件保留安全区',
    }));
  }

  for (const [index, error] of (probe.errors || []).entries()) {
    findings.push(responsiveFinding(probe, {
      code: 'browser-error',
      severity: 'P1',
      title: `${profileId} 浏览器错误: ${String(error.message || error.type || 'unknown').slice(0, 160)}`,
      actual: error,
      anchor: `${profileId}:browser-error:${index}`,
      nextAction: '修复控制台、页面或资源加载错误后重新执行所有视口',
    }));
  }

  return findings;
}

function responsiveFinding(probe, input) {
  return makeFinding({
    detector: 'responsive-audit',
    dimension: input.dimension || 'responsive',
    confidence: 0.95,
    target: input.target || { region: String(probe.id || 'unknown-profile') },
    evidence: { profile: probe.id || 'unknown-profile', screenshot: probe.screenshot || '' },
    ...input,
  });
}

function controlTarget(profileId, control) {
  return {
    region: profileId,
    elementId: String(control.id || ''),
    selector: String(control.selector || ''),
  };
}

function controlLabel(control) {
  return control.text || control.selector || control.id || control.tag || 'control';
}

function isTextEntry(control) {
  return ['input', 'textarea', 'select'].includes(String(control.tag || '').toLowerCase()) ||
    ['textbox', 'combobox', 'searchbox'].includes(String(control.role || '').toLowerCase());
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

async function main(argv = process.argv.slice(2)) {
  const name = argv.find((item) => !item.startsWith('--'));
  const json = argv.includes('--json');
  if (!name) throw new Error('用法: node scripts/responsive-audit.mjs <name> [--json]');
  const config = resolveRestoreConfig(name, { root: ROOT });
  const report = await auditResponsiveTarget(config, { outputDir: join(ROOT, 'output', name) });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.summary.status === 'skipped') {
    console.log(`响应式审计: skipped (${report.summary.reason})`);
  } else {
    console.log(`响应式审计: ${report.summary.status}, ${report.summary.profiles} profiles, ${report.summary.blockingFindings} blocking, ${report.summary.findings} findings`);
    for (const profile of report.profiles) {
      const count = report.findings.filter((finding) => finding.evidence?.profile === profile.id).length;
      console.log(`  ${profile.id} ${profile.requested.width}x${profile.requested.height}: ${count} findings`);
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
