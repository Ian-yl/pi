import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import pngjs from 'pngjs';
import { chromium } from 'playwright';

const { PNG } = pngjs;

export async function readRasterSize(file) {
  if (extname(file).toLowerCase() === '.png') {
    const image = PNG.sync.read(readFileSync(file));
    return { width: image.width, height: image.height };
  }
  const session = await openRaster(file);
  try {
    return session.size;
  } finally {
    await session.browser.close();
  }
}

export async function convertRasterToPng(source, output) {
  if (extname(source).toLowerCase() === '.png') {
    writeFileSync(output, readFileSync(source));
    return readRasterSize(source);
  }
  const session = await openRaster(source);
  try {
    await session.page.setViewportSize(session.size);
    const buffer = await session.page.screenshot({
      type: 'png',
      omitBackground: true,
      clip: { x: 0, y: 0, width: session.size.width, height: session.size.height },
    });
    writeFileSync(output, buffer);
    return session.size;
  } finally {
    await session.browser.close();
  }
}

async function openRaster(file) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1, height: 1 }, deviceScaleFactor: 1 });
  try {
    await page.setContent('<style>html,body{margin:0;background:transparent}img{display:block}</style><img id="source">');
    const src = `data:${mimeFor(file)};base64,${readFileSync(file).toString('base64')}`;
    const size = await page.evaluate((imageSource) => new Promise((resolvePromise, reject) => {
      const image = document.getElementById('source');
      image.onload = () => resolvePromise({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('browser could not decode raster image'));
      image.src = imageSource;
    }), src);
    if (!size.width || !size.height) throw new Error(`无法读取图片尺寸: ${file}`);
    return { browser, page, size };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

function mimeFor(file) {
  switch (extname(file).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.png': return 'image/png';
    default: return 'application/octet-stream';
  }
}
