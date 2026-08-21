# Ubiquitous Language — Versailles

The single vocabulary for the Versailles domain. Every document in this knowledge layer uses these terms with **these exact definitions** — a competing definition anywhere else is a doc bug, not a style choice. Add a term here before using it anywhere else, then link here from the domain, architecture, and feature docs.

Sources of authority: [build-spec.md](build-spec.md) (territory), accepted [decisions](decisions/index.md) (ADR-0001–0010), [specs/versailles.md](specs/versailles.md) (behavioral intent).

## Core terms

| Term | Definition | Owned by (bounded context) |
|---|---|---|
| contract | The Design-by-Contract specification for a component (an `invariants` block) or an operation (a `preconditions`/`postconditions`/`effects` block), stored in `contracts.json`. The single source of truth for test generation. | contract-language |
| clause | One invariant, precondition, or postcondition expression inside a contract, identified by a clause ID such as `OrderService.placeOrder.pre0`. Every generated test traces back to a clause. | contract-language |
| invariant | A clause that must hold for every instance of a component at all times — before and after every operation call. Scoped per component (Meyer/DbC), never per operation. | contract-language |
| precondition | A clause that must hold before an operation is called. An operation's valid inputs are exactly those satisfying all of its preconditions. | contract-language |
| postcondition | A clause that must hold after an operation returns. May reference `old(...)` to compare against pre-call state. | contract-language |
| effect | A declared mutation on a field (`mutate` \| `create` \| `delete`) attached to an operation. The generator uses effects to know which fields a postcondition-satisfaction test should assert against, and to scope invariant-preservation checks. | contract-language |
| expression | A boolean-valued string written in the contract expression grammar (build-spec §4.1). No assignment, no loops, no statements — anything outside the grammar is a parse error. | contract-language |
| component | A named unit in the target source (class/interface/type-level concept) that carries invariants and operations; keyed in both `contracts.json` and `manifests.json`. | contract-language |
| operation | A named function/method on a component, with params, preconditions, postconditions, effects, and its own `sourceHash`. | contract-language |
| AST | The canonical parse-tree node types produced by the contract parser (build-spec §4.3). Parser output contract; also the future input for SMT-backed generation (v2). | contract-language |
| structured error | A machine-readable error object (`contractId`, `field`, `position`, `found`, `expected`, `message` for parse; `contractId`, `code`, `field`, `detail` for validation). Downstream consumers (external LLM/agent, review UI, CI) render or re-inject it programmatically. The parser/validator **never** throw unstructured exceptions. | contract-language |
| predicate | A named, registered, verified-pure function callable from contract expressions; stored in `predicates.json` with params, paramTypes, returnType, sourceRef, sourceHash, `verifiedPure`. | predicate-registry |
| verifiedPure | The registration flag asserting a predicate has no side effects and always terminates. Manually asserted at registration-time lint/review (ADR-0006, build-spec §14 default). The semantic validator hard-errors on `verifiedPure: false` or missing — unverified predicates cannot be referenced in contracts. | predicate-registry |
| manifest / field manifest | The per-component record of field name → typeRef, derived from source by static analysis and stored in `manifests.json`. Never hand-authored, never LLM-authored blind (ADR-0005). | manifest-extraction |
| typeRef | The grammar for field and param types: `string \| number \| boolean \| <ComponentName> \| list<typeRef> \| optional<typeRef> \| enum<v1,v2,...>`. Field references resolve transitively through the flat manifest map. | manifest-extraction |
| low-confidence field | A manifest field whose type was inferred rather than declared (typical of dynamically-typed languages). Produces a non-blocking validator warning, never a hard error (ADR-0004). | manifest-extraction |
| sourceHash | The structural hash linking an artifact to source. Manifest entries hash sorted field name+type pairs; contract operations hash signature+docstring; predicates hash function implementation. Staleness is detected by recomputing and comparing these hashes. | manifest-extraction |
| extractor plugin | The per-language manifest extractor selected by `config.language`: TypeScript (`ts.createProgram` + type checker), C# (Roslyn), Python (`ast` + typing introspection). One of the two pluggable edges (ADR-0008, ADR-0009). | manifest-extraction |
| source root | A directory under `config.sourceRoots` scanned by the extractor plugin to derive field manifests. Extraction never scans outside the declared source roots. | manifest-extraction |
| sourcePath | The project-root-relative path (POSIX separators) of the source file a covered manifest entry was extracted from — e.g. `src/order.ts`, never source-root-relative (`order.ts`) and never absolute. The generator derives resolvable module import specifiers from it (`join(cwd, sourcePath)` computed relative to the generated file's directory). When no project root is derivable (projectRoot omitted + disjoint source roots), the fallback is the file relative to `sourceRoots[0]` when that yields a relative path, or the field is omitted — never the absolute file path. | manifest-extraction |
| method metadata (`methods`) | The per-component map of method name → `{ static: boolean, params: string[], returnType?: string }` recorded on a manifest entry by the extractor. Every entry **refreshed by an extract run always carries the key** — possibly `{}`, the first-class "we know this component has zero methods" signal that keeps the planner's `UNPLANNABLE_OPERATION` guard firing for any planned op; only preserved legacy entries the extractor never touched may lack it. | manifest-extraction |
| config | The `config.json` object in the `.versailles/` workspace: `grammarVersion`, `schemaVersion`, `sourceRoots`, `language`, `testFramework`, `generatedDir`, `staleness` settings, and the rejection idiom. Loaded only as part of the joint unit. | workspace-context |
| VersaillesContext | The single merged view of the `.versailles/` workspace — config, contracts, manifests, predicates, parsed ASTs, parse error list, validation errors/warnings, and an `isValid` flag — produced by joint loading. | workspace-context |
| `.versailles/` workspace | The versioned tool-state directory (`config.json`, `contracts.json`, `manifests.json`, `predicates.json`, `generated/`) loaded as one unit; no file is valid to interpret in isolation. | workspace-context |
| version gate | The hard check that `config.grammarVersion` / `config.schemaVersion` match the tool's supported versions. Mismatch is a hard error with an upgrade-path message, never a silent best-effort parse. | workspace-context |
| scoped extraction | The loader helper that returns just one component/operation sub-object plus its errors — what the human review UI shows instead of the whole file. | workspace-context |
| staged contract | A validated contract object awaiting human review — produced by an external agent via the CLI, not yet part of `contracts.json`. | review |
| approved contract | A staged contract merged into `contracts.json` by a human reviewer via single-object read-modify-write of just that key. The merge commit IS the approval (ADR-0003). | review |
| generated test | A test file under `generated/` produced deterministically by the generator. Fully tool-owned — never hand-edited, always regenerated from `contracts.json`. | deterministic-generation |
| test-case IR | The generator's framework-agnostic intermediate representation — input values, expected outcome, assertion list, traceability comment — which output emitters render into real test-file syntax. | deterministic-generation |
| emitter plugin | The per-framework output renderer selected by `config.testFramework`: vitest (`*.test.ts`), xUnit (`*.Tests.cs`), pytest (`test_*.py`). The second pluggable edge (ADR-0008, ADR-0009). | deterministic-generation |
| boundary value | A test input at, just below, and just above a numeric comparison threshold in a precondition (e.g. `x >= 0` → cases at 0, −1, +1). | deterministic-generation |
| equivalence partition | A set of inputs treated alike by the contract: one case per member of an `in` clause / enum-typed field, plus one case outside the set. | deterministic-generation |
| precondition-violation case | A generated test whose input satisfies all *other* precondition clauses but falsifies the one under test, asserting the operation rejects it per the configured rejection idiom. | deterministic-generation |
| postcondition-satisfaction case | A generated test whose valid input (satisfying all preconditions) asserts the simple field-compare postconditions (`field op expr`) on the result — or on the bound instance state for a void-returning instance operation — resolving `old(...)` against captured pre-call state; non-computable clauses (predicate calls, both-side field refs) contribute no assertion, a conservative skip while the case still traces them. | deterministic-generation |
| invariant test | A per-operation test that builds a pre-state satisfying all component invariants, calls the operation with valid inputs, and asserts every invariant still holds post-call. | deterministic-generation |
| rejection idiom | The configurable way a precondition-violation test asserts rejection (default `throws`; error-return/Result idioms possible) (ADR-0007). | deterministic-generation |
| coverage manifest | `generated/coverage.json`, mapping contract clause IDs → generated test IDs so a clause with zero generated tests is detectable. | deterministic-generation |
| traceability comment | An annotation on each generated test listing the contract clause IDs it covers, e.g. `// versailles: OrderService.placeOrder.pre0 (violation case)`. | deterministic-generation |
| generated directory | The tool-owned output directory (default `.versailles/generated/`, configurable via `config.generatedDir`) where the generator writes test files and `coverage.json`. Never hand-edited — always regenerated from `contracts.json`. | deterministic-generation |
| rejected command | A `versailles` invocation that fails to run because the context is invalid (parse/validation errors), stale while blocking, or version-mismatched. It exits with a structured error result and a distinct exit code — never a silent partial run, never an unstructured throw. | (cross-cutting, CLI) |
| exit code | The numeric command result: `0` clean, `1` parse/validation error, `2` staleness violation (when blocking). Distinct codes let CI branch behavior. | (cross-cutting, CLI) |
| audit trail | Git history — the per-object merge commits and `git blame` — that records who approved what and when. There are no `approvedBy`/`approvedAt` fields in the schema (ADR-0003). | review |
| agent iteration | The external agent's write → validate → read-errors → fix → re-run cycle against the CLI's machine-readable output. The iteration contract lives between the agent and the CLI, not inside the tool (ADR-0010). | (cross-cutting, external) |

## Domain events / state transitions

Events here are records of deterministic state transitions in the pipeline (the tool's "what happened"), not async messaging. Names are canonical — use them verbatim in feature and domain docs.

| Event | Meaning | Emitted by |
|---|---|---|
| `manifestUpdated` | An extractor plugin wrote/updated a component's manifest entry (with recomputed structural `sourceHash`). | manifest-extraction |
| `contextLoaded` | The loader produced a `VersaillesContext` with parsed ASTs and validation results (`isValid: true/false`). | workspace-context |
| `contractInvalid` | Parse or semantic validation found hard errors; downstream commands reject. | contract-language / workspace-context |
| `contractStaged` | A validated contract object entered the review queue (via the external agent flow) after parse + semantic validation passed. | review |
| `contractApproved` | A reviewer merged the single object into `contracts.json` (read-modify-write of one key); recorded by git as a merge commit. | review |
| `contractDeclined` | A reviewer did not approve; no merge commit is created, so the staged object never enters the audit trail. | review |
| `generationRun` | The deterministic generator wrote full-file test output under `generated/` and refreshed `generated/coverage.json`. | deterministic-generation |
| `stalenessDetected` | `versailles check` recomputed a `sourceHash` and found drift; blocking behavior follows `config.staleness.blockOnStale`. | manifest-extraction / contract-language (via check) |
| `predicateRegistered` | A named predicate was added to `predicates.json` with `verifiedPure` set (registration-time purity review). | predicate-registry |

## CLI commands (the application-layer surface)

| Command | Purpose | Primary context |
|---|---|---|
| `versailles init` | Scaffold `.versailles/` with empty/default files. | workspace-context |
| `versailles extract-manifests` | Run the manifest extractor for `config.language`, update `manifests.json` (no implicit pruning; `--prune` removes stale entries explicitly). | manifest-extraction |
| `versailles validate` | Parse + semantically validate all of `contracts.json`, print the structured report. | contract-language (via workspace-context) |
| `versailles check` | CI-mode: validate + staleness check with proper exit codes. | workspace-context + contract-language + manifest-extraction |
| `versailles generate` | Run the deterministic test generator; write to `generated/`. | deterministic-generation |
| `versailles review <component> [operation] [--approve|--reject]` | Launch the scoped review flow for a staged/pending contract; `--approve` merges the single object, `--reject` writes nothing (`contractDeclined`). | review |
| `versailles register-predicate <name> --source <Module.functionName> [--verifiedPure]` | Register/update one predicate entry with mechanically verified `sourceRef`/`sourceHash`; `verifiedPure` only via the human registration gate. | predicate-registry |
| `versailles verify-purity <name>` | Flip `verifiedPure` true for a registered predicate after manual lint; never recomputes `sourceRef`/`sourceHash`. | predicate-registry |
| `versailles remind-unverified` | Report the predicates with `verifiedPure` missing/false (with their `sourceRef`); never writes. | predicate-registry |

There is **no** `versailles author` command — contract authoring is an external agent workflow that drives the commands above and reads their machine-readable output (ADR-0010).

See [architecture/index.md](architecture/index.md) for how the commands bind the contexts and [features/index.md](features/index.md) for the user-visible capabilities.