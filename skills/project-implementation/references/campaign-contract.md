# Campaign Candidate Contract

Place `campaign-contract.json` at every candidate project root. The runner has no default framework, directory layout, provider, health route, or environment names.

```json
{
  "copy": ["src", "tests", "package.json", "package-lock.json"],
  "install": [
    { "command": "npm", "args": ["ci"], "cwd": "." }
  ],
  "runtime": {
    "app": { "command": "npm", "args": ["start"], "env": { "PORT": "${APP_PORT}" } },
    "integratedAppEnv": { "EXTERNAL_URL": "${EXTERNAL_URL}", "EXTERNAL_TOKEN": "${EXTERNAL_TOKEN}" },
    "healthUrl": "http://127.0.0.1:${APP_PORT}/health",
    "startupTimeoutMs": 15000,
    "e2e": { "command": "npm", "args": ["run", "e2e"], "env": { "BASE_URL": "http://127.0.0.1:${APP_PORT}" }, "timeoutMs": 120000 },
    "integratedE2e": { "command": "npm", "args": ["run", "e2e:integrated"], "env": { "BASE_URL": "${OBSERVED_BASE_URL}" }, "timeoutMs": 180000 }
  }
}
```

Available substitutions include `${APP_PORT}`, `${OBSERVED_BASE_URL}`, `${RUN_ID}`, and environment variables supplied by the caller. Ports are allocated by the operating system for each run.

`integratedE2e` must send application requests through `${OBSERVED_BASE_URL}`. The campaign-owned proxy records the real method, path, status, and request/response digests and writes `operation-observation-receipt.json`. The E2E also writes `integration-evidence.json`, identifying `operationId`, setting `viaApplication: true`, and referencing request, response, and persisted-effect evidence.

Required scenarios, endpoint policy, and artifact assertions come from the operation's `integrationVerification` contract. The runner has no fixed provider, output type, or failure-scenario vocabulary.

## Integrated positive path

`integratedAppEnv` routes the application's outbound external calls to the campaign's external observer and injects the campaign challenge — at least one of its values must reference `${EXTERNAL_OBSERVER_URL}` (typically also `${VALIDATION_CHALLENGE_ID}`). These are supplied to the application process only; the `integratedE2e` command must never receive them (it drives the app solely through `${OBSERVED_BASE_URL}`).

During one observed ingress request the application makes its real outbound provider calls to that external observer, each carrying the challenge header. For an `independent-items` operation the observer injects a fixed upstream delay and returns one distinct result id per call, and the campaign enforces, from its own observation only: observed external-call count == distinct external-result count == observed application response collection length, with each external result incorporated into the response; the maximum in-flight external-call count judged against the declared `concurrency.maxParallel` (never exceeding the ceiling, and exercising real parallelism when `maxParallel >= 2` and quantity `>= 2`); and every required `integrationBindings` source whose ingress request-value digest equals the egress provider-field digest. The application must forward the bound inputs into the provider request so those digests match. All of this is recorded in `operation-observation-receipt.json` (`schemaVersion` `1.4`, with `maxInFlight` and the `independentItemsFindings` / `concurrencyFindings` / `visualAuditFindings` tallies, all of which must be empty to pass).

The delivery must also carry a `visual-audit-receipt.json` whose `sampleDigests` align one-to-one with the campaign's `visual-sampling-sheet.json`, recording an `auditorIdentity` and `auditedAt` and a per-item `independent`/`suspected-composite` verdict. The machine checks only alignment, identity, and time; the verdict itself is rendered by an auditor that can see the produced items.
