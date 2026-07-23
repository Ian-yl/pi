import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../serve.mjs';
import { resolveCaptureTargetMode } from './capture-target-mode.mjs';

export function resolveBrowserViewport(config, image = {}) {
  const dpr = positive(config?.viewport?.dpr, 1);
  return {
    width: Math.max(1, Math.round(positive(config?.viewport?.width, image.width ? image.width / dpr : 1440))),
    height: Math.max(1, Math.round(positive(config?.viewport?.height, image.height ? image.height / dpr : 900))),
  };
}

export function resolveTargetMode(config) {
  return resolveCaptureTargetMode(config?.capture);
}

export async function prepareCaptureTarget(config) {
  if (resolveTargetMode(config) !== 'external') return { child: null, close() {} };
  const capture = config.capture || {};
  if (!/^https?:\/\//i.test(capture.url || '')) {
    throw new Error('external capture adapter requires an absolute http(s) capture.url');
  }
  if (!capture.startCommand || await isReachable(capture.readyUrl || capture.url)) {
    return { child: null, close() {} };
  }
  const child = spawn(capture.startCommand, {
    cwd: resolve(config.root, capture.cwd || '.'),
    env: process.env,
    shell: true,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  await waitForUrl(capture.readyUrl || capture.url, capture.timeoutMs || 45_000, child);
  return {
    child,
    close() { stopChild(child); },
  };
}

export async function openAuditPage(config, {
  imageWidth = null,
  imageHeight = null,
  freeze = true,
} = {}) {
  const mode = resolveTargetMode(config);
  const capture = config.capture || {};
  const root = config.root;
  let staticServer = null;
  let managedTarget = { child: null, close() {} };

  if (mode === 'static') {
    const entry = resolve(root, capture.path || `pages/${config.name}/index.html`);
    if (!existsSync(entry)) throw new Error(`缺少实现页面: ${capture.path || `pages/${config.name}/index.html`}`);
    staticServer = await startServer(root, 0);
  } else {
    managedTarget = await prepareCaptureTarget(config);
  }

  const targetUrl = mode === 'static'
    ? `http://127.0.0.1:${staticServer.port}${capture.url || `/pages/${config.name}/index.html`}`
    : capture.url;
  const viewport = resolveBrowserViewport(config, { width: imageWidth, height: imageHeight });
  let browser = null;
  let page = null;

  try {
    browser = await chromium.launch();
    page = await browser.newPage({
      viewport,
      deviceScaleFactor: config.viewport.dpr,
    });
    await page.goto(targetUrl, {
      waitUntil: 'networkidle',
      timeout: capture.timeoutMs || 45_000,
    });
    if (freeze) {
      await page.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
      });
    }
    await page.evaluate(() => document.fonts.ready);
  } catch (error) {
    await browser?.close();
    staticServer?.server.close();
    managedTarget.close();
    throw error;
  }

  let closed = false;
  return {
    browser,
    page,
    targetUrl,
    viewport,
    mode,
    async close() {
      if (closed) return;
      closed = true;
      await browser.close();
      staticServer?.server.close();
      managedTarget.close();
    },
  };
}

async function waitForUrl(url, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(`capture.startCommand exited before ready URL became available: ${child.exitCode}`);
    }
    if (await isReachable(url)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  stopChild(child);
  throw new Error(`capture target did not become ready within ${timeoutMs}ms: ${url}`);
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch {
    return false;
  }
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function positive(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}
