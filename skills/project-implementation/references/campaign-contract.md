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
