const modes = new Set(['reuse-control', 'add-control', 'extend-flow', 'headless', 'display-only']);

export function presentationFindings(capabilityId, presentation, capability = {}, options = {}) {
  const findings = [];
  if (!presentation || !modes.has(presentation.mode)) return [`capability ${capabilityId} has no valid presentation mode`];
  if (presentation.mode !== 'headless' && !text(presentation.targetPageId)) findings.push(`capability ${capabilityId} presentation has no target page`);
  if (presentation.mode === 'reuse-control' && !nonempty(presentation.visualHint)) findings.push(`capability ${capabilityId} reuse-control presentation has no visualHint`);
  if (presentation.mode === 'add-control') {
    if (!text(presentation.preferredRegion)) findings.push(`capability ${capabilityId} add-control presentation has no preferredRegion`);
    if (!text(presentation.control?.type)) findings.push(`capability ${capabilityId} add-control presentation has no control.type`);
    if (!text(presentation.control?.label)) findings.push(`capability ${capabilityId} add-control presentation has no control.label`);
  }
  if (presentation.mode === 'extend-flow') {
    if (!text(presentation.flow?.type)) findings.push(`capability ${capabilityId} extend-flow presentation has no flow.type`);
    if (!nonempty(presentation.flow?.trigger)) findings.push(`capability ${capabilityId} extend-flow presentation has no flow.trigger`);
    if (!nonempty(presentation.flow?.destination) && !text(presentation.flow?.destinationId)) findings.push(`capability ${capabilityId} extend-flow presentation has no flow destination`);
  }
  if (presentation.mode === 'display-only' && !nonempty(presentation.content) && !nonempty(presentation.region)) findings.push(`capability ${capabilityId} display-only presentation has no content or region`);
  if (presentation.activation || presentation.surface) {
    if (!presentation.activation?.type || !nonempty(presentation.activation?.visualHint)) findings.push(`capability ${capabilityId} has incomplete activation contract`);
    const content = presentation.surface?.contentContract;
    const planned = options.requireDeliveryPolicy === true && capability.specificationStatus === 'planned';
    if (!presentation.surface?.type || !presentation.surface?.requiredRegions?.length || !content?.heading || !Array.isArray(content.inputIds) || (!planned && !content.primaryAction) || !content.emptyState) findings.push(`capability ${capabilityId} has incomplete surface content contract`);
    if (options.requireDeliveryPolicy === true && (!capability.deliveryPolicy || capability.deliveryPolicy.requiredForCompletion !== !planned || capability.deliveryPolicy.allowedIncompleteState !== 'planned' || (planned && capability.deliveryPolicy.uiBehavior !== 'show-planned-state'))) findings.push(`capability ${capabilityId} has incomplete delivery policy`);
  }
  if (presentation.behavior === 'server-operation' && !(capability.operations || []).length) findings.push(`capability ${capabilityId} declares server-operation behavior without an operation`);
  if (options.requireDeliveryPolicy === true && capability.specificationStatus === 'planned' && (presentation.behavior !== 'planned-state' || presentation.primaryOperationId || presentation.surface?.contentContract?.inputIds?.length || presentation.surface?.contentContract?.primaryAction || presentation.surface?.contentContract?.primaryOperationId || !text(presentation.plannedState?.title) || !text(presentation.plannedState?.message))) findings.push(`capability ${capabilityId} has no capability-specific planned presentation`);
  return findings;
}

function text(value) { return typeof value === 'string' && value.trim().length > 0; }
function nonempty(value) { return text(value) || (value && typeof value === 'object' && Object.keys(value).length > 0); }
