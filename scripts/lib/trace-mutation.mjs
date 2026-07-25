const SAFE_POST_OPERATION_METHODS = new Set([
  'screenshot', 'content', 'queryCount', 'count', 'isVisible', 'isHidden', 'isEnabled',
  'isDisabled', 'isEditable', 'isChecked', 'getAttribute', 'innerText', 'textContent',
  'inputValue', 'allInnerTexts', 'allTextContents', 'waitForSelector', 'waitForTimeout',
]);

export function hasPostOperationTestDomMutation(events, { operationStart, actionCallId, observerSource }) {
  return events.some((event) => {
    if (event.type !== 'before' || event.callId === actionCallId || eventTime(event) < operationStart) return false;
    if (event.params?.selector && ['evalOnSelectorAll', 'evaluateAll'].includes(event.method) && normalizeSource(event.params?.expression) === normalizeSource(observerSource)) return false;
    return !SAFE_POST_OPERATION_METHODS.has(event.method);
  });
}

function eventTime(event) { return Number(event.startTime ?? event.endTime ?? event.time ?? event.snapshot?.timestamp ?? -1); }
function normalizeSource(value) { return String(value || '').replace(/\s+/g, ' ').trim().replace(/;\s*}/g, ' }'); }
