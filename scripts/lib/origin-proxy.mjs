import { createHash, randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';

export function startOriginProxy({ port, targetBaseUrl }) {
  const receipts = []; const target = new URL(targetBaseUrl);
  const server = createServer((incoming, outgoing) => {
    const upstream = request(new URL(incoming.url, target), { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => {
        const body = Buffer.concat(chunks); const token = randomBytes(24).toString('hex');
        receipts.push({ token, method: incoming.method, path: new URL(incoming.url, target).pathname, status: response.statusCode, bodyDigest: bodyDigest(body) });
        const headers = { ...response.headers, 'x-pi-origin-receipt': token, 'content-length': String(body.length) }; delete headers['transfer-encoding']; delete headers.connection;
        outgoing.writeHead(response.statusCode || 502, headers); outgoing.end(body);
      });
    });
    upstream.on('error', () => { outgoing.writeHead(502); outgoing.end('upstream unavailable'); }); incoming.pipe(upstream);
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve({ receipts, close: () => new Promise((done) => server.close(done)) })); });
}

export function hasOriginReceipt(observed, receipts) {
  const token = observed?.responseHeaders?.['x-pi-origin-receipt'];
  return Boolean(token && receipts.some((item) => item.token === token && item.method === observed.method && item.path === observed.path && item.status === observed.status && item.bodyDigest === bodyDigest(Buffer.from(JSON.stringify(observed.responseBody ?? null)))));
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function bodyDigest(value) { try { return sha(Buffer.from(JSON.stringify(JSON.parse(Buffer.from(value).toString('utf8'))))); } catch { return sha(value); } }
