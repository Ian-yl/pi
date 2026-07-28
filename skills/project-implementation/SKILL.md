---
name: project-implementation
description: Implement and verify a complete project from an approved functional-domain package and implementation handoff. Use when generating backend APIs, persistence, integrations, frontend API wiring, contract tests, end-to-end tests, startup manifests, or deployment artifacts without guessing business behavior.
---

# Project Implementation

## North Star

交付物是真实用户可用的完整产品。`release-backed` 从 release 原生控件完成业务；`design-led` 由你依据批准的设计和领域合同实现完整前后端。验证器只检查合同、产物和可观察结果，不替你设计产品。

## Workflow

1. Read `<skill-dir>/references/input-contract.md`.
2. Prepare the locked workspace:
   ```bash
   node <skill-dir>/scripts/prepare-implementation.mjs \
     --functional <functional-domain-package> \
     --handoff <approved-implementation-handoff> \
     --output <implementation-workspace>
   ```
3. Read `handoff-manifest.inputMode`. For `release-backed`, preserve and wire the copied frontend. For `design-led`, implement the complete frontend from the locked designs and presentation contract. Return missing or inconsistent domain semantics to FDD; preserve explicitly `planned` capabilities as reachable “功能待实现” surfaces.
4. Implement `implementation-plan.json` in dependency order: persistence, domain rules, APIs, integrations, frontend wiring, presentation, tests, startup, and deployment. Follow `implementation-worklist.json` control by control as the recommended path, then use `field-binding-plan.json` for field-level data flow. Run BMAD `dev-story` and `code-review` for every story.
5. Preserve `input-lock.json`; regenerate the workspace when an input changes.
6. Generate the manifests and runtime configuration required by [the input contract](references/input-contract.md). Before finalization ask exactly: ① 原页面的用户会察觉到任何真实变化吗？② 删掉你新增的全部 UI，功能还在吗？③ 每个原生控件背后是真实后端行为吗？
   ```bash
   node <skill-dir>/scripts/finalize-implementation.mjs --dir <implementation-workspace>
   ```
7. Establish `integrated` status only through the contract-declared application E2E and campaign-controlled external observation. The observer replays the FDD Agent's locked `controlledResponse`; do not add a test-only adapter path. When the campaign writes `result-review-request.json`, give it to a distinct reviewer Agent and have that Agent write the bound `result-review-receipt.json`; the implementation Agent does not author its own judgment. Repeated qualification uses `<skill-dir>/scripts/run-validation-campaign.mjs` and [the campaign contract](references/campaign-contract.md).
8. Verify:
   ```bash
   node <skill-dir>/scripts/verify-implementation.mjs <implementation-workspace> --require-level integrated
   ```
   Read every finding, fix the implementation or its authored evidence, and rerun the failed qualification step through final verification until it passes. Stop only when the approved contract lacks a decision PI is not authorized to invent; return that concrete blocker to FDD.
   A successful `design-led` completion writes `visual-restoration-handoff.json`. Hand the verified implementation and this boundary to AI Restore for visual-only restoration. AI Restore completion ends the chain; do not run a second PI acceptance phase after it.
   Only the formal Schema 2.3 FDD and handoff path is supported.

## Judgment Rules

- Implement only approved semantics. Return ambiguity or missing business meaning to FDD instead of inventing it.
- Treat `planned` as an honest reachable unavailable surface, never as permission to simulate success.
- Preserve a supplied release as the interaction baseline. In `design-led`, create the frontend required by the approved presentation contract instead of waiting for release source.
- Ship no debug or contract-demo panel in the delivered frontend; every E2E starts from the release page entry and operates provenance-matched release controls, never an injected surrogate surface or temporary form. Keep every release control anchor present after each business action, except a contract-declared `extend-flow` navigation.
- Use runtime-generated values across operation boundaries and real application behavior behind every native control.
- Keep external integrations behind adapters and expose contract-declared unavailable behavior when configuration is absent.
- In integrated campaigns, read the application-only `VALIDATION_OPERATION_TOKENS` map and attach the token for the current operation as `x-validation-operation-token` on each external invocation; never expose this map to browser E2E.
- Separate visual fidelity from business acceptance; satisfy both when required.
- Treat runner-computed completion and campaign-owned integration observation as authoritative.
- Machine verification judges observable outcomes and evidence only — never implementation choices. This skill's guidance tells you how to proceed; frameworks, code organization, and internal patterns remain yours. A gate that prescribes how code must be written, rather than what must be observably true, is out of contract.

Detailed output, evidence, binding, BMAD, browser, placeholder, lock, and campaign contracts live only in [input-contract.md](references/input-contract.md) and [campaign-contract.md](references/campaign-contract.md).
