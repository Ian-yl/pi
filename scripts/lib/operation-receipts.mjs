import { createHash } from 'node:crypto';
import { schemaFindings } from './json-schema.mjs';

export function computeOperationReceipts(api, raw, sourceBytes) {
  const events = raw.events || [];
  const receipts = (api.operations || []).map((operation) => {
    const matching = events.filter((event) => event.operationId === operation.id); const findings = [];
    if (!matching.length) findings.push('no captured operation event');
    const success = matching.find((event) => methodPathContentType(event, operation) && successStatus(event.response?.status, operation));
    if (!success) findings.push('no matching successful request and response event');
    else {
      for (const [location, schema] of [['path', operation.request?.pathSchema], ['query', operation.request?.querySchema], ['header', operation.request?.headerSchema], ['body', operation.request?.bodySchema]]) findings.push(...schemaFindings(success.request?.[location] ?? {}, schema, `request.${location}`));
      findings.push(...schemaFindings(success.response?.body, operation.response?.bodySchema || operation.response?.schema, 'response.body'));
    }
    if (!matching.some((event) => event.authorization?.checked === true)) findings.push('authorization was not observed');
    for (const error of operation.errors || []) { const code = typeof error === 'object' ? error.code : error; if (!matching.some((event) => event.errorCode === code)) findings.push(`declared error was not observed: ${code}`); }
    for (const effect of operation.effects || []) if (!matching.some((event) => (event.effects || []).some((item) => item.entityId === effect.entityId && item.effect === effect.effect && item.observed === true && Object.hasOwn(item, 'before') && Object.hasOwn(item, 'after')))) findings.push(`effect was not observed: ${effect.entityId}/${effect.effect}`);
    if ((operation.transaction || operation.consistency) && !matching.some((event) => event.transaction?.observed === true || event.consistency?.observed === true)) findings.push('transaction or consistency behavior was not observed');
    // Independent-items provider: one recorded provider call per produced collection item, so a single
    // provider result cannot be presented as N. Contract-driven — reads the declared providerContract only.
    if (operation.providerContract?.outputMode === 'independent-items' && success) {
      const collection = responseArrays(success.response?.body).sort((left, right) => right.length - left.length)[0] || [];
      const providerCalls = success.providerCalls;
      if (!Array.isArray(providerCalls) || providerCalls.length !== collection.length) findings.push(`independent-items provider did not record one provider call per produced item (${Array.isArray(providerCalls) ? providerCalls.length : 'none'} calls for ${collection.length} items)`);
    }
    findings.push(...acceptanceExampleFindings(operation, matching));
    return { operationId: operation.id, status: findings.length ? 'failed' : 'passed', eventIds: matching.map((event) => event.id), findings };
  });
  return { schemaVersion: '1.0', generatedBy: 'project-implementation/build-operation-receipts', trustLevel: 'self-reported-runtime-events', sourceDigest: createHash('sha256').update(sourceBytes).digest('hex'), receipts };
}

function methodPathContentType(event, operation) { return String(event.request?.method).toUpperCase() === String(operation.method).toUpperCase() && event.request?.route === operation.path && String(event.request?.contentType || '') === String(operation.request?.contentType || 'application/json'); }
function successStatus(status, operation) { return operation.successStatuses?.length ? operation.successStatuses.map(Number).includes(Number(status)) : Number(status) >= 200 && Number(status) < 300; }
function acceptanceExampleFindings(operation, matching) {
  const examples = [operation.acceptanceExample, ...(operation.acceptanceExamples || [])].filter(Boolean);
  if (!examples.length) return [];
  const successes = matching.filter((event) => methodPathContentType(event, operation) && successStatus(event.response?.status, operation));
  const seen = new Set(); const findings = [];
  for (const example of examples) { const key = JSON.stringify(example); if (seen.has(key)) continue; seen.add(key);
    if (!successes.some((event) => exampleWitnessedBy(operation, example, event))) findings.push(`acceptance example is not proven by an operation event: ${operation.id} — capture an event whose request carries every given field with a real value and whose response satisfies the declared then assertions and result cardinality, not a schema-shaped placeholder`); }
  return findings;
}
function exampleWitnessedBy(operation, example, event) {
  for (const key of Object.keys(example.given || {})) if (!presentNonEmpty(requestFieldValue(event.request, key))) return false;
  for (const assertion of example.then || []) if (!thenSatisfied(operation, assertion, event)) return false;
  const countField = operation.finalProduct?.quantity?.sourceField;
  if (countField) { const n = Number(requestFieldValue(event.request, countField)); if (!Number.isFinite(n) || n < 1 || !responseArrays(event.response?.body).some((array) => array.length === n)) return false; }
  return true;
}
function thenSatisfied(operation, assertion, event) {
  const name = String(assertion?.assertion || '');
  if (name.startsWith('response.')) { const value = getPath(event.response?.body, name.slice('response.'.length)); if (Object.hasOwn(assertion, 'equals')) return deepEqual(value, assertion.equals); if (assertion.matches === true) return presentNonEmpty(value); return true; }
  if (name === 'declared-output-schema' && assertion.matches === true) return schemaFindings(event.response?.body, operation.response?.bodySchema || operation.response?.schema, 'response.body').length === 0;
  if (name === 'declared-ui-state' || name.startsWith('quality.') || name.startsWith('effect.')) {
    if (!event.assertions || !Object.hasOwn(event.assertions, name)) return false;
    const value = event.assertions[name];
    if (Object.hasOwn(assertion, 'equals')) return deepEqual(value, assertion.equals);
    if (assertion.matches === true) return presentNonEmpty(value);
  }
  return false;
}
function requestFieldValue(request, field) { for (const location of ['body', 'path', 'query', 'header']) { const container = request?.[location]; if (container && typeof container === 'object' && Object.hasOwn(container, field)) return container[field]; } return getPath(request?.body, field); }
function presentNonEmpty(value) { return value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0); }
function responseArrays(body) { return body && typeof body === 'object' ? Object.values(body).filter(Array.isArray) : []; }
function getPath(value, path) { return String(path || '').split('.').filter(Boolean).reduce((current, key) => current?.[key], value); }
function deepEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
