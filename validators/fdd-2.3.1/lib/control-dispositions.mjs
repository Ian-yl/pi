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
      if (!(controlMap?.mappings || []).some((item) => item.capabilityId === entry.capabilityId && item.controlId === entry.controlId && item.primaryOperationId === entry.operationId)) findings.push(`primary-trigger control ${key} is not mirrored with the same operation in control-capability-map for capability ${entry.capabilityId}`);
    } else if (entry.disposition === 'input') {
      const capability = capabilities.get(entry.capabilityId);
      if (!capability) findings.push(`input control ${key} names an unknown capability: ${entry.capabilityId}`);
      if (entry.operationId) findings.push(`input control ${key} must not name an operation`);
      if (capability) {
        const bindings = (controlMap?.mappings || []).filter((mapping) => mapping.capabilityId === entry.capabilityId).flatMap((mapping) => (mapping.fieldBindings || []).filter((binding) => binding.controlId === entry.controlId));
        if (bindings.length !== 1) findings.push(`input control ${key} must have exactly one field binding in control-capability-map for capability ${entry.capabilityId}`);
        else {
          const binding = bindings[0];
          const operation = (capability.operations || []).find((item) => item.id === binding.operationId);
          if (!operation) findings.push(`input control ${key} field binding names an operation that is not on capability ${entry.capabilityId}: ${binding.operationId}`);
          if (!binding.inputId || !binding.statePath || !binding.requestPath) findings.push(`input control ${key} field binding lacks inputId, statePath, or requestPath`);
          else if (operation && !requestPaths(operation.request).has(binding.requestPath)) findings.push(`input control ${key} field binding request path is absent from operation ${binding.operationId}: ${binding.requestPath}`);
        }
      }
    } else if (entry.disposition === 'secondary-action') {
      const capability = capabilities.get(entry.capabilityId);
      if (!capability) findings.push(`secondary-action control ${key} names an unknown capability: ${entry.capabilityId}`);
      if (entry.operationId) { if (!(capability?.operations || []).some((item) => item.id === entry.operationId)) findings.push(`secondary-action control ${key} names an operation that is not on capability ${entry.capabilityId}: ${entry.operationId}`); else triggeredOperations.add(entry.operationId); }
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
  // Required UI request values need an authored source. Existing release controls are recorded in the
  // ledger; controls absent from the release are allowed when the FDD author explicitly designs them.
  for (const capability of capabilities.values()) {
    if (capability.specificationStatus !== 'complete' || capability.presentation?.mode === 'headless') continue;
    const mappings = (controlMap?.mappings || []).filter((item) => item.capabilityId === capability.id);
    for (const operation of capability.operations || []) {
      const dependencies = new Set((operation.dataDependencies || []).map((item) => normalizeRequestPath(item.targetField)));
      for (const requestPath of requiredRequestPaths(operation.request)) {
        if (dependencies.has(requestPath)) continue;
        const binding = mappings.flatMap((item) => item.fieldBindings || []).find((item) => item.operationId === operation.id && normalizeRequestPath(item.requestPath) === requestPath);
        if (!binding) { findings.push(`required request field ${operation.id}:${requestPath} has no authored UI or application-state binding`); continue; }
        const controlKey = `${capability.pageIds?.[0]}:${binding.controlId}`;
        if (inventoryControls.has(controlKey)) continue;
        if (binding.source === 'application-state') {
          if (!String(binding.rationale || '').trim() || !(binding.evidenceAnchors || []).length) findings.push(`application-state binding ${operation.id}:${requestPath} lacks a rationale or evidence`);
          continue;
        }
        const designed = binding.designedControl;
        if (binding.source !== 'designed-control' || !binding.controlId || !designed?.type || !designed?.label || !designed?.targetRegion) findings.push(`required request field ${operation.id}:${requestPath} is absent from the release and has no complete designed-control contract`);
      }
    }
  }
  return findings;
}

function requestPaths(request = {}) {
  const paths = new Set();
  for (const [location, schema] of [['path', request.pathSchema], ['query', request.querySchema], ['header', request.headerSchema], ['body', request.bodySchema]]) for (const path of schemaPaths(schema)) paths.add(`${location}.${path}`);
  return paths;
}
function schemaPaths(schema, prefix = '') {
  if (!schema || typeof schema !== 'object') return [];
  if (schema.type === 'object') return Object.entries(schema.properties || {}).flatMap(([key, value]) => schemaPaths(value, prefix ? `${prefix}.${key}` : key));
  return prefix ? [prefix] : [];
}
function requiredRequestPaths(request = {}) {
  const result = [];
  for (const [location, schema] of [['path', request.pathSchema], ['query', request.querySchema], ['header', request.headerSchema], ['body', request.bodySchema]]) for (const path of requiredSchemaPaths(schema)) result.push(`${location}.${path}`);
  return result;
}
function requiredSchemaPaths(schema, prefix = '', parentRequired = true) {
  if (!schema || typeof schema !== 'object' || !parentRequired) return [];
  if (schema.type !== 'object') return prefix ? [prefix] : [];
  const required = new Set(schema.required || []);
  return Object.entries(schema.properties || {}).flatMap(([key, value]) => requiredSchemaPaths(value, prefix ? `${prefix}.${key}` : key, required.has(key)));
}
function normalizeRequestPath(value) { return String(value || '').replace(/^request\./, 'body.'); }
