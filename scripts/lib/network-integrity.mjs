const INTERCEPTION_METHOD = /(?:^|\.)(?:route|routeFromHAR|fulfill|abort|continue|fallback|intercept|mock)(?:$|\.)/i;
const INTERCEPTION_SOURCE = /\b(?:page|context|browserContext)\s*(?:\.\s*(?:route|routeFromHAR)|\[\s*['"](?:route|routeFromHAR)['"]\s*\])\s*\(|\broute\s*\.\s*(?:fulfill|abort|continue|fallback)\s*\(/i;

export function networkInterceptionFindings(events, sourceTexts = []) {
  const findings = [];
  for (const event of events) {
    if (event.type !== 'before') continue;
    const apiName = [event.class, event.apiName, event.method].filter(Boolean).join('.');
    if (INTERCEPTION_METHOD.test(apiName)) findings.push(`Playwright network interception API was used: ${apiName}`);
  }
  if (sourceTexts.some((source) => INTERCEPTION_SOURCE.test(source))) findings.push('Playwright E2E source registers a network route, HAR, or fulfilled response');
  return [...new Set(findings)];
}
