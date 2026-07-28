import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { observedRequestValueDigests } from '../scripts/lib/request-observation.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('ingress observation captures body, query, path, and header values under contract paths', () => {
  const values = observedRequestValueDigests({ method: 'POST', url: '/resources/resource-7?locale=zh-CN', headers: { 'content-type': 'application/json', 'x-scope': 'workspace-9' } }, Buffer.from(JSON.stringify({ prompt: { text: 'unique input' } })), [{ method: 'POST', path: '/resources/{resourceId}', request: { headerSchema: { type: 'object', properties: { 'X-Scope': { type: 'string' } } } } }]);
  assert.equal(values['request.prompt.text'], digest('unique input'));
  assert.equal(values['request.query.locale'], digest('zh-CN'));
  assert.equal(values['request.path.resourceId'], digest('resource-7'));
  assert.equal(values['request.header.x-scope'], digest('workspace-9'));
  assert.equal(values['request.header.X-Scope'], digest('workspace-9'));
});

test('ingress observation captures multipart text and file fields without treating them as JSON', () => {
  const boundary = 'neutral-boundary';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nreference\r\n--${boundary}\r\nContent-Disposition: form-data; name="resource"; filename="sample.bin"\r\nContent-Type: application/octet-stream\r\n\r\nunique-bytes\r\n--${boundary}--\r\n`);
  const values = observedRequestValueDigests({ method: 'POST', url: '/resources', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }, body, [{ method: 'POST', path: '/resources' }]);
  assert.equal(values['request.purpose'], digest('reference'));
  assert.match(values['request.resource'], /^[a-f0-9]{64}$/);
});

test('the same observation paths capture provider query, header, and body targets', () => {
  const values = observedRequestValueDigests({ method: 'POST', url: '/invoke?mode=fast', headers: { 'x-provider-scope': 'scope-1', 'content-type': 'application/json' } }, Buffer.from(JSON.stringify({ input: 'resolved-value' })), [], 'provider');
  assert.equal(values['provider.input'], digest('resolved-value'));
  assert.equal(values['provider.query.mode'], digest('fast'));
  assert.equal(values['provider.header.x-provider-scope'], digest('scope-1'));
});
