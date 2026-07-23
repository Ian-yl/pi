// 极简静态服务器:verify.mjs 截图时内部使用;`npm run serve` 可独立启动手动预览。
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

export function startServer(root, port = 0) {
  return new Promise((done, fail) => {
    const server = createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = normalize(join(root, pathname));
        if (!file.startsWith(root + sep) && file !== root) {
          res.writeHead(403).end('forbidden');
          return;
        }
        const info = await stat(file).catch(() => null);
        if (info?.isDirectory()) {
          const index = join(file, 'index.html');
          const hasIndex = await stat(index).catch(() => null);
          if (hasIndex) {
            res.writeHead(200, { 'content-type': MIME['.html'] });
            res.end(await readFile(index));
          } else {
            const entries = await readdir(file);
            const base = pathname.endsWith('/') ? pathname : pathname + '/';
            const links = entries
              .map((e) => `<li><a href="${base}${e}">${e}</a></li>`)
              .join('\n');
            res.writeHead(200, { 'content-type': MIME['.html'] });
            res.end(`<!doctype html><meta charset="utf-8"><title>${pathname}</title><h1>${pathname}</h1><ul>${links}</ul>`);
          }
          return;
        }
        const buf = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
        res.end(buf);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', fail);
      done({ server, port: server.address().port });
    });
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const ROOT = resolve(process.env.VISUAL_RESTORE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  // 从 4820 起逐个尝试,被占用则自动 +1
  let started = null;
  for (let p = 4820; p < 4830 && !started; p++) {
    started = await startServer(ROOT, p).catch((e) => {
      if (e.code === 'EADDRINUSE') return null;
      throw e;
    });
  }
  if (!started) {
    console.error('4820-4829 端口均被占用,请手动释放后重试');
    process.exit(1);
  }
  console.log(`▶ 预览服务已启动: http://127.0.0.1:${started.port}/`);
  console.log(`  页面预览:   http://127.0.0.1:${started.port}/pages/`);
  console.log(`  验证报告:   http://127.0.0.1:${started.port}/output/launchpad/report.html`);
  console.log(`  (Ctrl+C 退出)`);
}
