export function detectAggregateSubmissions({ pages, frontend, decisions = [] }) {
  const aggregates = []; const unresolved = [];
  for (const page of pages || []) {
    const pageSemantics = frontend?.inventory?.pages?.find((item) => item.pageId === page.id);
    const interactions = frontend?.interactions?.interactions?.filter((item) => item.pageId === page.id && item.network) || [];
    const declarations = declaredScopes(page, decisions);
    for (const declaration of declarations) {
      const controls = pageSemantics?.controls || [];
      const primaryControl = controls.find((item) => item.controlId === declaration.triggerControlId) || null;
      const interaction = interactions.find((item) => item.controlId === declaration.triggerControlId && sameRequest(item.network, declaration.operation)) || null;
      const requestFields = new Set(interaction?.network?.requestFields || []);
      const declaredFields = declaration.sections.flatMap((section) => section.fieldIds || []);
      const fieldControls = controls.filter((control) => declaredFields.includes(control.controlId) || declaredFields.includes(fieldKey(control)) || requestFields.has(control.controlId) || requestFields.has(fieldKey(control)));
      const sections = declaration.sections.map((section) => ({ ...section, fields: fieldControls.filter((control) => section.regionId === control.region?.id || (section.fieldIds || []).includes(control.controlId) || (section.fieldIds || []).includes(fieldKey(control))).map(toField) }));
      const coveredFieldIds = new Set(sections.flatMap((section) => section.fields.map((field) => field.id)));
      const distinctRegions = new Set(sections.filter((section) => section.fields.length).map((section) => section.regionId));
      const observedComplete = interaction && distinctRegions.size >= 2 && declaredFields.every((field) => requestFields.has(field) || [...coveredFieldIds].includes(field));
      const confirmed = declaration.evidenceStatus === 'confirmed'; const documented = declaration.evidenceStatus === 'documented';
      const relationProven = observedComplete || confirmed || documented;
      const finalProduct = normalizeFinalProduct(declaration.finalProduct, sections);
      const finalProductComplete = completeFinalProduct(finalProduct);
      const findings = [];
      if (!relationProven) findings.push(`aggregate submission ${declaration.scopeId} has no observed, documented, or confirmed cross-region submit evidence`);
      if (!finalProductComplete) findings.push(`aggregate submission ${declaration.scopeId} has incomplete final product type, quantity binding, lifecycle, or downstream usage`);
      if (finalProduct?.quantity?.sourceField && !sections.some((section) => section.fields.some((field) => field.id === finalProduct.quantity.sourceField))) findings.push(`aggregate submission ${declaration.scopeId} quantity source field is not part of the aggregate request`);
      if (sections.length < 2 || sections.some((section) => !section.fields.length)) findings.push(`aggregate submission ${declaration.scopeId} does not cover every declared form section`);
      const aggregate = { schemaVersion: '1.0', scopeId: declaration.scopeId, pageId: page.id, primaryItemId: declaration.primaryItemId, triggerControlId: declaration.triggerControlId, operation: declaration.operation || null, evidence: { status: observedComplete ? 'observed' : confirmed ? 'confirmed' : documented ? 'documented' : 'inferred', sources: [...declaration.sources, ...(interaction ? [`observed-interaction:${interaction.id}`] : [])] }, sections, sectionItemIds: declaration.sectionItemIds, finalProduct: finalProduct || null, status: findings.length ? 'planned' : 'complete', findings };
      aggregates.push(aggregate);
      for (const [index, question] of findings.entries()) unresolved.push({ id: `unresolved-aggregate-${slug(declaration.scopeId)}-${index + 1}`, severity: 'major', disposition: 'planned', status: 'open', question, relatedIds: [declaration.primaryItemId, ...declaration.sectionItemIds], sources: aggregate.evidence.sources });
    }
  }
  return { aggregates, unresolved };
}

function declaredScopes(page, decisions) {
  const modules = page.modules || []; const items = modules.flatMap((module) => (module.children || []).map((item) => ({ ...item, moduleId: module.id })));
  const scopeIds = new Set([...modules.map((item) => item.submissionScopeId), ...items.map((item) => item.submissionScopeId)].filter(Boolean));
  const result = [];
  for (const scopeId of scopeIds) {
    const primary = items.find((item) => item.submissionScopeId === scopeId && item.submissionRole === 'primary-submit');
    if (!primary) continue;
    const sectionModules = modules.filter((item) => item.submissionScopeId === scopeId && item.submissionRole === 'input-section');
    result.push({ scopeId, primaryItemId: primary.id, triggerControlId: primary.controlId || primary.aggregateSubmission?.triggerControlId, operation: primary.aggregateSubmission?.operation, sections: sectionModules.map((module) => ({ id: module.id, regionId: module.regionId, fieldIds: module.fieldIds || (module.children || []).map((item) => item.controlId || item.id) })), sectionItemIds: sectionModules.flatMap((module) => (module.children || []).map((item) => item.id)), finalProduct: primary.aggregateSubmission?.finalProduct, evidenceStatus: primary.aggregateSubmission?.evidenceStatus || 'documented', sources: [`page:${page.id}`, `page-module:${primary.id}`, ...sectionModules.map((item) => `page-module:${item.id}`)] });
  }
  for (const decision of decisions.filter((item) => item.aggregateSubmission?.pageId === page.id)) {
    const value = decision.aggregateSubmission;
    result.push({ scopeId: value.scopeId, primaryItemId: value.primaryItemId, triggerControlId: value.triggerControlId, operation: value.operation, sections: value.sections || [], sectionItemIds: value.sectionItemIds || [], finalProduct: value.finalProduct, evidenceStatus: 'confirmed', sources: [`user-decision:${decision.id}`] });
  }
  return dedupe(result, (item) => `${item.scopeId}:${item.primaryItemId}`);
}
function completeFinalProduct(value) { return Boolean(value?.type && value?.quantity && (value.quantity.sourceField || Number.isInteger(value.quantity.fixed)) && value?.lifecycle?.length >= 2 && value?.downstreamUsage?.length); }
function normalizeFinalProduct(value, sections) { if (!value?.quantity?.sourceField) return value; const source = value.quantity.sourceField; const field = sections.flatMap((section) => section.fields).find((item) => item.id === source || item.controlId === source); return field ? { ...value, quantity: { ...value.quantity, sourceField: field.id } } : value; }
function sameRequest(observed, declared) { if (!declared) return true; return String(observed?.method).toUpperCase() === String(declared.method).toUpperCase() && observed?.url === declared.path; }
function fieldKey(control) { return slug(control.label || control.placeholder) || slug(control.controlId); }
function toField(control) { return { id: fieldKey(control), controlId: control.controlId, label: control.label || control.placeholder || control.controlId, required: control.required === true, schema: control.options?.length ? { type: 'string', enum: control.options } : { type: 'string', minLength: control.required ? 1 : 0 }, regionId: control.region?.id, evidence: control.evidence }; }
function slug(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-|-$/g, ''); }
function dedupe(items, key) { return [...new Map(items.map((item) => [key(item), item])).values()]; }
