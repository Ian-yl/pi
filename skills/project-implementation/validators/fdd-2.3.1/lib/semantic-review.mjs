import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const INPUT_FILES = ['functional-spec.json', 'evidence-index.json', 'evidence-dispositions.json', 'control-dispositions.json', 'frontend-semantic-inventory.json', 'observed-interactions.json', 'control-capability-map.json'];

export function buildSemanticReviewRequest(dir, spec, frontend, dispositions) {
  const inputDigest = createHash('sha256');
  for (const file of INPUT_FILES) inputDigest.update(file).update('\0').update(readFileSync(`${dir}/${file}`)).update('\0');
  const request = { schemaVersion: '1.0', generatedBy: 'functional-domain-design/semantic-review-request', inputDigest: inputDigest.digest('hex'), pageIds: (frontend.pages || []).map((item) => item.pageId).sort(), capabilityIds: (spec.capabilities || []).map((item) => item.id).sort(), controlIds: (dispositions.dispositions || []).map((item) => `${item.pageId}:${item.controlId}`).sort() };
  request.requestDigest = digest(request);
  return request;
}

export function semanticReviewFindings(request, review, reviewerAgentId) {
  const findings = [];
  const suppliedPages = (review?.pageReviews || []).map((item) => item.pageId).sort();
  const suppliedCapabilities = (review?.pageReviews || []).flatMap((item) => item.capabilityIds || []).sort();
  const suppliedControls = (review?.pageReviews || []).flatMap((item) => item.controlIds || []).sort();
  if (review?.schemaVersion !== '1.0' || review?.status !== 'approved' || review?.requestDigest !== request.requestDigest || review?.reviewerAgentId !== reviewerAgentId) findings.push('semantic review is not approved by the invoking reviewer or bound to the current review request');
  if (JSON.stringify(suppliedPages) !== JSON.stringify(request.pageIds) || new Set(suppliedPages).size !== suppliedPages.length) findings.push('semantic review does not cover every frontend page exactly once');
  if (JSON.stringify(suppliedCapabilities) !== JSON.stringify(request.capabilityIds) || new Set(suppliedCapabilities).size !== suppliedCapabilities.length) findings.push('semantic review does not cover every capability exactly once');
  if (JSON.stringify(suppliedControls) !== JSON.stringify(request.controlIds) || new Set(suppliedControls).size !== suppliedControls.length) findings.push('semantic review does not cover every control disposition exactly once');
  if ((review?.pageReviews || []).some((item) => item.verdict !== 'approved' || !String(item.closureAssessment || '').trim() || !String(item.evidenceAssessment || '').trim())) findings.push('semantic review has an unapproved or unexplained page judgment');
  return findings;
}

function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
