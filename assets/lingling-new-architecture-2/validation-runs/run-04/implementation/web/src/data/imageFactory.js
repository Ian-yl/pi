function encode(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const palette = {
  product: {
    bgA: "#f2ede5",
    bgB: "#ffffff",
    main: "#a9bdca",
    deep: "#688293",
    accent: "#7d8b74",
    text: "#4d5561",
  },
  tryon: {
    bgA: "#f2eee9",
    bgB: "#fbfbfb",
    main: "#c7d5e4",
    deep: "#8fa3b8",
    accent: "#6f8195",
    text: "#4b5563",
  },
  marketing: {
    bgA: "#edf5df",
    bgB: "#fff8df",
    main: "#d7ddb0",
    deep: "#8ea05e",
    accent: "#6d7e46",
    text: "#607040",
  },
  assets: {
    bgA: "#f7efe5",
    bgB: "#ffffff",
    main: "#f3ead8",
    deep: "#8d6844",
    accent: "#d6452d",
    text: "#62472e",
  },
};

function productSvg(width, height, kind, label) {
  const colors = palette[kind] ?? palette.product;
  const isPoster = label.includes("海报") || label.includes("图");
  const headline =
    kind === "marketing"
      ? "72小时持久留香"
      : kind === "assets"
        ? "自在生活 轻盈出行"
        : kind === "tryon"
          ? "柔软廓形 上身自然"
          : "雾感质地 长效锁温";
  return encode(`
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
        <stop stop-color="${colors.bgA}"/>
        <stop offset="1" stop-color="${colors.bgB}"/>
      </linearGradient>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#806e58" flood-opacity=".20"/>
      </filter>
      <linearGradient id="main" x1="0" x2="1">
        <stop stop-color="${colors.main}"/>
        <stop offset="1" stop-color="#ffffff"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" rx="${Math.max(12, width * 0.025)}" fill="url(#bg)"/>
    <circle cx="${width * 0.14}" cy="${height * 0.18}" r="${width * 0.12}" fill="#fff" opacity=".35"/>
    <circle cx="${width * 0.88}" cy="${height * 0.22}" r="${width * 0.1}" fill="${colors.accent}" opacity=".13"/>
    <path d="M0 ${height * 0.78} C ${width * 0.25} ${height * 0.65}, ${width * 0.55} ${height * 0.93}, ${width} ${height * 0.74} L ${width} ${height} L 0 ${height} Z" fill="#fff" opacity=".48"/>
    ${
      kind === "tryon"
        ? `<g filter="url(#shadow)" transform="translate(${width * 0.52} ${height * 0.11})">
          <path d="M${-width * 0.12},${height * 0.08} C${-width * 0.21},${height * 0.18} ${-width * 0.2},${height * 0.37} ${-width * 0.16},${height * 0.55} L${width * 0.13},${height * 0.55} C${width * 0.19},${height * 0.36} ${width * 0.19},${height * 0.19} ${width * 0.11},${height * 0.08} Z" fill="url(#main)"/>
          <circle cx="0" cy="${height * 0.02}" r="${width * 0.055}" fill="#d7b49d"/>
          <path d="M${-width * 0.07},${height * 0.05} C${-width * 0.03},${height * 0.09} ${width * 0.04},${height * 0.09} ${width * 0.08},${height * 0.05}" stroke="${colors.deep}" stroke-width="${width * 0.012}" fill="none"/>
          <path d="M${-width * 0.08},${height * 0.56} L${-width * 0.03},${height * 0.86} M${width * 0.08},${height * 0.56} L${width * 0.13},${height * 0.86}" stroke="#f6eee7" stroke-width="${width * 0.05}" stroke-linecap="round"/>
        </g>`
        : kind === "assets"
          ? `<g filter="url(#shadow)">
            <path d="M${width * 0.63},${height * 0.15} c${width * 0.05},0 ${width * 0.11},${height * 0.04} ${width * 0.11},${height * 0.1} v${height * 0.48} c0,${height * 0.1} -${width * 0.09},${height * 0.16} -${width * 0.2},${height * 0.14} l-${width * 0.16},-${height * 0.02} c-${width * 0.08},-${height * 0.01} -${width * 0.12},-${height * 0.07} -${width * 0.09},-${height * 0.14} l${width * 0.08},-${height * 0.44} c${width * 0.02},-${height * 0.08} ${width * 0.11},-${height * 0.13} ${width * 0.19},-${height * 0.13} z" fill="url(#main)"/>
            <path d="M${width * 0.5},${height * 0.18} C${width * 0.57},${height * 0.07} ${width * 0.69},${height * 0.08} ${width * 0.75},${height * 0.18}" fill="none" stroke="#a66f42" stroke-width="${width * 0.012}"/>
          </g>`
          : `<g filter="url(#shadow)" transform="translate(${width * 0.58} ${height * 0.22})">
            <rect x="${-width * 0.08}" y="0" width="${width * 0.16}" height="${height * 0.48}" rx="${width * 0.045}" fill="url(#main)"/>
            <rect x="${-width * 0.075}" y="${-height * 0.05}" width="${width * 0.15}" height="${height * 0.1}" rx="${width * 0.035}" fill="${colors.main}"/>
            <path d="M${width * 0.08},${height * 0.13} C${width * 0.22},${height * 0.13} ${width * 0.22},${height * 0.38} ${width * 0.08},${height * 0.38}" fill="none" stroke="${colors.deep}" stroke-width="${width * 0.035}" stroke-linecap="round"/>
            <text y="${height * 0.4}" text-anchor="middle" transform="rotate(90)" font-size="${Math.max(10, width * 0.035)}" fill="#fff" font-family="sans-serif">LING</text>
          </g>`
    }
    ${
      isPoster
        ? `<g transform="translate(${width * 0.08} ${height * 0.13})">
          <text x="0" y="0" font-size="${Math.max(18, width * 0.06)}" font-weight="700" fill="${colors.text}" font-family="sans-serif">${headline}</text>
          <text x="0" y="${height * 0.09}" font-size="${Math.max(12, width * 0.03)}" fill="${colors.text}" opacity=".78" font-family="sans-serif">电商视觉生成样张</text>
          <rect x="0" y="${height * 0.15}" width="${width * 0.22}" height="${height * 0.04}" rx="99" fill="${colors.accent}" opacity=".85"/>
        </g>`
        : ""
    }
    <text x="${width * 0.07}" y="${height * 0.92}" font-size="${Math.max(12, width * 0.035)}" fill="${colors.text}" opacity=".82" font-family="sans-serif">${label}</text>
  </svg>`);
}

export function makeImage(kind, label, size = "large") {
  if (size === "thumb") return productSvg(260, 170, kind, label);
  if (size === "square") return productSvg(220, 220, kind, label);
  if (kind === "tryon") return productSvg(880, 560, kind, label);
  if (kind === "marketing") return productSvg(900, 560, kind, label);
  if (kind === "assets") return productSvg(900, 620, kind, label);
  return productSvg(900, 610, kind, label);
}

export function fileToPreview(file) {
  return {
    id: `${file.name}-${file.lastModified}-${file.size}`,
    name: file.name,
    url: URL.createObjectURL(file),
    source: "upload",
    file,
  };
}
