// Campaign teeth for independent-items providers (fix): a provider that emits independent items must be
// observed making one external call per produced item. The campaign counts its OWN observed egress and
// the observed application response collection length — never the app's self-reported provider-call
// field — and enforces external-call count == distinct external-result count == observed response
// collection length, each result incorporated. A single upstream call self-split into a collection, or a
// response padded beyond the observed external calls, is rejected.
export function collectionAtResponsePath(buffer, responsePath) {
  try {
    const body = JSON.parse(buffer.toString('utf8'));
    const path = String(responsePath || '').replace(/^response\./, '').split('.').filter(Boolean);
    const value = path.reduce((current, key) => current?.[key], body);
    return Array.isArray(value) ? value : null;
  } catch { return null; }
}

export function providerOperationSetFindings(operations, evidenceRecords) {
  const required = (operations || []).filter((item) => item.providerContract).map((item) => item.id).sort();
  const supplied = (evidenceRecords || []).map((item) => item.operationId);
  if (new Set(supplied).size !== supplied.length || JSON.stringify([...supplied].sort()) !== JSON.stringify(required)) return [`provider operation evidence set mismatch: required [${required.join(', ')}], supplied [${supplied.sort().join(', ')}]`];
  return [];
}

export function independentItemsCampaignFindings(operation, ingress, externalObservations, challengeId) {
  const provider = operation?.providerContract;
  if (provider?.outputMode !== 'independent-items') return [];
  const findings = [];
  const calls = (externalObservations || []).filter((item) => item.challengeId === challengeId && item.status >= 200 && item.status < 300 && ingress && item.observedAt >= ingress.startedAt && item.observedAt <= ingress.observedAt);
  const resultIds = calls.map((item) => item.externalResultId).filter(Boolean);
  const distinctResults = new Set(resultIds).size;
  const responseCount = Number(ingress?.responseCollectionLength);
  const incorporated = new Set(resultIds.filter((id) => (ingress?.responseValues || []).includes(id))).size;
  if (!calls.length) { findings.push(`independent-items operation ${operation.id} made no observed external provider call for the campaign challenge`); return findings; }
  if (provider.oneProviderResultPerItem === true && distinctResults !== calls.length) findings.push(`independent-items operation ${operation.id} did not return exactly one distinct external result per call (${distinctResults} distinct results across ${calls.length} calls)`);
  if (!Number.isFinite(responseCount) || responseCount !== calls.length) findings.push(`independent-items operation ${operation.id} response collection length (${responseCount}) does not equal the observed external provider call count (${calls.length}) — one upstream call cannot masquerade as an independent-item collection`);
  else if (incorporated !== responseCount) findings.push(`independent-items operation ${operation.id} response does not incorporate a distinct external result per item (${incorporated} of ${responseCount})`);
  return findings;
}

export function invocationBindingEvidence(operation, ingress, externalObservations, challengeId, resourceProofs = {}) {
  const calls = (externalObservations || []).filter((item) => item.challengeId === challengeId && ingress && item.observedAt >= ingress.startedAt && item.observedAt <= ingress.observedAt);
  return calls.flatMap((call, invocationIndex) => (operation?.integrationBindings || []).map((binding) => {
    const target = binding.target || binding.providerField;
    const sourceValueDigest = ingress?.requestValueDigests?.[binding.source] || null;
    const targetValueDigest = call.requestValueDigests?.[target] || null;
    const proof = resourceProofs[binding.source];
    const resolution = proof?.resolution;
    const mappingMode = resolution ? 'resource-resolution' : 'identity';
    const resolutionDigest = resolution ? createHash('sha256').update(JSON.stringify(resolution)).digest('hex') : null;
    const verificationMode = resolution?.verificationMode;
    const targetContentDigests = call.requestContentDigests?.[target]?.[verificationMode === 'multipart-content' ? 'raw-content' : verificationMode] || [];
    const contentMatched = Boolean(proof?.sourceLinked && proof.contentDigests?.length && proof.contentDigests.every((digest) => targetContentDigests.includes(digest)));
    const observed = mappingMode === 'identity' ? Boolean(sourceValueDigest && sourceValueDigest === targetValueDigest) : contentMatched;
    return { operationId: operation.id, invocationId: call.id || call.externalResultId || `invocation-${invocationIndex + 1}`, invocationIndex, source: binding.source, target, required: binding.required !== false, mappingMode, resolutionDigest, sourceValueDigest, targetValueDigest, contentDigests: proof?.contentDigests || [], targetContentDigests, observed };
  }));
}

export function operationResourceResolutions(functionalSpec, operation) {
  const capability = (functionalSpec?.capabilities || []).find((item) => item.id === operation?.capabilityId);
  return Object.fromEntries((capability?.closure?.inputUtilization || []).filter((item) => item.operationId === operation?.id && item.disposition === 'provider-mapped' && item.resourceResolution).map((item) => [providerSource(item.requestPath), item.resourceResolution]));
}

export function operationResourceProofs(functionalSpec, operation, operations, observations, ingress) {
  const resolutions = operationResourceResolutions(functionalSpec, operation);
  const proofs = {};
  for (const dependency of operation?.dataDependencies || []) {
    const source = providerSource(dependency.targetField);
    if (!resolutions[source]) continue;
    const sourceOperation = (operations || []).find((item) => item.id === dependency.sourceOperationId && item.resourceTransfer);
    const sourceDigest = ingress?.requestValueDigests?.[source];
    const upload = (observations || []).find((item) => {
      if (!sourceOperation || String(item.method).toUpperCase() !== String(sourceOperation.method).toUpperCase() || !routeMatches(sourceOperation.path, item.path) || Number(item.status) < 200 || Number(item.status) >= 300 || Number(item.observedAt) > Number(ingress?.startedAt)) return false;
      const value = getPath(item.responseBody, String(dependency.sourceField || '').replace(/^response\./, ''));
      return value !== undefined && createHash('sha256').update(JSON.stringify(value)).digest('hex') === sourceDigest;
    });
    const responseValue = getPath(upload?.responseBody, String(dependency.sourceField || '').replace(/^response\./, ''));
    const expectedSourceDigest = responseValue === undefined ? null : createHash('sha256').update(JSON.stringify(responseValue)).digest('hex');
    proofs[source] = { resolution: resolutions[source], sourceLinked: Boolean(expectedSourceDigest && sourceDigest === expectedSourceDigest), contentDigests: upload?.requestContentDigests?.[`request.${sourceOperation?.resourceTransfer?.fileField}`]?.['raw-content'] || [] };
  }
  return proofs;
}

export function operationScopedCalls(externalObservations, challengeId, operationId, ingress) {
  return (externalObservations || []).filter((item) => item.challengeId === challengeId && item.operationId === operationId && item.status >= 200 && item.status < 300 && ingress && item.startedAt >= ingress.startedAt && item.observedAt <= ingress.observedAt);
}

function providerSource(requestPath) { const path = String(requestPath || '').replace(/^request\./, 'body.'); return path.startsWith('body.') ? `request.${path.slice(5)}` : `request.${path}`; }
function getPath(value, path) { return String(path || '').split('.').filter(Boolean).reduce((current, key) => current?.[key], value); }
function routeMatches(contractPath, observedPath) { const pattern = String(contractPath).split(/(\{[^}]+\})/).map((part) => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''); return new RegExp(`^${pattern}$`).test(observedPath); }

// Concurrency teeth: the campaign injects a fixed upstream delay so overlap is deterministic, then judges
// only the observable maximum in-flight external-call count against the agent-authored contract — never
// how the app schedules (Promise.all, queue, worker pool are all valid implementation choices).
export function concurrencyFindings(provider, quantity, maxInFlight) {
  if (provider?.outputMode !== 'independent-items') return [];
  const findings = [];
  const declared = Number(provider.concurrency?.maxParallel);
  const observed = Number(maxInFlight);
  if (Number.isFinite(declared) && Number.isFinite(observed) && observed > declared) findings.push(`independent-items provider ran ${observed} external calls in flight, exceeding its declared maxParallel ${declared}`);
  return findings;
}
import { createHash } from 'node:crypto';
