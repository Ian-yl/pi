import pixelmatch from 'pixelmatch';

export function isRedDiffPixel(data, offset) {
  return data[offset] > 180 && data[offset + 1] < 120 && data[offset + 2] < 120 && data[offset + 3] > 0;
}

export function parseRegions(spec) {
  if (!spec || !spec.trim()) return [];
  return spec
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawName, rawNums] = part.split(':');
      if (!rawName || !rawNums) throw new Error(`区域格式错误: ${part}`);
      const nums = rawNums.split(',').map((n) => Number(n.trim()));
      if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
        throw new Error(`区域坐标必须是 x,y,w,h: ${part}`);
      }
      return {
        name: rawName.trim(),
        x: nums[0],
        y: nums[1],
        width: nums[2],
        height: nums[3],
      };
    });
}

export function defaultRegionsFor(width, height) {
  const tall = height / width > 1.45;
  if (tall) {
    return [
      rect('Header', width, height, 0, 0, 1, 0.07),
      rect('Hero', width, height, 0, 0.07, 1, 0.13),
      rect('Form', width, height, 0, 0.20, 1, 0.46),
      rect('Plan', width, height, 0, 0.66, 1, 0.18),
      rect('Login', width, height, 0, 0.84, 1, 0.06),
      rect('TabBar', width, height, 0, 0.90, 1, 0.10),
    ];
  }

  return [
    rect('Header', width, height, 0, 0, 1, 0.10),
    rect('Sidebar', width, height, 0, 0, 0.16, 1),
    rect('Hero', width, height, 0.16, 0.10, 0.84, 0.28),
    rect('Main', width, height, 0.16, 0.38, 0.84, 0.46),
    rect('Footer', width, height, 0.16, 0.84, 0.84, 0.16),
  ];
}

function rect(name, width, height, x, y, w, h) {
  return {
    name,
    x: Math.round(width * x),
    y: Math.round(height * y),
    width: Math.round(width * w),
    height: Math.round(height * h),
  };
}

export function connectedDiffComponents(diff, { minPixels = 30 } = {}) {
  const { width, height, data } = diff;
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const components = [];

  const isDiffAt = (idx) => isRedDiffPixel(data, idx << 2);

  for (let idx = 0; idx < width * height; idx++) {
    if (seen[idx] || !isDiffAt(idx)) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = idx;
    seen[idx] = 1;

    let count = 0;
    let minX = idx % width;
    let maxX = minX;
    let minY = Math.floor(idx / width);
    let maxY = minY;

    while (head < tail) {
      const p = queue[head++];
      const x = p % width;
      const y = Math.floor(p / width);
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (const n of [p + 1, p - 1, p + width, p - width]) {
        if (n < 0 || n >= width * height) continue;
        const nx = n % width;
        const ny = Math.floor(n / width);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        if (seen[n] || !isDiffAt(n)) continue;
        seen[n] = 1;
        queue[tail++] = n;
      }
    }

    if (count >= minPixels) {
      components.push({
        count,
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        x2: maxX,
        y2: maxY,
      });
    }
  }

  return components.sort((a, b) => b.count - a.count);
}

export function regionScores(design, actual, regions, { threshold = 0.1 } = {}) {
  return regions.map((region) => {
    const x1 = clamp(Math.round(region.x), 0, Math.max(design.width, actual.width));
    const y1 = clamp(Math.round(region.y), 0, Math.max(design.height, actual.height));
    const x2 = clamp(Math.round(region.x + region.width), x1, Math.max(design.width, actual.width));
    const y2 = clamp(Math.round(region.y + region.height), y1, Math.max(design.height, actual.height));
    const width = x2 - x1;
    const height = y2 - y1;
    const pixels = width * height;
    const a = cropRgba(design, x1, y1, width, height);
    const b = cropRgba(actual, x1, y1, width, height);
    const mismatch = pixelmatch(a, b, null, width, height, { threshold });

    return {
      name: region.name,
      x: x1,
      y: y1,
      width,
      height,
      pixels,
      mismatch,
      similarity: pixels ? Number((100 * (1 - mismatch / pixels)).toFixed(4)) : 100,
      diffPct: pixels ? Number(((100 * mismatch) / pixels).toFixed(4)) : 0,
    };
  });
}

export function diffCountsByRegion(diff, regions) {
  const counts = Object.fromEntries(regions.map((region) => [region.name, 0]));
  counts.Other = 0;
  let total = 0;

  for (let y = 0; y < diff.height; y++) {
    for (let x = 0; x < diff.width; x++) {
      if (!isRedDiffPixel(diff.data, (diff.width * y + x) << 2)) continue;
      total++;
      const hit = regions.find((region) => inRegion(x, y, region));
      counts[hit ? hit.name : 'Other']++;
    }
  }

  return { total, counts };
}

export function bboxByLum(img, region, lum) {
  const x1 = clamp(Math.round(region.x), 0, img.width);
  const y1 = clamp(Math.round(region.y), 0, img.height);
  const x2 = clamp(Math.round(region.x + region.width), x1, img.width);
  const y2 = clamp(Math.round(region.y + region.height), y1, img.height);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let count = 0;

  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const o = (img.width * y + x) << 2;
      if (luminance(img.data, o) <= lum) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      count++;
    }
  }

  return count
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, x2: maxX, y2: maxY, count }
    : null;
}

export function verticalHairlines(img, region) {
  const x1 = clamp(Math.round(region.x + region.width * 0.10), 0, img.width);
  const x2 = clamp(Math.round(region.x + region.width * 0.96), x1, img.width);
  const y1 = clamp(Math.round(region.y + region.height * 0.20), 0, img.height);
  const y2 = clamp(Math.round(region.y + region.height * 0.80), y1, img.height);
  const minRun = Math.max(8, Math.round((y2 - y1) * 0.68));
  const bg = medianLumCorners(img, region);
  const columns = [];

  for (let x = x1; x < x2; x++) {
    let run = 0;
    let bestRun = 0;
    for (let y = y1; y < y2; y++) {
      const o = (img.width * y + x) << 2;
      const l = luminance(img.data, o);
      const lineLike = l > bg + 6 && l < 145;
      if (lineLike) {
        run++;
        if (run > bestRun) bestRun = run;
      } else {
        run = 0;
      }
    }
    if (bestRun >= minRun) columns.push(x);
  }

  const groups = [];
  for (const x of columns) {
    const last = groups[groups.length - 1];
    if (last && x <= last.x2 + 2) {
      last.x2 = x;
      last.width = last.x2 - last.x + 1;
    } else {
      groups.push({ x, x2: x, width: 1 });
    }
  }
  return groups;
}

export function componentRegion(component, regions) {
  const cx = component.x + component.width / 2;
  const cy = component.y + component.height / 2;
  return regions.find((region) => inRegion(cx, cy, region))?.name || 'Other';
}

function cropRgba(img, x, y, width, height) {
  const out = new Uint8Array(width * height * 4);
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      const srcX = x + xx;
      const srcY = y + yy;
      const dst = (width * yy + xx) << 2;
      if (srcX >= img.width || srcY >= img.height) {
        out[dst] = 255;
        out[dst + 1] = 255;
        out[dst + 2] = 255;
        out[dst + 3] = 255;
        continue;
      }
      const src = (img.width * srcY + srcX) << 2;
      out[dst] = img.data[src];
      out[dst + 1] = img.data[src + 1];
      out[dst + 2] = img.data[src + 2];
      out[dst + 3] = img.data[src + 3];
    }
  }
  return out;
}

function luminance(data, offset) {
  return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
}

function medianLumCorners(img, region) {
  const samples = [];
  const points = [
    [0.12, 0.18],
    [0.88, 0.18],
    [0.12, 0.82],
    [0.88, 0.82],
  ];
  for (const [px, py] of points) {
    const x = clamp(Math.round(region.x + region.width * px), 0, img.width - 1);
    const y = clamp(Math.round(region.y + region.height * py), 0, img.height - 1);
    samples.push(luminance(img.data, (img.width * y + x) << 2));
  }
  samples.sort((a, b) => a - b);
  return (samples[1] + samples[2]) / 2;
}

function inRegion(x, y, region) {
  return x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
