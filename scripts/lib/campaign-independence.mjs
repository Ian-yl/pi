// Campaign teeth for independent-items providers (fix): a provider that emits independent items must be
// observed making one external call per produced item. The campaign counts its OWN observed egress and
// the observed application response collection length — never the app's self-reported provider-call
// field — and enforces external-call count == distinct external-result count == observed response
// collection length, each result incorporated. A single upstream call self-split into a collection, or a
// response padded beyond the observed external calls, is rejected.
export function maxCollectionLength(buffer) {
  try {
    const body = JSON.parse(buffer.toString('utf8'));
    const arrays = Array.isArray(body) ? [body] : body && typeof body === 'object' ? Object.values(body).filter(Array.isArray) : [];
    return arrays.reduce((max, item) => Math.max(max, item.length), 0);
  } catch { return 0; }
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
