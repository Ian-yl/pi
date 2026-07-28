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

**Candidate setup boundary.** The campaign re-prepares a clean workspace each run, so `install` steps may adapt the surfaces the candidate owns — its own source, the `web/`/`dist/` assets it replaced, and the completion of its own BMAD stories under `_bmad-output` — because the candidate is the implementer of exactly those surfaces. The approved inputs (`input-lock.json`, `implementation-plan.json`, `bmad-traceability.json`, `inputs/`, and the locked BMAD contracts) are protected by `assertProtectedState`, which re-checks their digests after candidate copy and after every install step; a setup that touches any of them hard-fails the run. The protection is the boundary — there is no special-case exemption, and if `assertProtectedState` blocks a setup step the design has overstepped and must be adjusted, not worked around. BMAD-completion honesty stays enforced independently by the traceability gate (each story's changed-file set ⊆ lock ∩ provenance, plus verbatim acceptance-criterion quotation), so in-place completion adds no cheat surface.

`integratedE2e` must send application requests through `${OBSERVED_BASE_URL}`. The campaign-owned proxy records the real method, path, status, and request/response digests and writes `operation-observation-receipt.json`. The E2E also writes `integration-evidence.json`, setting `viaApplication: true` and providing an `operations[]` record for every provider-backed operation, each referencing request, response, persisted-effect, lineage, and scenario evidence. The required and proven provider-operation ID sets must match exactly.

Required scenarios, endpoint policy, and artifact assertions come from the operation's `integrationVerification` contract. The runner has no fixed provider, output type, or failure-scenario vocabulary.

## Integrated positive path

`integratedAppEnv` routes the application's outbound external calls to the campaign's external observer and injects the campaign challenge — at least one of its values must reference `${EXTERNAL_OBSERVER_URL}` (typically also `${VALIDATION_CHALLENGE_ID}`). These are supplied to the application process only; the `integratedE2e` command must never receive them (it drives the app solely through `${OBSERVED_BASE_URL}`).

During each observed ingress request the application makes its real outbound calls to the external observer. The campaign injects a private random token per provider operation into the application process; the adapter forwards the matching token as `x-validation-operation-token`. E2E does not receive these tokens. External calls are attributed by token rather than a shared challenge/time window, so one invocation cannot prove two operations. Every invocation is checked against every required `integrationBinding`; one complete first call cannot cover incomplete later calls. Ingress values are recorded at `request.*`, `request.query.*`, `request.path.*`, and `request.header.*`; multipart fields and files are recorded by field name with safe content metadata/digests. Identity bindings require equal source and provider digests. For a locked FDD `resourceResolution`, the observer requires the upload response's dynamic resource ID in the downstream request and the uploaded content digest in the provider target; two unrelated values cannot prove resolution. For `independent-items`, the collection is read from the FDD result contract's exact `responsePath`, never from the longest convenient array. The observer enforces distinct-call/result/cardinality, the declared concurrency ceiling, and incorporation into the application response. `operation-observation-receipt.json` schema `1.5` contains one receipt per provider operation, and all findings must be empty.

Domain-specific quality judgment is performed by a distinct reviewer Agent against the campaign-owned result artifacts and the approved acceptance criteria. It is a review-stage decision, not a candidate-authored machine receipt and not a substitute for campaign observation.
