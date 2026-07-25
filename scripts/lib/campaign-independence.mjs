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

// Concurrency teeth: the campaign injects a fixed upstream delay so overlap is deterministic, then judges
// only the observable maximum in-flight external-call count against the declared contract — never how the
// app schedules (Promise.all, queue, worker pool are all fine). Ceiling: in-flight never exceeds
// maxParallel. Floor: when quantity>=2 and maxParallel>=2, real parallelism must be observed (>=2 in
// flight) so a declared-parallel-but-actually-serial provider cannot pass by timing luck.
export function concurrencyFindings(provider, quantity, maxInFlight) {
  if (provider?.outputMode !== 'independent-items') return [];
  const findings = [];
  const declared = Number(provider.concurrency?.maxParallel);
  const observed = Number(maxInFlight);
  if (Number.isFinite(declared) && Number.isFinite(observed) && observed > declared) findings.push(`independent-items provider ran ${observed} external calls in flight, exceeding its declared maxParallel ${declared}`);
  if (Number(quantity) >= 2 && declared >= 2 && observed < 2) findings.push(`independent-items provider declared maxParallel ${declared} but was observed running serially (max ${observed} in flight) under delay injection — the declared parallelism was never exercised`);
  return findings;
}

// Visual sampling receipt: the "content-level collage" boundary is not machine-detectable, so integrated
// qualification carries a process gate rather than an image judgment. The machine checks only that a
// receipt exists, its sampled digests align one-to-one with the campaign's own sampling sheet, and an
// auditor identity/time are recorded — the independent/suspected-composite verdict is rendered by a mind
// that can see the images, never by this code.
export function visualAuditFindings(samplingSheet, auditReceipt) {
  if (!Array.isArray(samplingSheet) || !samplingSheet.length) return [];
  const findings = [];
  if (!auditReceipt || typeof auditReceipt !== 'object') { findings.push('integrated independent-items delivery has no visual-audit-receipt for its produced sample'); return findings; }
  if (!String(auditReceipt.auditorIdentity || '').trim()) findings.push('visual-audit-receipt lacks an auditor identity');
  if (!String(auditReceipt.auditedAt || '').trim()) findings.push('visual-audit-receipt lacks an audited-at timestamp');
  const sheetDigests = samplingSheet.map((item) => item.digest).filter(Boolean);
  const receiptDigests = new Set(auditReceipt.sampleDigests || []);
  if (receiptDigests.size !== sheetDigests.length || sheetDigests.some((digest) => !receiptDigests.has(digest))) findings.push('visual-audit-receipt sample digests do not align one-to-one with the campaign visual sampling sheet');
  const verdicts = Array.isArray(auditReceipt.verdictPerItem) ? auditReceipt.verdictPerItem : [];
  if (verdicts.length !== sheetDigests.length || !verdicts.every((entry) => ['independent', 'suspected-composite'].includes(entry?.verdict ?? entry))) findings.push('visual-audit-receipt lacks a recognized verdict (independent|suspected-composite) for each sampled item');
  return findings;
}
