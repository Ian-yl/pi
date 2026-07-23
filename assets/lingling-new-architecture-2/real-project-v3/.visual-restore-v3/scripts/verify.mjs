// 还原度验证:对 pages/<name>/ 截图,与 designs/<name>.png 做像素级对比,
// 产出 output/<name>/{design,actual,diff}.png 与 report.html。
//
// 用法: npm run verify <name> [-- --dpr=2 --threshold=0.1]
//   --dpr        设计图的设备像素比。retina(2x)截图传 2,viewport 取图宽的一半。默认 1
//   --threshold  pixelmatch 灵敏度,0~1,越小越严格。默认 0.1

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';
import pixelmatch from 'pixelmatch';
import { openAuditPage } from './lib/browser-target.mjs';
import { convertRasterToPng } from './lib/raster-image.mjs';
import { resolveRestoreConfig } from './lib/restore-config.mjs';

const { PNG } = pngjs;
export const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));

// 对 pages/<name>/index.html 截全页图,返回 PNG buffer。宽高按设计图尺寸(CSS 像素 = 物理像素 / dpr)。
export async function capturePage(name, {
  width,
  height,
  dpr = 1,
  capture = null,
  config = null,
} = {}) {
  const targetConfig = config || {
    name,
    root: ROOT,
    viewport: {
      width: Math.max(1, Math.round(width / dpr)),
      height: Math.max(1, Math.round(height / dpr)),
      dpr,
    },
    capture: capture || {
      adapter: 'static',
      path: `pages/${name}/index.html`,
      url: `/pages/${name}/index.html`,
      fullPage: true,
    },
  };
  const session = await openAuditPage(targetConfig, { imageWidth: width, imageHeight: height });
  try {
    await session.page.waitForTimeout(150);
    return await session.page.screenshot({ fullPage: targetConfig.capture.fullPage !== false, type: 'png' });
  } finally {
    await session.close();
  }
}

// 找 designs/<name>.png;jpg/jpeg/webp,统一转换成无损 PNG 供像素审计使用。
async function locateDesign(name, outDir, configuredSource = null) {
  const configured = configuredSource ? resolve(ROOT, configuredSource) : null;
  const png = configured && configured.toLowerCase().endsWith('.png')
    ? configured
    : join(ROOT, 'designs', `${name}.png`);
  if (existsSync(png)) return png;
  if (configured && existsSync(configured)) {
    const converted = join(outDir, 'design-converted.png');
    await convertRasterToPng(configured, converted);
    return converted;
  }
  for (const ext of ['jpg', 'jpeg', 'webp']) {
    const src = join(ROOT, 'designs', `${name}.${ext}`);
    if (existsSync(src)) {
      const converted = join(outDir, 'design-converted.png');
      await convertRasterToPng(src, converted);
      return converted;
    }
  }
  throw new Error(`找不到设计图 designs/${name}.png(也支持 .jpg/.jpeg/.webp)`);
}

// 把图 pad 到 W×H(白底,左上对齐),尺寸一致才能 pixelmatch
function padTo(img, W, H) {
  if (img.width === W && img.height === H) return img;
  const out = new PNG({ width: W, height: H });
  out.data.fill(255);
  PNG.bitblt(img, out, 0, 0, img.width, img.height, 0, 0);
  return out;
}

function reportHtml({ name, similarity, mismatch, design, shot, dpr, threshold }) {
  const pct = similarity.toFixed(2);
  const heightDelta = shot.height - design.height;
  const sizeNote =
    design.width === shot.width && design.height === shot.height
      ? '尺寸一致'
      : `⚠ 尺寸不一致(高度差 ${heightDelta > 0 ? '+' : ''}${heightDelta}px)`;
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>${name} · 还原验证报告</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; margin: 0; }
  body { font: 14px/1.6 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; background: #f3f4f6; color: #111827; padding: 24px; }
  header { display: flex; align-items: baseline; gap: 20px; flex-wrap: wrap; margin-bottom: 6px; }
  h1 { font-size: 20px; }
  .score { font-size: 40px; font-weight: 700; color: ${similarity >= 97 ? '#059669' : similarity >= 90 ? '#d97706' : '#dc2626'}; }
  .meta { color: #6b7280; margin-bottom: 16px; }
  nav { display: flex; gap: 8px; margin-bottom: 16px; }
  nav button { padding: 6px 16px; border: 1px solid #d1d5db; background: #fff; border-radius: 8px; cursor: pointer; font-size: 14px; }
  nav button.on { background: #111827; color: #fff; border-color: #111827; }
  section { display: none; }
  section.on { display: block; }
  .cols { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  figure { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px; }
  figcaption { font-weight: 600; margin-bottom: 8px; color: #374151; }
  img { width: 100%; display: block; image-rendering: -webkit-optimize-contrast; }
  .stage { position: relative; max-width: ${Math.round(design.width / dpr)}px; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; }
  .stage img { position: absolute; inset: 0; }
  .stage img:first-child { position: relative; }
  .bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  input[type=range] { width: 240px; }
</style>
</head>
<body>
<header><h1>${name}</h1><div class="score">${pct}%</div></header>
<p class="meta">差异 ${mismatch.toLocaleString()} px · 设计图 ${design.width}×${design.height} · 实现 ${shot.width}×${shot.height} · ${sizeNote} · dpr ${dpr} · threshold ${threshold}</p>
<nav>
  <button data-t="side" class="on">并排</button>
  <button data-t="overlay">叠加</button>
  <button data-t="diffv">差异图</button>
  <button data-t="deltav">色差热力</button>
  <button data-t="pickv">取色对比</button>
</nav>
<section id="side" class="on">
  <div class="cols">
    <figure><figcaption>设计图</figcaption><img src="design.png"></figure>
    <figure><figcaption>实现截图</figcaption><img src="actual.png"></figure>
    <figure><figcaption>位置差异(红 = 超阈值像素)</figcaption><img src="diff.png"></figure>
    <figure><figcaption>色差热力(蓝 6-20 轻微 → 黄 50 明显 → 红 120+ 严重,黑 = 一致)</figcaption><img src="delta.png"></figure>
  </div>
</section>
<section id="overlay">
  <div class="bar">
    <label>实现层透明度 <input id="op" type="range" min="0" max="100" value="50"></label>
    <button id="blink">闪烁对比</button>
  </div>
  <div class="stage">
    <img src="design.png">
    <img src="actual.png" id="top" style="opacity:.5">
  </div>
</section>
<section id="diffv">
  <figure style="max-width:${Math.round(design.width / dpr)}px"><img src="diff.png"></figure>
</section>
<section id="deltav">
  <p class="meta">逐像素 ΔRGB 色差(无阈值,轻微色偏也可见):
    <b style="color:#1937be">■</b> 轻微(6-20)
    <b style="color:#00c3d7">■</b> 可见(20)
    <b style="color:#d4b800">■</b> 明显(50)
    <b style="color:#ff2d00">■</b> 严重(120+)
    · 黑色 = 可忽略(&lt;6)</p>
  <figure style="max-width:${Math.round(design.width / dpr)}px"><img src="delta.png"></figure>
</section>
<section id="pickv">
  <div class="bar" id="pk-tip">底图为设计稿;鼠标悬停实时对比两图同一坐标的颜色,点击钉住采样点</div>
  <div style="display:flex; gap:16px; align-items:flex-start;">
    <div style="position:relative; flex:1; max-width:${Math.round(design.width / dpr)}px; cursor: crosshair;">
      <img src="design.png" id="pk-img" style="width:100%; display:block;">
      <div id="pk-cross" style="position:absolute; width:11px; height:11px; margin:-6px 0 0 -6px; border:2px solid #f0f; border-radius:50%; pointer-events:none; display:none;"></div>
    </div>
    <div style="position:sticky; top:16px; width:250px; background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:14px; font-size:13px;">
      <div style="color:#6b7280;">坐标 <b id="pk-xy">--</b></div>
      <div style="display:flex; align-items:center; gap:8px; margin-top:10px;">
        <span id="pk-c1" style="width:34px;height:24px;border-radius:5px;border:1px solid #d1d5db;"></span>
        <div>设计稿 <b id="pk-v1">--</b></div>
      </div>
      <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
        <span id="pk-c2" style="width:34px;height:24px;border-radius:5px;border:1px solid #d1d5db;"></span>
        <div>实现 <b id="pk-v2">--</b></div>
      </div>
      <div style="margin-top:10px; color:#6b7280;">ΔRGB <b id="pk-dv">--</b></div>
      <div id="pk-pins" style="margin-top:12px; border-top:1px solid #e5e7eb; padding-top:8px; display:none;">
        <div style="color:#6b7280; margin-bottom:6px;">已钉住</div>
        <div id="pk-pin-list" style="font-size:12px; line-height:1.9;"></div>
      </div>
    </div>
  </div>
</section>
<script>
  const secs = document.querySelectorAll('section');
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
    secs.forEach(s => s.classList.toggle('on', s.id === b.dataset.t));
  });
  const topImg = document.getElementById('top');
  let timer = null;
  const stopBlink = () => { clearInterval(timer); timer = null; };
  document.getElementById('op').oninput = e => { stopBlink(); topImg.style.opacity = e.target.value / 100; };
  document.getElementById('blink').onclick = () => {
    if (timer) { stopBlink(); return; }
    timer = setInterval(() => { topImg.style.opacity = topImg.style.opacity === '0' ? '1' : '0'; }, 500);
  };

  // ---- 取色对比 ----
  if (location.protocol === 'file:') {
    document.getElementById('pk-tip').innerHTML =
      '⚠ file:// 协议下浏览器禁止读取本地图片像素,取色不可用。请运行 <code>npm run serve</code>,' +
      '按终端输出的地址访问 <code>/output/${name}/report.html</code>';
  }
  const pkData = {};
  ['design', 'actual'].forEach((k) => {
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = im.naturalWidth; cv.height = im.naturalHeight;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(im, 0, 0);
      pkData[k] = { ctx: cx, w: cv.width, h: cv.height };
    };
    im.src = k + '.png';
  });
  const pkImg = document.getElementById('pk-img');
  const hex = (p) => '#' + [p[0], p[1], p[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  const sample = (k, x, y) => pkData[k] ? pkData[k].ctx.getImageData(x, y, 1, 1).data : null;
  function pkShow(x, y) {
    const d = sample('design', x, y), a = sample('actual', x, y);
    if (!d || !a) return null;
    document.getElementById('pk-xy').textContent = '(' + x + ', ' + y + ')';
    document.getElementById('pk-c1').style.background = hex(d);
    document.getElementById('pk-c2').style.background = hex(a);
    document.getElementById('pk-v1').textContent = hex(d) + ' rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')';
    document.getElementById('pk-v2').textContent = hex(a) + ' rgb(' + a[0] + ',' + a[1] + ',' + a[2] + ')';
    const dv = [a[0] - d[0], a[1] - d[1], a[2] - d[2]];
    document.getElementById('pk-dv').textContent = dv.map((v) => (v >= 0 ? '+' : '') + v).join(', ');
    return { d, a, dv };
  }
  const pkPos = (e) => {
    const r = pkImg.getBoundingClientRect();
    const x = Math.max(0, Math.min(pkData.design.w - 1, Math.round((e.clientX - r.left) / r.width * pkData.design.w)));
    const y = Math.max(0, Math.min(pkData.design.h - 1, Math.round((e.clientY - r.top) / r.height * pkData.design.h)));
    return { x, y, rx: e.clientX - r.left, ry: e.clientY - r.top };
  };
  pkImg.addEventListener('mousemove', (e) => { if (pkData.design) { const p = pkPos(e); pkShow(p.x, p.y); } });
  pkImg.addEventListener('click', (e) => {
    if (!pkData.design) return;
    const p = pkPos(e);
    const r = pkShow(p.x, p.y);
    if (!r) return;
    const cross = document.getElementById('pk-cross');
    cross.style.display = 'block';
    cross.style.left = p.rx + 'px';
    cross.style.top = p.ry + 'px';
    document.getElementById('pk-pins').style.display = 'block';
    const li = document.createElement('div');
    li.textContent = '(' + p.x + ',' + p.y + ') ' + hex(r.d) + ' → ' + hex(r.a) + '  Δ' + r.dv.join(',');
    document.getElementById('pk-pin-list').prepend(li);
  });
</script>
</body>
</html>`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('--'));
  const opt = (k, d) => {
    const hit = args.find((a) => a.startsWith(`--${k}=`));
    return hit ? Number(hit.split('=')[1]) : d;
  };
  const cliDpr = opt('dpr', NaN);
  const cliThreshold = opt('threshold', NaN);

  if (!name) {
    console.error('用法: npm run verify <name> [-- --dpr=2 --threshold=0.1]');
    process.exit(1);
  }
  const config = resolveRestoreConfig(name, {
    dpr: cliDpr,
    threshold: cliThreshold,
    root: ROOT,
  });
  const dpr = config.viewport.dpr;
  const threshold = config.quality.threshold;

  const outDir = join(ROOT, 'output', name);
  mkdirSync(outDir, { recursive: true });

  const designPath = await locateDesign(name, outDir, config.source);
  const design = PNG.sync.read(readFileSync(designPath));
  console.log(`设计图 ${design.width}×${design.height} @${dpr}x → viewport ${config.viewport.width || Math.round(design.width / dpr)}×${config.viewport.height || Math.round(design.height / dpr)}`);

  const shotBuf = await capturePage(name, { width: design.width, height: design.height, dpr, config });
  const shot = PNG.sync.read(shotBuf);

  const W = Math.max(design.width, shot.width);
  const H = Math.max(design.height, shot.height);
  const a = padTo(design, W, H);
  const b = padTo(shot, W, H);
  const diff = new PNG({ width: W, height: H });
  const mismatch = pixelmatch(a.data, b.data, diff.data, W, H, { threshold });
  const similarity = 100 * (1 - mismatch / (W * H));

  // 色差热力图:逐像素 ΔRGB 距离连续可视化(无阈值,低幅色偏也可见)
  const delta = new PNG({ width: W, height: H });
  const lerp3 = (c1, c2, t) => c1.map((v, i) => Math.round(v + (c2[i] - v) * t));
  for (let i = 0; i < W * H; i++) {
    const o = i << 2;
    const d = Math.hypot(a.data[o] - b.data[o], a.data[o + 1] - b.data[o + 1], a.data[o + 2] - b.data[o + 2]);
    let c;
    if (d < 6) c = [0, 0, 0];
    else if (d < 20) c = lerp3([25, 55, 190], [0, 195, 215], (d - 6) / 14);
    else if (d < 50) c = lerp3([0, 195, 215], [255, 220, 0], (d - 20) / 30);
    else if (d < 120) c = lerp3([255, 220, 0], [255, 45, 0], (d - 50) / 70);
    else c = [255, 0, 70];
    delta.data[o] = c[0]; delta.data[o + 1] = c[1]; delta.data[o + 2] = c[2]; delta.data[o + 3] = 255;
  }
  writeFileSync(join(outDir, 'delta.png'), PNG.sync.write(delta));

  copyFileSync(designPath, join(outDir, 'design.png'));
  writeFileSync(join(outDir, 'actual.png'), shotBuf);
  writeFileSync(join(outDir, 'diff.png'), PNG.sync.write(diff));
  writeFileSync(
    join(outDir, 'report.html'),
    reportHtml({ name, similarity, mismatch, design, shot, dpr, threshold }),
  );
  appendFileSync(
    join(outDir, 'history.jsonl'),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      name,
      similarity: Number(similarity.toFixed(4)),
      mismatch,
      pixels: W * H,
      design: { width: design.width, height: design.height },
      actual: { width: shot.width, height: shot.height },
      dpr,
      threshold,
    })}\n`,
  );

  const mark = similarity >= 97 ? '✅' : similarity >= 90 ? '🟡' : '🔴';
  console.log(`${mark} ${name} 相似度 ${similarity.toFixed(2)}%(差异 ${mismatch.toLocaleString()} / ${(W * H).toLocaleString()} px)`);
  if (shot.height !== design.height) {
    console.log(`⚠ 实现高度 ${shot.height}px ≠ 设计图 ${design.height}px,高度差会整体计入差异`);
  }
  if (shot.width !== design.width) {
    console.log(`🚨 实现宽度 ${shot.width}px ≠ 设计图 ${design.width}px —— 页面存在横向溢出!fullPage 按 scrollWidth 截图,pad 区会重挫相似度,先修溢出再看分数`);
  }
  console.log(`报告: output/${name}/report.html`);
}
