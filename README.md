# project-implementation

从 FDD 已批准的正式领域包、FDD planning BMAD 产物和 implementation handoff 生成、验证完整项目。PI 内部 BMAD 只负责实施 story、dev-story 和 code-review；领域语义以 FDD 合同为唯一权威。

## 项目结构

```text
skills/project-implementation/  # 可安装的完整 Skill
scripts/                        # 准备、finalize、provider 与 campaign 命令
references/                     # 输入输出契约
tests/                          # 契约和 Skill bundle 测试
assets/                         # 历史样例与验证资料
```

Skill 入口：[skills/project-implementation/SKILL.md](skills/project-implementation/SKILL.md)

## 运行环境

- Node.js 20+
- 候选项目对应的包管理器和运行时

## 使用流程

```bash
npm run implementation:prepare -- \
  --functional <approved-functional-package> \
  --handoff <approved-implementation-handoff> \
  --output <implementation-workspace>

# prepare 会锁定 FDD planning artifacts，并按 implementation-plan 为每个实现单元生成 PI BMAD story、
# sprint-status.yaml、bmad-traceability.json 和 pending bmad-completion.json

# 在 implementation-workspace 中完成实现，生成实际 interaction/control binding、
# frontend-runtime-config.json、placeholder-resolution.json 和测试
npm run implementation:finalize -- --dir <implementation-workspace>
npm run implementation:verify -- \
  <implementation-workspace> --require-level simulated
```

FDD planning 文件复制为 `inputs/functional-planning-*`，保持只读并进入 input lock。PI story 位于 `<implementation-workspace>/_bmad-output/implementation-artifacts/stories/`，traceability workflow 为 `pi-implementation-bmad`。逐项执行 BMAD `dev-story` 和 `code-review`，完成任务勾选、Dev Agent Record、独立 Code Review Record、sprint status 和 `bmad-completion.json`；缺少任一步都会被拒绝。PI 发现领域合同缺失或 planning 与正式 spec 不一致时返回 FDD。

`finalize` 会启动应用、等待健康检查、执行 Playwright E2E、捕获运行 DOM 与网络证据、审计业务占位内容，再生成 `frontend-runtime-report.json` 和 `browser-e2e-report.json`。非 headless 能力缺少真实运行证据时无法完成 simulated 验证。

准备阶段还会生成字段级 `field-binding-plan.json`。最终门禁逐项证明控件和唯一输入值进入前端状态及契约请求，operation 按自己的 method/path/content type、字段、鉴权、错误、事务和 effect 执行，响应再进入界面或后续 operation。`capability-completion-report.json` 由验证器计算，不能由候选项目自行声明完成。

FDD 中 `complete` 的能力必须真实实现，页面没有现成控件时 PI 按 presentation contract 补齐控件、状态和动作。`planned` 能力不阻断其他功能：PI 保留并接通其入口，进入后展示能力名称和“功能待实现”，但不得为它生成猜测 API、假数据、固定成功结果或仅改标题而复用其他能力内容。最终产品状态为 `delivered-with-planned-capabilities`，并分别报告 implemented 与 planned 数量。

如果 `ui-implementation-plan.json` 中全部能力都是 `headless`，正式输入文件仍须完整，但 `finalize` 不运行前端 build、浏览器 E2E 和占位审计；后端/API 测试、BMAD、实现溯源和源码锁仍然必须通过。

`verify-implementation` 只接受完整的正式 schema `1.1` workspace，并严格要求 functional/handoff 输入、BMAD 和适用的前端运行证据。该命令拒绝 `--legacy`，不存在调用者可选择的降级路径。历史 schema `1.0` 只能由 `verify-legacy-archive.mjs` 做非发布性质的结构审计，其结果不能作为实现完成证明。

单独执行 `verify-implementation --require-level integrated` 只复核工作区中已锁定 integrated 证据的结构、摘要和关联，不能建立候选项目之外的执行信任根。正式 integrated 资格必须通过 `run-validation-campaign.mjs --level integrated`：campaign 控制 prepare、受保护输入、应用启动、外部集成配置和 application-level E2E。

Integrated campaign 的外部 observer 地址和随机 challenge 只注入应用进程，不暴露给浏览器 E2E。出口证据必须发生在同一次入口请求期间，且外部 observer 返回的随机结果 ID 必须进入应用入口响应；E2E 直接请求 observer、分别制造入口和出口请求或由应用返回固定 fixture 都不能建立 integrated 资格。

对于 operation 的 `integrationBindings`，campaign observer 分别从应用入口请求和应用发出的外部请求提取字段值摘要，逐项要求 source 与 target 摘要相同。只用硬编码参数调用外部服务、遗漏用户输入或只在候选 evidence 中声明映射均不能通过 integrated 验证。

浏览器 runner 对受支持的 Playwright trace ZIP/JSONL 格式做 fail-closed 解析，并关联 callId、frame URL、动作、最终 DOM snapshot 和网络体。Playwright 升级若改变 trace 内部格式，验证会失败，需要先升级解析器和兼容测试。

重复验证：

```bash
npm run implementation:campaign -- \
  --functional <approved-functional-package> \
  --handoff <approved-implementation-handoff> \
  --candidate <candidate-implementation> \
  --output <campaign-output> \
  --count <positive-integer> \
  --level simulated
```

每个候选项目都必须用 `campaign-contract.json` 声明 copy、install、startup、health、环境与 E2E；通用编排器没有产品、框架、供应商或目录默认值。见 [references/campaign-contract.md](references/campaign-contract.md)。

## 开发

```bash
npm run skill:sync
npm test
```

修改根目录 `scripts/` 或 `references/` 后运行 `skill:sync`，将运行时资源同步到可分发 Skill。
