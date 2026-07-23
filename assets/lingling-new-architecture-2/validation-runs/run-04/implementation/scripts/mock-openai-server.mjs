#!/usr/bin/env node
import http from 'node:http';

const host = process.env.MOCK_OPENAI_HOST || '127.0.0.1';
const port = Number(process.env.MOCK_OPENAI_PORT || 4934);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    return json(res, 200, { data: [{ id: 'demo-chat' }, { id: 'demo-image' }] });
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    await drain(req);
    return json(res, 200, { choices: [{ message: { content: '突出商品材质、使用场景与核心卖点，画面保持真实、清晰并留出营销文案空间。' } }] });
  }
  if (req.method === 'POST' && ['/v1/images/generations', '/v1/images/edits'].includes(req.url)) {
    await drain(req);
    return json(res, 200, { data: [{ b64_json: png }] });
  }
  return json(res, 404, { error: { message: 'unknown mock provider route' } });
});

server.listen(port, host, () => console.log(`Mock OpenAI provider listening at http://${host}:${port}`));

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function drain(req) { return new Promise((resolve, reject) => { req.on('data', () => {}); req.on('end', resolve); req.on('error', reject); }); }
