export function primarySubmitControls(spec, inventory, interactions) {
  const declared = new Set((spec?.capabilities || []).flatMap((capability) => capability.aggregateSubmission?.triggerControlId ? [`${capability.pageIds?.[0]}:${capability.aggregateSubmission.triggerControlId}`] : []));
  const interactionItems = interactions?.interactions || [];
  const result = [];
  for (const page of inventory?.pages || []) for (const control of page.controls || []) {
    const key = `${page.pageId}:${control.controlId}`;
    const observed = interactionItems.find((item) => item.pageId === page.pageId && item.controlId === control.controlId && item.submissionRole === 'primary-submit');
    if (control.submissionRole !== 'primary-submit' && !observed && !declared.has(key)) continue;
    result.push({ ...control, pageId: page.pageId, observedInteraction: observed || null });
  }
  return result;
}

export function primarySubmitFindings(spec, inventory, interactions, controlMap) {
  const findings = [];
  const capabilities = new Map((spec?.capabilities || []).map((item) => [item.id, item]));
  for (const capability of capabilities.values()) if (capability.aggregateSubmission?.status === 'complete') {
    const pageId = capability.pageIds?.[0]; const controlId = capability.aggregateSubmission.triggerControlId;
    const exists = (inventory?.pages || []).find((item) => item.pageId === pageId)?.controls?.some((item) => item.controlId === controlId);
    if (!exists) findings.push(`aggregate capability ${capability.id} primary submit control is absent from the frontend release: ${pageId}:${controlId}`);
  }
  for (const control of primarySubmitControls(spec, inventory, interactions)) {
    const label = `${control.pageId}:${control.controlId}`;
    if (['navigation', 'history-entry'].includes(control.semanticRole) || ['navigation', 'history'].includes(control.region?.semanticRole)) findings.push(`primary submit control ${label} is a navigation or history control`);
    const mappings = (controlMap?.mappings || []).filter((item) => item.pageId === control.pageId && item.controlId === control.controlId);
    if (mappings.length !== 1) { findings.push(`primary submit control ${label} must have exactly one control-capability mapping`); continue; }
    const mapping = mappings[0]; const capability = capabilities.get(mapping.capabilityId);
    if (!capability) { findings.push(`primary submit control ${label} maps to an unknown capability`); continue; }
    const operationId = mapping.primaryOperationId || capability.presentation?.primaryOperationId;
    const operation = (capability.operations || []).find((item) => item.id === operationId);
    if (!operationId || !operation) { findings.push(`primary submit control ${label} has no valid primary operation`); continue; }
    if (capability.presentation?.primaryOperationId !== operationId) findings.push(`primary submit control ${label} mapping differs from the capability primary operation`);
    if (String(operation.method).toUpperCase() !== 'POST') findings.push(`primary submit control ${label} primary operation must use POST`);
    const schemaFields = new Set(Object.keys(operation.request?.bodySchema?.properties || {}));
    for (const field of scopedInputFields(control, inventory, interactions)) if (!schemaFields.has(field)) findings.push(`primary submit operation ${operation.id} omits page input field ${field}`);
    if (!hasBusinessResult(operation) || !capability.resultPresentation) findings.push(`primary submit operation ${operation.id} has no business result contract`);
  }
  return findings;
}

function scopedInputFields(control, inventory, interactions) {
  const page = (inventory?.pages || []).find((item) => item.pageId === control.pageId);
  const fields = new Set();
  for (const item of page?.controls || []) {
    if (!['input', 'textarea', 'select', 'checkbox', 'radio', 'file'].includes(item.kind)) continue;
    const sameScope = control.submissionScopeId && item.submissionScopeId === control.submissionScopeId;
    const sameForm = control.formId && item.formId === control.formId;
    if (sameScope || sameForm) fields.add(item.fieldName || item.controlId);
  }
  for (const interaction of interactions?.interactions || []) if (interaction.pageId === control.pageId && interaction.controlId === control.controlId && interaction.submissionRole === 'primary-submit') for (const field of interaction.network?.requestFields || []) fields.add(field);
  return fields;
}
function hasBusinessResult(operation) { return operation.response?.bodySchema?.type === 'object' && Object.keys(operation.response.bodySchema.properties || {}).length > 0; }
