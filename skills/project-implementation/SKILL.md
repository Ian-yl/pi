---
name: project-implementation
description: Implement and verify a complete project from an approved functional-domain package and implementation handoff. Use when generating backend APIs, persistence, integrations, frontend API wiring, contract tests, end-to-end tests, startup manifests, or deployment artifacts without guessing business behavior from screenshots or source code.
---

# Project Implementation

Implement the approved contract. Route missing business semantics back to functional-domain design.

## Workflow

1. Read `<skill-dir>/references/input-contract.md`.
2. Confirm the functional package contains approved `fdd-bmad-planning` artifacts and that the implementation handoff binds the functional package digest, AI Restore release manifest digest, UI implementation plan, API contract, and original visual source tree. Prepare a locked implementation workspace:

   ```bash
   node <skill-dir>/scripts/prepare-implementation.mjs \
     --functional <functional-domain-package> \
     --handoff <approved-implementation-handoff> \
     --output <implementation-workspace>
   ```

   Preparation locks the FDD planning artifacts as read-only inputs. It then exports every implementation unit to the separate `pi-implementation-bmad` workflow under `_bmad-output/implementation-artifacts/stories/`, plus `sprint-status.yaml` and `bmad-traceability.json`.

3. Return missing or inconsistent capability, operation, journey, rule, entity, relationship, or acceptance semantics to FDD. Resolve the source package and prepare the workspace again. PI does not add or reinterpret domain semantics.
   An explicitly `planned` capability is not a missing-contract error. Preserve or create its reachable entry and implement only its capability-specific “功能待实现” surface. Do not create an API, persistence behavior, fake result, or local success simulation for it.
4. Read `implementation-plan.json`. Implement units in dependency order:
   - persistence and migrations;
   - relationship keys, indexes, uniqueness, requiredness, cascade/restrict behavior, aggregate boundaries, and transaction semantics;
   - domain services and invariants;
   - API contract and error behavior;
   - external-provider adapters;
   - frontend real API wiring and state handling;
   - presentation intents: wire `reuse-control`, create design-consistent `add-control` UI, build `extend-flow` surfaces, implement `headless` services, and render `display-only` state;
   - contract, integration, E2E, permission, and regression tests;
   - startup and deployment manifests.

   Follow `field-binding-plan.json` for every required control and field. Prove the full runtime chain: UI control -> frontend state -> operation request -> operation-specific backend handling -> declared effect -> observable response or downstream operation. Use runtime-generated values for cross-operation `dataDependencies`; constants and independent fixtures do not prove propagation. Instrument tests to emit concrete operation events captured at runtime boundaries; finalization, not candidate booleans, computes operation receipts.

   For each generated story, run BMAD `dev-story` and then `code-review`. Mark every task complete, add Dev Agent and Code Review records with distinct agent identities, update `sprint-status.yaml`, and write `bmad-completion.json` with the final story digest. BMAD coordinates execution and review; the locked contracts and this skill's machine verification remain authoritative.
5. Preserve `input-lock.json`. If either input digest changes, regenerate the workspace and mark prior implementation stale.
6. Generate the completed `interaction-manifest.json`, `control-bindings.json`, `implementation-provenance.json`, `frontend-runtime-config.json`, and `placeholder-resolution.json`. Every interaction and binding references browser evidence. Generate `unit-test-report.json` only for non-UI units; UI unit claims in that report are ignored. Run `node <skill-dir>/scripts/finalize-implementation.mjs --dir <implementation-workspace>`. Finalization starts the app, runs Playwright E2E, audits placeholders, and creates the runner-owned runtime reports.
   When every presentation in the formal UI plan is `headless`, omit UI runtime artifacts; finalization skips frontend build, browser E2E, and placeholder gates while retaining backend/API, BMAD, provenance, and source-lock verification.
7. Establish `integrated` status with a contract-declared application E2E that calls an application operation, reaches the declared external integration through the application adapter, verifies persisted effects, and writes application integration evidence. Product-specific connectivity diagnostics are owned by the candidate project and do not establish implementation completion.
8. Run:

   ```bash
   node <skill-dir>/scripts/verify-implementation.mjs <implementation-workspace> --require-level integrated
   ```
   This command accepts only a complete formal schema `1.1` workspace and rejects `--legacy`. Historical schema `1.0` material may be inspected by `verify-legacy-archive.mjs`, but that command emits non-release archive diagnostics and never implementation completion evidence. Standalone integrated verification checks locked evidence; release qualification must use the integrated campaign, which controls execution and observes the application-to-integration path.

For repeated qualification, use `<skill-dir>/scripts/run-validation-campaign.mjs` with an approved functional package, approved implementation handoff, and candidate implementation. Every candidate supplies `<skill-dir>/references/campaign-contract.md`; the generic runner has no framework, layout, product, or provider defaults. Each run installs dependencies and performs implementation preparation, finalization, verification, and runtime E2E. The default is one `simulated` run; `--count` accepts any positive integer.

## Required Outputs

- application source, including frontend and backend;
- migrations and deterministic fixtures;
- `openapi.json`;
- `implementation-manifest.json`;
- `interaction-manifest.json` and `control-bindings.json`;
- `frontend-runtime-config.json`, `frontend-runtime-report.json`, and `browser-e2e-report.json`;
- `placeholder-resolution.json` and `placeholder-audit-report.json`;
- `startup.json`;
- `test-report.json`;
- `evidence/` request, response, data-effect, and E2E artifacts;
- `input-lock.json` and `implementation-lock.json`.

## Rules

- Implement only approved capability, rule, and journey IDs.
- Trace every API operation to capability and rule IDs.
- Give every write operation a tested data effect and failure rollback behavior.
- Implement every approved relationship and consistency boundary with dedicated migration and invariant tests.
- Keep external integrations behind adapters; missing configuration returns an explicit unavailable state.
- Represent an unavailable external capability with an explicit unavailable state.
- Classify mock, localhost, deterministic fixture, candidate-authored operation events, and intercepted browser evidence as `simulated`. Integrated completion requires campaign-controlled observation of the contract-declared external integration path.
- Implement backend files from the locked functional and handoff contracts and record operation-to-source provenance.
- Test authorization, validation, idempotency, concurrency, and state transitions when the functional package declares them.
- Keep visual tests separate from business acceptance; both may be required.
- Verify every non-headless binding in the running DOM. Server actions observe matching API requests; client actions observe state or DOM changes; display-only surfaces observe data-driven rendering.
- Every `complete` capability must be active, genuinely implemented, and free of stale content from another capability. Every `planned` capability must be reachable, replace the active surface with its own named “功能待实现” state, emit no business request, and make no implemented or success claim.
- Treat the runner-computed capability completion report as authoritative. Every required binding, field, operation, state, effect, and acceptance case for complete capabilities must pass; every planned-state contract must pass. A mixed delivery reports `delivered-with-planned-capabilities` instead of claiming full implementation.
