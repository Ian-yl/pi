import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4933';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 }, acceptDownloads: true });
const browserErrors = [];
page.on('pageerror', (error) => browserErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await assertVisibleText('让商品视觉');
  assert.equal(await page.locator('.module-card').count(), 4);

  const search = page.getByPlaceholder('搜索模板、场景、素材等');
  await search.fill('商品');
  const searchResponse = page.waitForResponse((response) => response.url().includes('/api/search/templates') && response.status() === 200);
  await search.press('Enter');
  await searchResponse;
  assert.ok(await page.locator('.search-popover button').count() > 0);

  await exerciseProduct();
  await exerciseTryOn();
  await exerciseMarketing();
  await exerciseCommerce();

  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await page.locator('.module-card').first().click();
  await page.waitForURL('**/photoreal-product');
  assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
  console.log('Full browser journey passed: navigation, search, uploads, AI helpers, 4 generation flows, regenerate, download, and history.');
} finally {
  await browser.close();
}

async function exerciseProduct() {
  await openGenerator('/photoreal-product', '商品套图');
  await uploadFirst('product.png');
  const assistResponse = page.waitForResponse((response) => response.url().endsWith('/api/ai/assist-copy'));
  await page.getByRole('button', { name: 'AI帮写' }).click();
  assert.equal((await assistResponse).status(), 200);
  await generate('/api/generations/product-suite', '商拍图');
  const regenerate = page.waitForResponse((response) => response.url().endsWith('/api/generations/product-suite'));
  await page.getByRole('button', { name: '重新生成' }).click();
  assert.equal((await regenerate).status(), 200);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载' }).click();
  assert.ok((await download).suggestedFilename().length > 0);
  await openHistory('商品套图生成');
}

async function exerciseTryOn() {
  await openGenerator('/try-on', '万物上身');
  await uploadFirst('clothing.png');
  const modelResponse = page.waitForResponse((response) => response.url().endsWith('/api/models/matched-reference'));
  await page.getByRole('button', { name: 'AI生成匹配模特' }).click();
  assert.equal((await modelResponse).status(), 200);
  await generate('/api/generations/try-on', '上身图');
  await openHistory('万物上身');
}

async function exerciseMarketing() {
  await openGenerator('/marketing-scene', '高转化主图');
  await uploadFirst('detergent.png');
  await page.getByRole('button', { name: '编辑' }).click();
  const point = page.getByPlaceholder('输入卖点');
  await point.fill('夏日限定');
  await page.getByRole('button', { name: '添加卖点' }).click();
  await assertVisibleText('夏日限定');
  await generate('/api/generations/marketing-scene', '转化图');
  await openHistory('高转化主图');
}

async function exerciseCommerce() {
  await openGenerator('/commerce-assets', '参数板块');
  await uploadFirst('shirt.png');
  await page.getByRole('button', { name: '女装上新' }).click();
  await page.getByRole('button', { name: '九宫格' }).click();
  await page.getByRole('button', { name: /奶油卡咖/ }).click();
  await generate('/api/generations/commerce-assets', '参数图');
  await openHistory('参数板块');
}

async function openGenerator(route, title) {
  await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
  await assertVisibleText(title);
}
async function uploadFirst(name) {
  await page.locator('input[type=file]').first().setInputFiles({ name, mimeType: 'image/png', buffer: png });
  assert.equal(await page.locator('.upload-thumb').count() > 0, true);
}
async function generate(pathname, expectedLabel) {
  const responsePromise = page.waitForResponse((response) => response.url().endsWith(pathname) && response.request().method() === 'POST');
  await page.locator('.primary-generate').click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, await response.text());
  await page.locator('.result-main-image').waitFor({ state: 'visible' });
  await assertVisibleText(expectedLabel);
}
async function openHistory(module) {
  const responsePromise = page.waitForResponse((response) => response.url().includes('/api/generations/history'));
  await page.locator('.tool-menu').getByRole('button', { name: '我的生成记录' }).click();
  assert.equal((await responsePromise).status(), 200);
  await page.locator('.history-drawer').waitFor({ state: 'visible' });
  await assertVisibleText(`我的生成记录 · ${module}`);
  assert.ok(await page.locator('.history-drawer > button').count() > 1);
  await page.locator('.history-close').click();
}
async function assertVisibleText(text) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible' });
}
