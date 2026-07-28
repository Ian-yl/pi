---
name: project-implementation
description: Implement and verify a complete project from an approved functional-domain package and implementation handoff. Use when generating backend APIs, persistence, integrations, frontend API wiring, contract tests, end-to-end tests, startup manifests, or deployment artifacts without guessing business behavior.
---

# Project Implementation

## North Star

交付物是原页面真实用户可用的产品。自检想象：删掉你新增的一切辅助 UI 后，全部业务仍能从 release 原生控件出发完成。验证器只是在替这个用户提问。

## Workflow

1. Read `<skill-dir>/references/input-contract.md`.
2. Prepare the locked workspace:
   ```bash
   node <skill-dir>/scripts/prepare-implementation.mjs \
     --functional <functional-domain-package> \
     --handoff <approved-implementation-handoff> \
     --output <implementation-workspace>
   ```
3. Return missing or inconsistent domain semantics to FDD; preserve explicitly `planned` capabilities as reachable “功能待实现” surfaces.
4. Implement `implementation-plan.json` in dependency order: persistence, domain rules, APIs, integrations, frontend wiring, presentation, tests, startup, and deployment. Follow `implementation-worklist.json` control by control as the recommended path, then use `field-binding-plan.json` for field-level data flow. Run BMAD `dev-story` and `code-review` for every story.
5. Preserve `input-lock.json`; regenerate the workspace when an input changes.
6. Generate the manifests and runtime configuration required by [the input contract](references/input-contract.md). Before finalization ask exactly: ① 原页面的用户会察觉到任何真实变化吗？② 删掉你新增的全部 UI，功能还在吗？③ 每个原生控件背后是真实后端行为吗？
   ```bash
   node <skill-dir>/scripts/finalize-implementation.mjs --dir <implementation-workspace>
   ```
7. Establish `integrated` status only through the contract-declared application E2E and campaign-controlled external observation. Repeated qualification uses `<skill-dir>/scripts/run-validation-campaign.mjs` and [the campaign contract](references/campaign-contract.md).
8. Verify:
   ```bash
   node <skill-dir>/scripts/verify-implementation.mjs <implementation-workspace> --require-level integrated
   ```
   Only the formal Schema 2.3 FDD and handoff path is supported.

## Judgment Rules

- Implement only approved semantics. Return ambiguity or missing business meaning to FDD instead of inventing it.
- Treat `planned` as an honest reachable unavailable surface, never as permission to simulate success.
- Preserve the release as the interaction baseline; add UI only where the approved presentation contract requires it.
- Ship no debug or contract-demo panel in the delivered frontend; every E2E starts from the release page entry and operates provenance-matched release controls, never an injected surrogate surface or temporary form. Keep every release control anchor present after each business action, except a contract-declared `extend-flow` navigation.
- Use runtime-generated values across operation boundaries and real application behavior behind every native control.
- Keep external integrations behind adapters and expose contract-declared unavailable behavior when configuration is absent.
- Separate visual fidelity from business acceptance; satisfy both when required.
- Treat runner-computed completion and campaign-owned integration observation as authoritative.
- Machine verification judges observable outcomes and evidence only — never implementation choices. This skill's guidance tells you how to proceed; frameworks, code organization, and internal patterns remain yours. A gate that prescribes how code must be written, rather than what must be observably true, is out of contract.

Detailed output, evidence, binding, BMAD, browser, placeholder, lock, and campaign contracts live only in [input-contract.md](references/input-contract.md) and [campaign-contract.md](references/campaign-contract.md).
