# Current Validation Status

Date: 2026-07-23

## Scope

- Functional/domain design consumes ProductForge page and system architecture.
- Project implementation consumes an independently approved functional package and implementation handoff.
- Implementation outputs cover frontend, backend, persistence, provider adapters, API contracts, startup metadata, tests, and digest locks.

## Current Gates

- Implementation preparation requires `review-receipt.json` with distinct author and reviewer identities.
- The functional package lock covers every formal package file and the review receipt.
- The implementation input lock is revalidated at completion.
- Test cases declare the implementation-plan unit IDs they cover.
- Integrated evidence includes a real provider output whose file, digest, byte count, and dimensions are verified.
- Repeated validation accepts any positive run count. Integrated runs call the configured real provider during every run.

## Bundled Samples

- `functional-domain` is a legacy schema 1.0 package without an independent review receipt.
- `functional-domain-v2` is a draft package with an independent rejection report and unresolved review findings.
- `implementation` contains simulated historical output based on the legacy functional package.
- `validation-runs` contains historical campaign artifacts from the earlier workflow.

These samples document prior iterations. Current qualification starts from a functional package that passes the independent approval gate and an implementation whose test suite emits unit-level evidence.

## Verification Commands

```bash
node --test tests/skill-contracts.test.mjs
node scripts/prepare-implementation.mjs \
  --functional <approved-functional-package> \
  --handoff <approved-implementation-handoff> \
  --output <implementation-workspace>
node scripts/run-validation-campaign.mjs \
  --functional <approved-functional-package> \
  --handoff <approved-implementation-handoff> \
  --candidate <candidate-implementation> \
  --output <campaign-output> \
  --count <positive-integer> \
  --level simulated
```

For integrated validation, select `--level integrated` and provide `--base-url`, `--model`, and the configured API key environment variable.
