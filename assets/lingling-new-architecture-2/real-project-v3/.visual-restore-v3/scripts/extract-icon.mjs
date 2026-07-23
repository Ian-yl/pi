// 从设计图中提取透明 PNG 图标:
//   crop → optional upscale → optional sharpen → background removal → RGBA PNG
//
// 用法:
//   node scripts/extract-icon.mjs <name> --id=logo --rect=x,y,w,h [--bg=auto|none|#rrggbb|r,g,b]
//   npm run extract-icon -- launchpad -- --id=logo --rect=30,28,104,36 --bg=auto --scales=1,2,3
//
// 原则:
//   - 线性/单色图标优先 SVG,本工具用于确实需要位图透明 PNG 的复杂图标/徽章。
//   - 背景复杂时不要强行 auto,应先做 mask 或显式背景色;报告图必须人工看边缘。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));

function usage() {
  console.error('用法: node scripts/extract-icon.mjs <name> [--id=<id> --rect=x,y,w,h | --plan=pages/<name>/asset-plan.json] [--bg=auto|none|#rrggbb|r,g,b] [--scales=1,2,3] [--threshold=28] [--opaque=72] [--sharpen=0.35]');
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    name: null,
    id: null,
    rect: null,
    bg: 'auto',
    plan: null,
    source: null,
    out: null,
    scales: [1],
    threshold: 28,
    opaque: 72,
    sharpen: 0.35,
    edgeContract: 0,
    edgeFeather: 0,
  };

  for (const item of argv) {
    if (item === '--') continue;
    if (item.startsWith('--id=')) args.id = item.slice(5);
    else if (item.startsWith('--rect=')) args.rect = parseRect(item.slice(7));
    else if (item.startsWith('--bg=')) args.bg = item.slice(5);
    else if (item.startsWith('--plan=')) args.plan = item.slice(7);
    else if (item.startsWith('--source=')) args.source = item.slice(9);
    else if (item.startsWith('--out=')) args.out = item.slice(6);
    else if (item.startsWith('--scales=')) args.scales = item.slice(9).split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
    else if (item.startsWith('--threshold=')) args.threshold = Number(item.slice(12));
    else if (item.startsWith('--opaque=')) args.opaque = Number(item.slice(9));
    else if (item.startsWith('--sharpen=')) args.sharpen = Number(item.slice(10));
    else if (item.startsWith('--edge-contract=')) args.edgeContract = Math.max(0, Math.round(Number(item.slice(16))));
    else if (item.startsWith('--edge-feather=')) args.edgeFeather = Math.max(0, Math.round(Number(item.slice(15))));
    else if (!args.name) args.name = item;
    else usage();
  }

  if (!args.name || !args.scales.length) usage();
  if ((args.id && !args.rect) || (!args.id && args.rect)) usage();
  return args;
}

export function parseRect(spec) {
  const nums = spec.split(',').map((n) => Number(n.trim()));
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
    throw new Error(`rect 格式必须是 x,y,w,h: ${spec}`);
  }
  return { x: Math.round(nums[0]), y: Math.round(nums[1]), width: Math.round(nums[2]), height: Math.round(nums[3]) };
}

export function parseColor(spec) {
  if (!spec || spec === 'auto' || spec === 'none') return spec || 'auto';
  if (spec.startsWith('#')) {
    const hex = spec.slice(1);
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`颜色格式错误: ${spec}`);
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  const nums = spec.split(',').map((n) => Number(n.trim()));
  if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    throw new Error(`颜色格式错误: ${spec}`);
  }
  return nums.map(Math.round);
}

export function iconJobsFromPlan(rawPlan, defaults = {}) {
  const icons = rawPlan.icons || rawPlan.iconAssets || [];
  if (!Array.isArray(icons)) throw new Error('asset-plan icons 必须是数组');
  return icons.map((icon, index) => {
    if (!icon.id) throw new Error(`icons[${index}] 缺少 id`);
    if (!icon.rect) throw new Error(`icons[${index}] 缺少 rect`);
    return {
      id: icon.id,
      rect: Array.isArray(icon.rect)
        ? { x: icon.rect[0], y: icon.rect[1], width: icon.rect[2], height: icon.rect[3] }
        : parseRect(`${icon.rect.x},${icon.rect.y},${icon.rect.width ?? icon.rect.w},${icon.rect.height ?? icon.rect.h}`),
      bg: icon.bg ?? defaults.bg ?? 'auto',
      scales: icon.scales || defaults.scales || [1],
      threshold: Number(icon.threshold ?? defaults.threshold ?? 28),
      opaque: Number(icon.opaque ?? defaults.opaque ?? 72),
      sharpen: Number(icon.sharpen ?? defaults.sharpen ?? 0.35),
      edgeContract: Number(icon.edgeContract ?? defaults.edgeContract ?? 0),
      edgeFeather: Number(icon.edgeFeather ?? defaults.edgeFeather ?? 0),
      out: icon.out || icon.outputDir || defaults.out || null,
      source: icon.source || defaults.source || null,
      note: icon.note || '',
    };
  });
}

export function estimateBackgroundColor(img) {
  const samples = [];
  const push = (x, y) => {
    const o = (img.width * y + x) << 2;
    samples.push([img.data[o], img.data[o + 1], img.data[o + 2]]);
  };

  for (let x = 0; x < img.width; x++) {
    push(x, 0);
    push(x, img.height - 1);
  }
  for (let y = 1; y < img.height - 1; y++) {
    push(0, y);
    push(img.width - 1, y);
  }

  return [0, 1, 2].map((channel) => {
    const values = samples.map((p) => p[channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  });
}

export function removeBackground(img, {
  bg = 'auto',
  threshold = 28,
  opaque = 72,
  edgeContract = 0,
  edgeFeather = 0,
} = {}) {
  const bgColor = Array.isArray(bg) ? bg : (bg === 'auto' ? estimateBackgroundColor(img) : null);
  const out = clonePng(img);
  if (!bgColor) {
    for (let i = 0; i < out.width * out.height; i++) out.data[(i << 2) + 3] = 255;
    return { image: out, bgColor: null };
  }

  for (let i = 0; i < out.width * out.height; i++) {
    const o = i << 2;
    const d = colorDistance([out.data[o], out.data[o + 1], out.data[o + 2]], bgColor);
    let alpha;
    if (d <= threshold) alpha = 0;
    else if (d >= opaque) alpha = 255;
    else {
      const t = smoothstep((d - threshold) / (opaque - threshold));
      alpha = Math.round(t * 255);
    }
    out.data[o + 3] = alpha;

    // Despill/unblend antialias pixels so transparent edges do not retain background color.
    const a = alpha / 255;
    if (a > 0.05 && a < 0.98) {
      for (let k = 0; k < 3; k++) {
        out.data[o + k] = clamp(Math.round((out.data[o + k] - bgColor[k] * (1 - a)) / a), 0, 255);
      }
    }
  }

  if (edgeContract > 0) erodeAlpha(out, edgeContract);
  if (edgeFeather > 0) blurAlpha(out, edgeFeather);
  return { image: out, bgColor };
}

export function resizeBilinear(img, scale) {
  if (scale === 1) return clonePng(img);
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const out = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    const sy = height === 1 ? 0 : (y * (img.height - 1)) / (height - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = width === 1 ? 0 : (x * (img.width - 1)) / (width - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const tx = sx - x0;
      const o = (width * y + x) << 2;
      for (let k = 0; k < 4; k++) {
        const p00 = img.data[((img.width * y0 + x0) << 2) + k];
        const p10 = img.data[((img.width * y0 + x1) << 2) + k];
        const p01 = img.data[((img.width * y1 + x0) << 2) + k];
        const p11 = img.data[((img.width * y1 + x1) << 2) + k];
        const top = p00 * (1 - tx) + p10 * tx;
        const bot = p01 * (1 - tx) + p11 * tx;
        out.data[o + k] = Math.round(top * (1 - ty) + bot * ty);
      }
    }
  }
  return out;
}

export function sharpen(img, amount = 0.35) {
  if (!amount || amount <= 0) return img;
  const out = clonePng(img);
  const blur = boxBlurRgb(img, 1);
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i << 2;
    for (let k = 0; k < 3; k++) {
      const v = img.data[o + k] + (img.data[o + k] - blur.data[o + k]) * amount;
      out.data[o + k] = clamp(Math.round(v), 0, 255);
    }
  }
  return out;
}

function crop(img, rect) {
  const x = clamp(rect.x, 0, img.width);
  const y = clamp(rect.y, 0, img.height);
  const width = clamp(rect.width, 1, img.width - x);
  const height = clamp(rect.height, 1, img.height - y);
  const out = new PNG({ width, height });
  PNG.bitblt(img, out, x, y, width, height, 0, 0);
  return out;
}

function checkerboardComposite(icon) {
  const out = new PNG({ width: icon.width, height: icon.height });
  const cell = Math.max(4, Math.round(Math.min(icon.width, icon.height) / 8));
  for (let y = 0; y < icon.height; y++) {
    for (let x = 0; x < icon.width; x++) {
      const dark = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const bg = dark ? 210 : 245;
      const o = (icon.width * y + x) << 2;
      const a = icon.data[o + 3] / 255;
      out.data[o] = Math.round(bg * (1 - a) + icon.data[o] * a);
      out.data[o + 1] = Math.round(bg * (1 - a) + icon.data[o + 1] * a);
      out.data[o + 2] = Math.round(bg * (1 - a) + icon.data[o + 2] * a);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

function alphaMask(icon) {
  const out = new PNG({ width: icon.width, height: icon.height });
  for (let i = 0; i < icon.width * icon.height; i++) {
    const alpha = icon.data[(i << 2) + 3];
    const o = i << 2;
    out.data[o] = alpha;
    out.data[o + 1] = alpha;
    out.data[o + 2] = alpha;
    out.data[o + 3] = 255;
  }
  return out;
}

function boxBlurRgb(img, radius) {
  const out = clonePng(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sum = [0, 0, 0];
      let n = 0;
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const xx = clamp(x + ox, 0, img.width - 1);
          const yy = clamp(y + oy, 0, img.height - 1);
          const o = (img.width * yy + xx) << 2;
          sum[0] += img.data[o];
          sum[1] += img.data[o + 1];
          sum[2] += img.data[o + 2];
          n++;
        }
      }
      const o = (img.width * y + x) << 2;
      out.data[o] = Math.round(sum[0] / n);
      out.data[o + 1] = Math.round(sum[1] / n);
      out.data[o + 2] = Math.round(sum[2] / n);
    }
  }
  return out;
}

function erodeAlpha(img, radius) {
  const src = new Uint8Array(img.width * img.height);
  for (let i = 0; i < src.length; i++) src[i] = img.data[(i << 2) + 3];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let min = 255;
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const xx = clamp(x + ox, 0, img.width - 1);
          const yy = clamp(y + oy, 0, img.height - 1);
          min = Math.min(min, src[img.width * yy + xx]);
        }
      }
      img.data[((img.width * y + x) << 2) + 3] = min;
    }
  }
}

function blurAlpha(img, radius) {
  const src = new Uint8Array(img.width * img.height);
  for (let i = 0; i < src.length; i++) src[i] = img.data[(i << 2) + 3];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      let sum = 0;
      let n = 0;
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const xx = clamp(x + ox, 0, img.width - 1);
          const yy = clamp(y + oy, 0, img.height - 1);
          sum += src[img.width * yy + xx];
          n++;
        }
      }
      img.data[((img.width * y + x) << 2) + 3] = Math.round(sum / n);
    }
  }
}

function clonePng(img) {
  const out = new PNG({ width: img.width, height: img.height });
  out.data.set(img.data);
  return out;
}

function locateSource(name, explicitSource) {
  const candidates = explicitSource
    ? [resolve(ROOT, explicitSource)]
    : [
        join(ROOT, 'output', name, 'design.png'),
        join(ROOT, 'designs', `${name}.png`),
      ];
  const hit = candidates.find((path) => existsSync(path));
  if (!hit) throw new Error(`找不到 PNG 源图;先运行 npm run verify ${name},或用 --source 指定 PNG`);
  return hit;
}

function outputName(id, scale, suffix = '') {
  const scalePart = scale === 1 ? '' : `@${scale}x`;
  return `${id}${scalePart}${suffix}.png`;
}

function extractOne(name, job) {
  const sourcePath = locateSource(name, job.source);
  const src = PNG.sync.read(readFileSync(sourcePath));
  const cropImg = crop(src, job.rect);
  const bg = parseColor(job.bg);
  const outDir = resolve(ROOT, job.out || join('pages', name, 'assets'));
  const reportDir = join(ROOT, 'output', name, 'assets');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(reportDir, { recursive: true });

  writeFileSync(join(reportDir, outputName(job.id, 1, '-crop')), PNG.sync.write(cropImg));

  const outputs = [];
  for (const scale of job.scales) {
    const scaled = resizeBilinear(cropImg, scale);
    const enhanced = sharpen(scaled, job.sharpen);
    const { image, bgColor } = removeBackground(enhanced, {
      bg,
      threshold: job.threshold,
      opaque: job.opaque,
      edgeContract: job.edgeContract,
      edgeFeather: job.edgeFeather,
    });
    const file = outputName(job.id, scale);
    writeFileSync(join(outDir, file), PNG.sync.write(image));
    writeFileSync(join(reportDir, outputName(job.id, scale, '-mask')), PNG.sync.write(alphaMask(image)));
    writeFileSync(join(reportDir, outputName(job.id, scale, '-check')), PNG.sync.write(checkerboardComposite(image)));
    outputs.push({ file: join(outDir, file), scale, width: image.width, height: image.height, bgColor });
  }

  for (const item of outputs) {
    const bgLabel = item.bgColor ? `bg rgb(${item.bgColor.join(',')})` : 'bg none';
    console.log(`✓ ${item.file} ${item.width}×${item.height} ${bgLabel}`);
  }
  console.log(`检查图: output/${name}/assets/${job.id}*-check.png`);
}

function loadIconJobs(args) {
  if (args.id) return [{
    id: args.id,
    rect: args.rect,
    bg: args.bg,
    scales: args.scales,
    threshold: args.threshold,
    opaque: args.opaque,
    sharpen: args.sharpen,
    edgeContract: args.edgeContract,
    edgeFeather: args.edgeFeather,
    out: args.out,
    source: args.source,
  }];

  const planPath = args.plan
    ? resolve(ROOT, args.plan)
    : join(ROOT, 'pages', args.name, 'asset-plan.json');
  if (!existsSync(planPath)) usage();
  const rawPlan = JSON.parse(readFileSync(planPath, 'utf8'));
  const jobs = iconJobsFromPlan(rawPlan, args);
  if (!jobs.length) throw new Error(`${planPath} 没有 icons[]; 单个图标请传 --id 和 --rect`);
  return jobs;
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  for (const job of loadIconJobs(args)) extractOne(args.name, job);
}

function colorDistance(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function smoothstep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
