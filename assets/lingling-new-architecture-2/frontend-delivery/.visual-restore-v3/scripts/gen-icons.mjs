// 生成式图标资源:照设计稿切图放大描摹,手写 SVG 生成全部图形资产(替代位图切图)。
// 二维码特殊处理:从原切图逐像素游程扫描,无损矢量化为 rect 阵列。
// 用法: node scripts/gen-icons.mjs   → 产出 pages/launchpad/assets/*.svg
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const OUT = join(ROOT, 'pages', 'launchpad', 'assets');

const wrap = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n${body}\n</svg>\n`;

const ICONS = {
  // 新币安 mark:深蓝渐变六边形 + 白描边内盾
  'logo-mark': wrap(36, `  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4059e0"/><stop offset="1" stop-color="#2334a4"/></linearGradient></defs>
  <path d="M18 2.5l13.4 7.75v15.5L18 33.5 4.6 25.75v-15.5z" fill="url(#g)"/>
  <path d="M18 10l6.2 2.8v4.6c0 4-2.7 7-6.2 8.1-3.5-1.1-6.2-4.1-6.2-8.1v-4.6z" fill="none" stroke="#fff" stroke-width="1.9"/>`),

  // NOVA:深紫圆角方 + 紫色八角星徽章(双方形叠加轮廓)+ 内圆环
  'logo-nova': wrap(56, `  <rect x="1" y="1" width="48" height="48" rx="14" fill="#161028" stroke="#4a3a86" stroke-width="1"/>
  <path d="M25 12.2l3.7 3.8h5.3v5.3l3.8 3.7-3.8 3.7v5.3h-5.3L25 37.8l-3.7-3.8H16v-5.3L12.2 25l3.8-3.7V16h5.3z" fill="none" stroke="#7c5cf0" stroke-width="1.8" stroke-linejoin="round"/>
  <circle cx="25" cy="25" r="6" fill="none" stroke="#7c5cf0" stroke-width="1.8"/>
  <path d="M22 25a3 3 0 0 1 3-3" fill="none" stroke="#a68df5" stroke-width="1.6" stroke-linecap="round"/>`),

  // WAVE:深青圆角方 + 绿色点环
  'logo-wave': wrap(56, `  <rect x="1" y="1" width="48" height="48" rx="14" fill="#0a1b16" stroke="#1c4a3a" stroke-width="1"/>
  <circle cx="25" cy="25" r="10" fill="none" stroke="#2ee6a8" stroke-width="2.7" stroke-linecap="round" stroke-dasharray="0.1 5.15"/>`),

  // LUMI:白圆 + 蓝色六瓣花(雪花感,深浅两层)
  'logo-lumi': wrap(54, `  <circle cx="27" cy="27" r="25" fill="#f2f5fa"/>
  <g fill="none" stroke="#4a7af0" stroke-width="1.8">
    <ellipse cx="27" cy="19.8" rx="3.3" ry="6" transform="rotate(0 27 27)"/>
    <ellipse cx="27" cy="19.8" rx="3.3" ry="6" transform="rotate(60 27 27)"/>
    <ellipse cx="27" cy="19.8" rx="3.3" ry="6" transform="rotate(120 27 27)"/>
    <ellipse cx="27" cy="19.8" rx="3.3" ry="6" transform="rotate(180 27 27)"/>
    <ellipse cx="27" cy="19.8" rx="3.3" ry="6" transform="rotate(240 27 27)"/>
    <ellipse cx="27" cy="19.8" rx="3.3" ry="6" transform="rotate(300 27 27)"/>
  </g>
  <circle cx="27" cy="27" r="3.2" fill="none" stroke="#2f5cd8" stroke-width="1.8"/>`),

  // GRID:白圆 + 实心圆齿齿轮(8 圆齿 + 本体 + 白中孔)
  'logo-grid': wrap(54, `  <circle cx="27" cy="27" r="25" fill="#f2f5fa"/>
  <g fill="#5b66ee">
    <circle cx="27" cy="17.2" r="2.9"/><circle cx="33.9" cy="20.1" r="2.9"/>
    <circle cx="36.8" cy="27" r="2.9"/><circle cx="33.9" cy="33.9" r="2.9"/>
    <circle cx="27" cy="36.8" r="2.9"/><circle cx="20.1" cy="33.9" r="2.9"/>
    <circle cx="17.2" cy="27" r="2.9"/><circle cx="20.1" cy="20.1" r="2.9"/>
    <circle cx="27" cy="27" r="7.6"/>
  </g>
  <circle cx="27" cy="27" r="3.2" fill="#f2f5fa"/>`),

  // ORCA:白圆 + 粗实蓝色漩涡环(C 形开口螺旋)
  'logo-orca': wrap(54, `  <circle cx="27" cy="27" r="25" fill="#f2f5fa"/>
  <g fill="none" stroke="#3a8ef0" stroke-linecap="round">
    <path d="M37.5 27a10.5 10.5 0 1 0-10.5 10.5" stroke-width="3.4"/>
    <path d="M31.8 27a4.8 4.8 0 1 0-4.8 4.8" stroke-width="3"/>
  </g>`),

  // 礼盒:紫盒 + 粉丝带蝴蝶结
  'gift': wrap(30, `  <rect x="5" y="13.5" width="20" height="12.5" rx="1.6" fill="#8a4fd8"/>
  <rect x="3.6" y="8.6" width="22.8" height="5.6" rx="1.3" fill="#a55be8"/>
  <rect x="13" y="8.6" width="4" height="17.4" fill="#f08bc0"/>
  <path d="M15 8.6c-1.6-3.2-4.8-4.3-6.3-2.7-1.4 1.5-.1 4.2 3.2 4.7zM15 8.6c1.6-3.2 4.8-4.3 6.3-2.7 1.4 1.5.1 4.2-3.2 4.7z" fill="#f29fd0"/>
  <circle cx="15" cy="8.4" r="1.5" fill="#ffd76e"/>`),

  // 特性·优质项目:蓝渐变盾 + 白内盾
  'feat-quality': wrap(34, `  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a74f8"/><stop offset="1" stop-color="#3050d5"/></linearGradient></defs>
  <path d="M17 2l13 5.6v9.4c0 7.8-5.4 13.6-13 15.8C9.4 30.6 4 24.8 4 17V7.6z" fill="url(#g)"/>
  <path d="M17 9.3l7 3.1v4.8c0 4.3-2.9 7.5-7 8.7-4.1-1.2-7-4.4-7-8.7v-4.8z" fill="none" stroke="#fff" stroke-width="1.9"/>`),

  // 特性·公平公正:蓝渐变圆角方 + 白柱状图
  'feat-fair': wrap(34, `  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a74f8"/><stop offset="1" stop-color="#3050d5"/></linearGradient></defs>
  <rect x="2.5" y="2.5" width="29" height="29" rx="8" fill="url(#g)"/>
  <path d="M10.5 23v-6.5M17 23V11M23.5 23v-9" stroke="#fff" stroke-width="2.7" stroke-linecap="round"/>`),

  // 特性·资金安全:蓝渐变盾 + 白锁
  'feat-safe': wrap(34, `  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a74f8"/><stop offset="1" stop-color="#3050d5"/></linearGradient></defs>
  <path d="M17 2l13 5.6v9.4c0 7.8-5.4 13.6-13 15.8C9.4 30.6 4 24.8 4 17V7.6z" fill="url(#g)"/>
  <rect x="11.6" y="14.8" width="10.8" height="8.4" rx="1.6" fill="none" stroke="#fff" stroke-width="1.9"/>
  <path d="M13.6 14.8v-2.4a3.4 3.4 0 0 1 6.8 0v2.4" fill="none" stroke="#fff" stroke-width="1.9"/>`),

  // 底部·如何参与:深蓝底块 + 浅蓝纸飞机
  'bot-how': wrap(40, `  <rect x="2" y="2" width="36" height="36" rx="10" fill="#1d2850"/>
  <path d="M30 10.5L9.5 18.2l7.8 3.4zM30 10.5l-9.6 12.6-3.1-1.5zM30 10.5l-8 16.5-1.6-4z" fill="#82a7ff"/>`),

  // 底部·持仓快照:深底块 + 绿色相机
  'bot-snapshot': wrap(40, `  <rect x="2" y="2" width="36" height="36" rx="10" fill="#132a26"/>
  <g fill="none" stroke="#3ecfa0" stroke-width="2">
    <rect x="10" y="14" width="20" height="13.6" rx="3"/>
    <path d="M15 14l1.9-3h6.2l1.9 3"/>
    <circle cx="20" cy="20.6" r="3.9"/>
  </g>`),

  // 底部·项目筛选:紫底块 + 紫色方框勾
  'bot-filter': wrap(40, `  <rect x="2" y="2" width="36" height="36" rx="10" fill="#221d44"/>
  <g fill="none" stroke="#9d8bff" stroke-width="2">
    <rect x="11" y="11" width="18" height="18" rx="4.5"/>
    <path d="M15.5 20.2l3.1 3.1 6-6.6"/>
  </g>`),

  // 底部·帮助中心:深蓝底块 + 蓝色圆环问号
  'bot-help': wrap(40, `  <rect x="2" y="2" width="36" height="36" rx="10" fill="#17274a"/>
  <g fill="none" stroke="#5d9bff" stroke-width="2">
    <circle cx="20" cy="20" r="8.8"/>
    <path d="M17.4 17.6a2.7 2.7 0 0 1 5.2.8c0 1.8-2.6 2.1-2.6 3.6"/>
  </g>
  <circle cx="20" cy="25.4" r="1" fill="#5d9bff"/>`),
};

for (const [name, svg] of Object.entries(ICONS)) {
  writeFileSync(join(OUT, name + '.svg'), svg);
  console.log('✎ 生成 ' + name + '.svg');
}

// 二维码:从原切图逐像素游程扫描 → rect 阵列(格子图形的无损矢量化;透明底,亮格白色)
const qrPng = join(OUT, 'qrcode.png');
if (existsSync(qrPng)) {
  const img = PNG.sync.read(readFileSync(qrPng));
  const lum = (x, y) => {
    const i = (img.width * y + x) << 2;
    return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  };
  let rects = '';
  let count = 0;
  for (let y = 0; y < img.height; y++) {
    let runStart = -1;
    for (let x = 0; x <= img.width; x++) {
      const on = x < img.width && lum(x, y) > 110;
      if (on && runStart < 0) runStart = x;
      if (!on && runStart >= 0) {
        rects += `<rect x="${runStart}" y="${y}" width="${x - runStart}" height="1"/>`;
        runStart = -1;
        count++;
      }
    }
  }
  writeFileSync(
    join(OUT, 'qrcode.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 ${img.width} ${img.height}"><g fill="#dde3ef">${rects}</g></svg>\n`,
  );
  console.log(`✎ 生成 qrcode.svg(游程矢量化,${count} 段)`);
} else {
  console.log('⚠ qrcode.png 不存在,跳过二维码矢量化');
}
