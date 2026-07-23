# Input And Output Contract

## Functional input

The functional package uses schema `1.0` or `2.0`, keeps the same version across formal domain files, has status `approved`, contains no unresolved blockers, and includes `review-receipt.json` plus a valid `package-lock.json`. It also includes FDD-owned `planning-manifest.json`, `planning-artifacts.json`, `capability-definitions.json`, and `planning-review-receipt.json`. These are read-only planning provenance. Their capability, entity, relationship, journey, rule, permission, and integration sets exactly match the approved functional spec.

FDD planning uses workflow ID `fdd-bmad-planning`. PI implementation planning uses workflow ID `pi-implementation-bmad`. PI derives units and stories from approved IDs and acceptance contracts. A missing or inconsistent domain contract is returned to FDD rather than reinterpreted by PI.

## Implementation handoff input

The handoff directory contains:

- `handoff-manifest.json`: approval status, author, functional package digest, and visual release digest.
- `visual-source.json`, `release-manifest.json`, `suite-gate.json`, and `visual-approval.json`: copied ai-restore release identity, passing Gate and approval evidence, page/route closure, and original source tree digest.
- `frontend-manifest.json`: pages, routes, and copied source status.
- `functional-spec.json`: complete capabilities and business behavior copied from the approved domain package.
- `ui-implementation-plan.json`: presentation intent for each capability using `reuse-control`, `add-control`, `extend-flow`, `headless`, or `display-only`.
- `visual-controls.json`: advisory inventory for locating possible controls in the visual baseline.
- `api-contract.json`: operations, request/response shapes, capability IDs, rule IDs, effects, and errors.
- `handoff-review-receipt.json`: approval whose author matches the handoff manifest and whose reviewer differs.
- `handoff-lock.json`: exact digests for every formal handoff file, functional package lock, ai-restore release manifest, and original `web/` tree.
- `web/`: runnable frontend source.

`input-lock.json` records `functionalPackageDigest`, `visualReleaseDigest`, and `handoffPackageDigest`. The copied source receives a separate `implementationFrontendDigest`; API wiring may change the implementation copy while the read-only visual-source digest remains the handoff baseline.

## Readiness rules

- Every capability has a valid presentation intent.
- Every operation references known capabilities and rules.
- Every write operation declares entity effects and at least one failure response.
- No interaction, operation, or page uses an unresolved business ID.
- Entity identities, constraints, relationships, aggregate ownership, association keys, delete behavior, and consistency boundaries are implementable without schema inference.

## Implementation outputs

`field-binding-plan.json` is generated from the locked API and capability contracts. Each required binding records `controlId`, `capabilityId`, `statePath`, `operationId`, `requestPath`, `responsePath`, `effectIds`, and requiredness. Browser evidence writes a unique non-default value through every required user input and proves that exact value reaches the corresponding request field. A request emitted with a constant, missing, or independently fabricated value does not satisfy the binding.

`implementation-manifest.json` maps capabilities to source, operations, migrations, and test IDs. The implementation test command produces `unit-test-report.json`; each case declares exactly one covered `unitId` in `unitIds` and machine evidence under `evidence/`. A broad scenario may emit multiple cases that reference shared raw evidence. Finalization validates that every planned unit has its own passing case and writes the validated cases to `test-report.json`.

`implementation-provenance.json` sets `backendSource.status` to `implemented` and maps every operation ID to one or more source locations. Each location contains a workspace-relative `path` plus an exported `symbol` or `route` identifier. Verification resolves every path inside the implementation workspace.

The test command emits concrete standardized `operation-events.json`: observed request locations and values, response status/body, authorization decisions, validation/error cases, transaction or consistency observations, and before/after effects. Events must be captured by test adapters at the application HTTP/service/persistence/integration boundaries rather than assembled from expected fixtures. Finalization recomputes the contract result and writes digest-bound `operation-receipts.json`; candidate-authored booleans are not accepted as proof. The receipt establishes runner evaluation and event integrity inside the workspace, while campaign-controlled execution supplies the stronger external trust boundary. A shared route handler is valid only when each logical operation independently produces a passing runner-owned receipt.

Implementation produces `interaction-manifest.json` and `control-bindings.json` from the completed application. Bindings record capability, presentation mode, source path, source locator, and the operation used by an actionable interaction. `headless` capabilities are traced through backend provenance. A `display-only` capability uses a `bindingType: data-render` binding with a render `trigger`; it may reference its loading operation without creating a user interaction and may omit the operation when data is already local.

`frontend-runtime-config.json` supplies the implementation start command, health URL, and Playwright E2E command. Finalization deletes prior runtime reports, starts the application, executes the browser command, and creates runner-owned `browser-e2e-report.json` and `frontend-runtime-report.json`. Every raw case declares its page URL. The runner consumes one previously unused Playwright call per case in case order, binds it to the trace frame URL, and correlates the locator action, screenshot call, final `page.content()` DOM, and method/path/status network observations. A single action cannot attest multiple cases. Core DOM observations and the surface fingerprint are regenerated from the final active `<main>` only, excluding pre-action content.

For each declared `dataDependencies` entry, runtime verification extracts the source value from the observed source operation response and requires that same runtime-generated value at the declared target request path. Hard-coded IDs and separate fixture requests do not prove a chain. Transfer and integration semantics use the generic `resourceTransfer`, `resourceValidation`, `resourcePersistence`, `integrationBindings`, and `externalEffects` contracts; a file upload is only one possible contract instance.

The trace parser intentionally fails closed. It supports the Playwright trace ZIP and JSONL event structure covered by this project's compatibility tests; an incompatible Playwright trace version is a verification failure until the parser and tests are updated.

The formal handoff always contains `ui-implementation-plan.json`, including an all-headless plan. Browser runtime, frontend build, interaction/control manifests, and placeholder gates apply only when at least one plan entry has `presentation.mode` other than `headless`. An all-headless implementation still requires the formal input set, BMAD completion, backend/API tests, provenance, and source locks.

Prepared workspaces set `input-lock.json.bmadRequired` and lock each story's immutable unit contract: unit ID, type, dependencies, and acceptance criteria. BMAD may update story status, task checkboxes, development notes, and review records, but changing the embedded contract digest, removing a story, or changing the story-to-unit set invalidates verification. BMAD output remains inside the implementation workspace.

Normal verification accepts only formal schema `1.1` workspaces and requires the exact functional and handoff input set, BMAD artifacts, and applicable frontend runtime evidence. `verify-implementation.mjs` rejects `--legacy`; no caller-selected downgrade exists. Historical schema `1.0` material can only be inspected with `verify-legacy-archive.mjs`, whose result is explicitly non-release archive diagnostics and is not implementation completion evidence. The formal verifier parses Markdown sections outside fenced code and HTML comments, parses the sprint YAML mapping outside comments, and compares the Story's Unit, Type, Depends On, and Acceptance Criteria directly with the locked contract.

For schema `1.1`, `input-lock.json` uses a closed formal input set. Its digest keys must exactly equal all functional package and implementation handoff files, its algorithm is SHA-256, and its functional package, handoff package, and visual release source digests are recomputed from the copied formal inputs. Missing or extra digest entries are invalid.

Final verification also requires `bmad-completion.json`. Completion records form an exact one-to-one set with implementation-plan units: missing, duplicate, unknown, and extra unit IDs are rejected. Every unit's story is `done` or `completed`, contains no unchecked task, includes a Dev Agent Record and an independently identified Code Review Record, and has a matching completed entry in `sprint-status.yaml`. The completion receipt binds the final story digest, development agent, review agent, and their completion states. BMAD completion complements machine tests; it does not replace them.

Campaign candidates cannot copy over `inputs/`, `input-lock.json`, `implementation-plan.json`, `bmad-traceability.json`, or `_bmad-output/`. The campaign rechecks the prepared input snapshot after candidate copy, every install command, and finalization.

`placeholder-resolution.json` classifies each business surface as API data, user input, an explicit empty state, static decoration, or a non-production demo fixture. `placeholder-audit-report.json` rejects unresolved business placeholders, production demo fixtures, mock success fallbacks, and missing empty/loading/error/success states. Backgrounds, icons, and declared decoration remain valid visual assets.

Capabilities with an activation/surface contract are clicked individually. For `complete` capabilities, runtime evidence records `activeCapabilityId`, final `implemented` status, input IDs, primary action/operation, empty state, and required regions; verification rejects disabled entries, stale content, fake success, and surfaces that differ only by heading. For `planned` capabilities, evidence instead proves a reachable click, matching `activeCapabilityId`, a changed capability-specific surface containing its name and “功能待实现”, no business network request, and no implemented claim.

The UI plan capability IDs form an exact one-to-one set with the functional capability IDs; duplicates, omissions, and extras are rejected before implementation. Planned capabilities cannot be headless. Their final active `<main>` contains no domain input, primary operation, or stale result/output region. Input, command, and display evidence is accepted only when it is attached to the same declared operation ID, HTTP method, and contract path; an unrelated request in the same action window cannot attest a binding.

An implemented interaction carries an operation ID when its capability declares API operations or its presentation declares `behavior: server-operation`. Navigation, local form state, zoom, result switching, local dialogs, and other client-only behavior can use interaction records without an operation ID.

`implementation-lock.json` locks both qualification metadata and classified implementation source. `sourceDigests` and `sourceFiles` cover backend code and package metadata, API-wired frontend source, migrations/schema files, tests, and deployment/infra files. The first successful verification establishes the lock; any existing lock must contain the complete supported schema, and later verification compares it and fails on added, removed, or changed implementation files. Verification does not silently relock malformed or downgraded locks.

The implementation plan creates persistence units for entities, relation-migration units for foreign/business keys and cardinality constraints, and consistency units for transaction, rollback, or convergence behavior. Each unit receives its own passing evidence before finalization.

Integrated evidence is produced through a declared application operation and a campaign-controlled observer. It binds the observed application request and response, declared effects, contract-selected scenarios, and contract-selected artifact assertions. The core defines no provider type, artifact format, or fixed failure vocabulary.

Standalone verification validates locked integrated evidence but does not independently establish how the candidate produced it. Release qualification at `integrated` level therefore uses `run-validation-campaign.mjs --level integrated`, which owns preparation, protected inputs, runtime execution, declared external-integration configuration, and application E2E.

The verifier computes `capability-completion-report.json`; candidate-authored status fields are not completion authority. A `complete` capability becomes `implemented` only after every required binding, operation, state, effect, acceptance case, and implementation unit passes. A `planned` capability remains `planned` only after its explicit reachable-state contract passes. The product is `implemented` when no planned capability remains, or `delivered-with-planned-capabilities` when all complete capabilities pass and every planned capability has a valid planned state. Open blockers and failed capabilities still fail verification. Levels are `simulated` and `integrated`; ordinary completion requires campaign-qualified `integrated`.
