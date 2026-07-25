import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { networkInterceptionFindings } from '../scripts/lib/network-integrity.mjs';
import { hasOriginReceipt } from '../scripts/lib/origin-proxy.mjs';

test('browser network integrity rejects routing, HAR, and fulfilled responses for the whole session', () => {
  for (const method of ['route', 'routeFromHAR', 'fulfill', 'abort', 'continue', 'fallback', 'intercept', 'mock']) {
    const findings = networkInterceptionFindings([{ type: 'before', class: method === 'fulfill' ? 'Route' : 'BrowserContext', method }]);
    assert.ok(findings.length, method);
  }
});

test('browser network integrity rejects common source-level interception even when trace omits registration', () => {
  for (const source of [
    `await page.route('**/api/**', route => route.fulfill({ status: 200, body: '{}' }));`,
    `await context.routeFromHAR('fixtures.har');`,
    `await page['route']('**/*', handler);`,
  ]) assert.ok(networkInterceptionFindings([], [source]).length, source);
});

test('ordinary browser requests and response observation are not network interception', () => {
  const events = [{ type: 'before', class: 'Page', method: 'goto' }, { type: 'before', class: 'Locator', method: 'click' }, { type: 'before', class: 'Page', method: 'waitForResponse' }];
  assert.deepEqual(networkInterceptionFindings(events, [`page.on('response', response => observed.push(response.status()));`]), []);
});

test('runner-owned origin receipts prove application responses independently of dynamic browser calls', () => {
  const response = { method: 'POST', path: '/api/submissions', status: 201, responseHeaders: { 'x-pi-origin-receipt': 'runner-secret' }, responseBody: { id: 'runtime-1' } };
  const bodyDigest = createHash('sha256').update(JSON.stringify(response.responseBody)).digest('hex');
  assert.equal(hasOriginReceipt(response, [{ token: 'runner-secret', method: 'POST', path: '/api/submissions', status: 201, bodyDigest }]), true);
  assert.equal(hasOriginReceipt({ ...response, responseHeaders: {} }, [{ token: 'runner-secret', method: 'POST', path: '/api/submissions', status: 201, bodyDigest }]), false);
  assert.equal(hasOriginReceipt({ ...response, responseHeaders: { 'x-pi-origin-receipt': 'forged' } }, [{ token: 'runner-secret', method: 'POST', path: '/api/submissions', status: 201, bodyDigest }]), false);
  const dynamicBypassSource = `const method = ['ro', 'ute'].join(''); await page[method]('**/api/**', handler);`;
  assert.equal(hasOriginReceipt({ ...response, responseHeaders: {} }, []), false, dynamicBypassSource);
});
