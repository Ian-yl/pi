import { createHash } from 'node:crypto';
import { schemaFindings } from './json-schema.mjs';

export function controlledProviderResponse(operation, resultId) {
  const contract = operation?.providerContract?.controlledResponse;
  if (!contract || !Number.isInteger(contract.status) || contract.status < 200 || contract.status > 299 || !contract.contentType || !contract.body || typeof contract.body !== 'object' || !contract.bodySchema || !contract.resultIdPath) throw new Error(`provider operation ${operation?.id || 'unknown'} has no executable controlled response`);
  const findings = schemaFindings(contract.body, contract.bodySchema, 'controlledResponse.body');
  if (findings.length) throw new Error(`provider operation ${operation.id} controlled response does not match bodySchema: ${findings[0]}`);
  const body = structuredClone(contract.body);
  if (!setPath(body, contract.resultIdPath, resultId)) throw new Error(`provider operation ${operation.id} controlled response resultIdPath does not exist: ${contract.resultIdPath}`);
  const renderedFindings = schemaFindings(body, contract.bodySchema, 'controlledResponse.body');
  if (renderedFindings.length) throw new Error(`provider operation ${operation.id} rendered controlled response does not match bodySchema: ${renderedFindings[0]}`);
  return { status: contract.status, contentType: contract.contentType, body, bytes: Buffer.from(JSON.stringify(body)) };
}

export function buildResultReviewRequest(operations, operationResults, challengeId, implementationAgentIds = []) {
  const requested = (operations || []).filter((operation) => operation.integrationVerification?.resultReview?.required === true).map((operation) => {
    const result = operationResults.find((item) => item.operationId === operation.id);
    return { operationId: operation.id, assertions: operation.integrationVerification.resultReview.assertions, providerResultLineage: operation.providerContract?.providerResultLineage || null, providerResults: result?.providerResults || [], result: result?.result ?? null, resultDigest: digest(result?.result ?? null) };
  });
  if (!requested.length) return null;
  const request = { schemaVersion: '1.0', generatedBy: 'project-implementation/validation-campaign', challengeId, implementationAgentIds: [...new Set(implementationAgentIds)].sort(), operations: requested };
  request.requestDigest = digest(request);
  return request;
}

export function resultReviewReceiptFindings(request, receipt) {
  const findings = [];
  const { requestDigest, ...unsignedRequest } = request || {};
  if (!requestDigest || requestDigest !== digest(unsignedRequest)) findings.push('independent result review request digest does not match its campaign payload');
  if (!request || receipt?.schemaVersion !== '1.0' || receipt?.requestDigest !== request?.requestDigest) findings.push('independent result review receipt is not bound to the current campaign request');
  if (!request?.implementationAgentIds?.length || !receipt?.reviewerAgentId || request.implementationAgentIds.includes(receipt.reviewerAgentId)) findings.push('independent result reviewer must differ from every campaign-bound implementation agent');
  if (!Number.isFinite(Date.parse(receipt?.reviewedAt || ''))) findings.push('independent result review has an invalid reviewedAt timestamp');
  const expected = (request?.operations || []).flatMap((operation) => (operation.assertions || []).map((assertion) => `${operation.operationId}:${assertion.id}`)).sort();
  const supplied = (receipt?.assertionResults || []).map((item) => `${item.operationId}:${item.assertionId}`).sort();
  if (new Set(supplied).size !== supplied.length || JSON.stringify(expected) !== JSON.stringify(supplied)) findings.push('independent result review assertion set does not match the current campaign request');
  if (receipt?.verdict !== 'passed' || (receipt?.assertionResults || []).some((item) => item.verdict !== 'passed')) findings.push('independent result review did not pass every declared assertion');
  return findings;
}

export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function setPath(value, path, replacement) {
  const parts = String(path).replace(/^response\./, '').split('.').filter(Boolean);
  let current = value;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (!current || typeof current !== 'object' || !(parts[index] in current)) return false;
    current = current[parts[index]];
  }
  const leaf = parts.at(-1);
  if (!leaf || !current || typeof current !== 'object' || !(leaf in current)) return false;
  current[leaf] = replacement;
  return true;
}
