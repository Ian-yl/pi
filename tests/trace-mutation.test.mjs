import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPostOperationTestDomMutation } from '../scripts/lib/trace-mutation.mjs';

const observerSource = 'elements => elements.map(element => element.textContent)';

test('declared input edits before the business operation do not invalidate result evidence', () => {
  const events = [
    before('fill-input', 'fill', 10, '[data-domain-input-id="prompt"]'),
    before('select-input', 'selectOption', 20, '[data-domain-input-id="ratio"]'),
    before('submit', 'click', 30, '[data-primary-operation-id="create"]'),
    before('observer', 'evaluateAll', 40, '[data-result-binding-id="result"]', observerSource),
  ];
  assert.equal(hasPostOperationTestDomMutation(events, { operationStart: 30, actionCallId: 'submit', observerSource }), false);
});

test('test-authored edits after the business operation invalidate result evidence', () => {
  for (const method of ['fill', 'type', 'press', 'selectOption', 'check', 'setInputFiles', 'insertText', 'click', 'dblclick', 'tap', 'evaluate', 'waitForFunction', 'unknownFutureMethod']) {
    const events = [before('submit', 'click', 30, 'button'), before('forged-result', method, 35, '[data-result-binding-id="result"]')];
    assert.equal(hasPostOperationTestDomMutation(events, { operationStart: 30, actionCallId: 'submit', observerSource }), true, method);
  }
});

test('post-operation allowlist accepts only passive reads, screenshots, and non-script waits', () => {
  for (const method of ['screenshot', 'content', 'queryCount', 'isVisible', 'isEnabled', 'getAttribute', 'innerText', 'waitForSelector', 'waitForTimeout']) {
    const events = [before('submit', 'click', 30, 'button'), before(`safe-${method}`, method, 35, '[data-result-binding-id="result"]')];
    assert.equal(hasPostOperationTestDomMutation(events, { operationStart: 30, actionCallId: 'submit', observerSource }), false, method);
  }
});

function before(callId, method, startTime, selector, expression) { return { type: 'before', callId, method, startTime, params: { selector, ...(expression ? { expression } : {}) } }; }
