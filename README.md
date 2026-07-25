# project-implementation

从批准的 functional-domain package 和 implementation handoff 交付可运行、可验证的完整项目。PI 实现前端接线、后端、持久化、外部集成和运行验收，不修改或猜测领域语义。

Skill 入口：[skills/project-implementation/SKILL.md](skills/project-implementation/SKILL.md)

## Quick Start

```bash
npm run implementation:prepare -- --functional <approved-functional-package> --handoff <approved-implementation-handoff> --output <implementation-workspace>
npm run implementation:finalize -- --dir <implementation-workspace>
npm run implementation:verify -- <implementation-workspace> --require-level simulated
```

Prepare 还会生成非证据性的 `implementation-worklist.json`，推荐按 release 原生控件逐条完成接线。

契约唯一权威：[输入与完成合同](references/input-contract.md)、[qualification 合同](references/campaign-contract.md)。

## Repository

- `skills/project-implementation/`: distributable Skill
- `scripts/`: prepare/finalize/verify/campaign runtime
- `references/`: authoritative contracts
- `tests/`: generic contract tests
- `assets/golden-simulated/`: neutral end-to-end fixture

Requires Node.js 20+ and the candidate project's declared runtime.

## Development

```bash
npm run skill:sync
npm test
npm run skill:check
```

## 验证边界（宪法条款）

验证体系只裁决可观察结果与证据（值到达请求、数量对齐、资源互异、回填相等、外部调用由 campaign 独立观察），永不检查实现方式；SKILL 提供实现指引，框架选择与代码组织属于实现 agent。任何"规定代码写法"而非"规定可观察性质"的闸门都违反本契约。

## Quantity integrity and independent media

Capabilities producing independent media collections (`itemContract.mode: 'independent-media'`) are enforced at runtime: the browser must submit a non-default quantity; request quantity, response length, visible element count, and provider-call count must agree; and every item URL must fetch a distinct file (unique id, unique URL, distinct byte digest). `deliveryStatus: simulated-verified` is a prerequisite qualification for capabilities with an external `providerContract`; the completion declaration requires campaign-qualified `integrated` evidence. Content-level collages (N images each internally a grid) are bounded by provider `perCallConstraints`, integrated observation, and manual spot-check rather than mechanical detection.
