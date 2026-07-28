// Control-disposition ledger gates (schema 2.3). The ledger accounts for every interaction control the
// release exposes. Validate proves its completeness against the release inventory and each disposition's
// structural obligations — it never judges whether a disposition is honest (that is the reviewer's role),
// and it never infers a disposition: the author decides, the ledger records, the gate checks structure.
const DISPOSITIONS = new Set(['primary-trigger', 'input', 'secondary-action', 'navigation', 'presentation-only', 'ignored-with-reason']);
const NAV_ROLES = new Set(['navigation', 'history-entry', 'menu', 'history']);

export function controlDispositionFindings(ledgerDoc, spec, inventory, controlMap, interactions) {
  const findings = [];
  const inventoryControls = new Map();
  for (const page of inventory?.pages || []) for (const control of page.controls || []) inventoryControls.set(`${page.pageId}:${control.controlId}`, { ...control, pageId: page.pageId });
  const capabilities = new Map((spec?.capabilities || []).map((cap) => [cap.id, cap]));
  const operationsById = new Map((spec?.capabilities || []).flatMap((cap) => (cap.operations || []).map((operation) => [operation.id, { operation, capability: cap }])));

  // Gate 10: the ledger is bound to the same immutable release as the semantic inventory.
  if (!ledgerDoc || ledgerDoc.releaseDigest !== inventory?.release?.releaseDigest) findings.push('control-dispositions.json is not bound to the release digest of the semantic inventory');

  const seen = new Set();
  const triggeredOperations = new Set();
  for (const entry of ledgerDoc?.dispositions || []) {
    const key = `${entry.pageId}:${entry.controlId}`;
    if (seen.has(key)) findings.push(`control-dispositions has a duplicate entry for control ${key}`);
    seen.add(key);
    if (!inventoryControls.has(key)) { findings.push(`control-dispositions entry references a control absent from the release inventory: ${key}`); continue; }
    if (!DISPOSITIONS.has(entry.disposition)) { findings.push(`control ${key} has an unresolved or invalid disposition: ${entry.disposition}`); continue; }
    const control = inventoryControls.get(key);
    const navControl = NAV_ROLES.has(String(control.semanticRole || '').toLowerCase()) || String(control.kind || '').toLowerCase() === 'link';

    if (entry.disposition === 'primary-trigger') {
      const capability = capabilities.get(entry.capabilityId);
      if (!capability) { findings.push(`primary-trigger control ${key} names an unknown capability: ${entry.capabilityId}`); continue; }
      const operation = (capability.operations || []).find((item) => item.id === entry.operationId);
      if (!entry.operationId || !operation) findings.push(`primary-trigger control ${key} names an operation that is not on capability ${entry.capabilityId}: ${entry.operationId}`);
      else triggeredOperations.add(entry.operationId);
      // Structural check only: a primary trigger must be an actionable control — a button, a native submit,
      // or a control the release marks primary-submit — never a plain text/selection input or a label. Whether
      // it is the honest trigger of this closure is the reviewer's judgment; aggregate-submit evidence is
      // enforced separately by primarySubmitFindings. Labels and DOM proximity never make a control a trigger.
      const actionable = ['button'].includes(String(control.kind || '').toLowerCase()) || String(control.nativeType || '').toLowerCase() === 'submit' || control.submissionRole === 'primary-submit';
      if (!actionable) findings.push(`primary-trigger control ${key} is not an actionable control (a text or selection input can never be a primary trigger)`);
      // A main button is never a navigation or history control.
      if (navControl) findings.push(`primary-trigger control ${key} is a navigation or history control and cannot submit a business operation`);
      // The trigger is mirrored in control-capability-map (the handoff-facing artifact PI consumes).
      if (!(controlMap?.mappings || []).some((item) => item.capabilityId === entry.capabilityId && item.controlId === entry.controlId)) findings.push(`primary-trigger control ${key} is not mirrored in control-capability-map for capability ${entry.capabilityId}`);
    } else if (entry.disposition === 'input') {
      if (!capabilities.get(entry.capabilityId)) findings.push(`input control ${key} names an unknown capability: ${entry.capabilityId}`);
      if (entry.operationId) findings.push(`input control ${key} must not name an operation`);
    } else if (entry.disposition === 'secondary-action') {
      if (!capabilities.get(entry.capabilityId)) findings.push(`secondary-action control ${key} names an unknown capability: ${entry.capabilityId}`);
      if (entry.operationId) { if (!operationsById.has(entry.operationId)) findings.push(`secondary-action control ${key} names an unknown operation: ${entry.operationId}`); else triggeredOperations.add(entry.operationId); }
    } else if (entry.disposition === 'navigation' || entry.disposition === 'presentation-only') {
      if (entry.capabilityId || entry.operationId) findings.push(`${entry.disposition} control ${key} must not bind a capability or operation (a navigation control can never carry a state-writing operation)`);
    } else if (entry.disposition === 'ignored-with-reason') {
      if (!String(entry.rationale || '').trim()) findings.push(`ignored-with-reason control ${key} lacks a rationale`);
    }
  }

  // Gate 1: every release control is accounted for by exactly one ledger entry.
  for (const key of inventoryControls.keys()) if (!seen.has(key)) findings.push(`release control ${key} has no control-disposition entry (every interaction control must be accounted for)`);

  // Gate 3: every operation has a trigger source — a control disposition names it, or the operation declares
  // an explicit system/data-dependency trigger with a reason, or its capability is headless (no UI landing).
  for (const [operationId, { operation, capability }] of operationsById) {
    if (triggeredOperations.has(operationId)) continue;
    if (capability.presentation?.mode === 'headless') continue;
    if (operation.resourceTransfer?.interaction === 'file-selection') continue; // the file-selection browser action is itself the observable trigger
    const trigger = operation.trigger;
    if (!trigger || !['system', 'data-dependency'].includes(trigger.kind)) findings.push(`operation ${operationId} has no trigger source: no control disposition names it and it declares no system or data-dependency trigger`);
    else if (!String(trigger.reason || '').trim()) findings.push(`operation ${operationId} ${trigger.kind} trigger lacks a reason`);
  }
  return findings;
}
