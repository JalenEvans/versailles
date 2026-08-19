# Spec: Deterministic Generation

**ID:** SPEC-dg
**Lifecycle:** draft
**Owner:** associate-head-coach
**Threshold:** data (generated test files + `generated/coverage.json` are pipeline artifacts), public-api (the emitter plugin seam and the generated test surface), state (the `generated/` directory is tool-owned state, regenerated full-file; regeneration is an irreversible, idempotent transition)
**Linked contract:** `docs/contracts/deterministic-generation.contract.yaml`
**Canonical source:** `~/.opencode/skills/spec-builder/references/spec.template.md`

---

## Behavioral Intent

The generator is the core value proposition of Versailles (ADR-0002): a pure, deterministic compiler from approved contracts to test files — same context in, byte-identical suite out, with no LLM invoked anywhere at generation time or anywhere in the tool (ADR-0010). It builds a framework-agnostic test-case IR covering boundary values, equivalence partitions, precondition-violation cases, postcondition-satisfaction cases, per-component invariant tests, and expected-rejection cases for the postcondition/invariant interaction bug class (build-spec §9.1–§9.2). Predicate-call preconditions (e.g. `isPositive(amount)`) are planned too: at least one deterministic violation case per predicate call, or an explicit non-silent warning — never a silent zero — and valid-input synthesis is predicate-aware, so a registered predicate guard never receives a value it rejects (build-spec §9.1). Emitters render shape-aware calls from manifest method metadata (instance → `new <Component>().<op>(...)`, static → `<Component>.<op>(...)`, void-return acceptance without return assertions — with accept/invariant cases on void-returning **instance** operations bound to the component **instance** so assertions target instance state, never the void return value; a **static** void operation with assertions renders the bare call without any `instance.<field>` assertion, since the static call never touches a constructed instance) and import components via `sourcePath`-derived module paths that resolve to the real source file from the generated file's directory (build-spec §9.4; VERSAILLES-24/26, VERSAILLES-26 follow-up). A planned operation with no matching source method is never emitted as an unrunnable static call: it surfaces a non-silent non-blocking `UNPLANNABLE_OPERATION` warning — same tier as `PREDICATE_UNPLANNABLE`, exit 0, warning in `CliResult.warnings` (build-spec §9.1; VERSAILLES-25). The guard fires whenever the component's entry carries a `methods` key — empty or not — missing the planned op: an empty map `{}` on a refreshed entry still warns for every planned op; only preserved legacy entries lacking the `methods` key entirely keep the legacy default (VERSAILLES-25 follow-up). Rejection assertions — on both §9.1 precondition-violation cases and §9.2 expected-rejection cases — use the rejection idiom configured in `config.json` (default `throws`) (ADR-0007). Every generated test carries a traceability comment, and `generated/coverage.json` maps clause IDs → test IDs so a clause with zero generated tests is detectable (build-spec §9.3). Output is rendered by per-framework emitter plugins (vitest, xUnit, pytest per ADR-0009) into the tool-owned `generated/` directory via idempotent, full-file regeneration (build-spec §9.4).

## Scope

**In scope:**
- Running only against a context where `isValid: true`; invalid contexts block generation (build-spec §9).
- Test-case IR production and case planning (build-spec §9.1–§9.2):
  - Boundary values: for every numeric comparison in preconditions, cases at the boundary, boundary−1, and boundary+1.
  - Equivalence partitions: for every `in` clause or enum-typed field, one case per partition member plus one case outside the set.
  - Precondition-violation cases: for each precondition clause individually, an input satisfying all *other* clauses but falsifying this one; assert rejection.
  - Predicate-call precondition coverage: at least one violation case per predicate-call precondition, synthesized deterministically from the registered predicate's `paramTypes` and registry example hints; a genuinely unplannable predicate call surfaces an explicit non-silent warning — never a silent zero.
  - Predicate-aware valid-input synthesis: a param guarded by a registered predicate always receives a value the predicate accepts (deterministic, registry-hint-derived), never an input the operation would reject.
  - Postcondition-satisfaction cases: valid inputs asserted against every postcondition, with `old(field)` resolved against captured pre-call state.
  - Per-component invariant tests: valid pre-state satisfying all invariants, call with valid inputs, assert every invariant post-call.
  - Expected-rejection cases: inputs that satisfy the operation's postcondition but would violate a component invariant — the operation should refuse to complete.
- Rejection idiom from config (default `throws`) applied to **both** the §9.1 precondition-violation surface **and** the §9.2 expected-rejection surface (ADR-0007).
- Traceability: every generated test carries a traceability comment with the contract clause IDs it covers; `generated/coverage.json` maps clause ID → test IDs so zero-coverage clauses are detectable (build-spec §9.3).
- The emitter plugin seam selected by `config.testFramework` — vitest (`*.test.ts`), xUnit (`*.Tests.cs`), pytest (`test_*.py`), the full ADR-0009 matrix; emitters render the framework-agnostic IR (input values, expected outcome, assertions, traceability comment) to real test syntax (build-spec §9.4, ADR-0008).
- Shape-aware emission: calls render from manifest method metadata — instance methods via `new <Component>().<op>(...)`, static methods via `<Component>.<op>(...)`, params passed positionally in declared order, void-return accept cases without return-value assertions, and accept/invariant cases on void-returning **instance** operations bound to the component **instance** (`const instance = new <Component>(); instance.<op>(...); expect(instance.<field>)...`) so assertions target instance state, never the void return value; a **static** void operation with assertions renders the bare call with no `instance.<field>` assertion, since the static call never touches a constructed instance (build-spec §9.4; VERSAILLES-26, VERSAILLES-26 follow-up).
- Resolvable module imports: module import specifiers derive from project-root-relative POSIX manifest `sourcePath` entries, computed relative to the generated file's directory so they resolve to the real source file — not merely a matching extension or suffix — with a deterministic default fallback (build-spec §9.4; VERSAILLES-24).
- Non-silent warnings for unrenderable operations: a planned operation with no matching method metadata and no resolvable source method surfaces a non-blocking `UNPLANNABLE_OPERATION` warning (same tier as `PREDICATE_UNPLANNABLE` — `CliResult.warnings`, exit 0) and is never emitted as the legacy static options-object call (build-spec §9.1; VERSAILLES-25). The guard fires whenever the component's entry carries a `methods` key — empty or not — missing the planned op: an empty map `{}` on a refreshed entry is the first-class zero-methods signal and still warns for every planned op; only preserved legacy entries lacking the `methods` key entirely keep the legacy default (VERSAILLES-25 follow-up).
- Full-file, idempotent regeneration: two runs on the same context produce byte-identical output; `generated/` is fully tool-owned and never hand-edited (build-spec §9.4).
- No LLM invocation at generation time or anywhere in the tool (ADR-0010).

**Out of scope:**
- SMT-backed precise input synthesis (v2 stretch, build-spec §9.5) — designed for via the frozen AST, deferred.
- Running/executing the generated tests — the generator writes files, it does not run them.
- Emitters beyond the ADR-0009 matrix — the seam dispatches the complete set (vitest, xUnit, pytest); additional frameworks are future work.
- Semantic validation of contracts (contract-language) and manifest derivation (manifest-extraction) — consumed via the context only.
- Any LLM involvement: no LLM client, no prompting logic, no retry loop (ADR-0010).

## Behavior

### Regeneration is deterministic, idempotent, and LLM-free

- **Given** a `.versailles/` context where `isValid: true` and existing output under `generated/` from a prior run
- **When** `versailles generate` runs twice on the same context
- **Then** the output under `generated/` is byte-identical across runs, no LLM is invoked during generation, and the directory is regenerated full-file from `contracts.json` — tool-owned state, never hand-edited, never treated as an input (ADR-0002, ADR-0010, build-spec §9.4)

### Invalid contexts block generation

- **Given** a workspace with parse or semantic validation errors (`isValid: false`)
- **When** `versailles generate` runs
- **Then** the command is rejected, no test files are written, and the failure surfaces the structured errors (build-spec §9)

### Case planning covers boundaries and partitions

- **Given** an operation with a numeric precondition comparison (e.g. `x >= 0`) and an `in` clause or enum-typed field
- **When** the generator plans operation cases
- **Then** boundary cases exist at the boundary, boundary−1, and boundary+1, and equivalence partitions exist as one case per member plus one case outside the set (build-spec §9.1)

### Precondition-violation and expected-rejection cases assert the configured rejection idiom

- **Given** an operation with precondition clauses, and `config.json` rejection idiom defaulting to `throws`
- **When** the generator emits §9.1 violation cases and §9.2 postcondition/invariant interaction (expected-rejection) cases
- **Then** for each precondition clause there is an input satisfying all other clauses but falsifying this one, and both violation and expected-rejection tests assert rejection using the configured rejection idiom — configurable, default `throws` (ADR-0007, build-spec §9.1–§9.2)

### Predicate-call preconditions get violation coverage or an explicit warning

- **Given** an operation with a predicate-call precondition (e.g. `isPositive(amount)`) whose predicate is registered with `paramTypes` and (optionally) example hints
- **When** the generator plans operation cases
- **Then** at least one violation case is synthesized deterministically for that predicate call — or, when no violation input is derivable, an explicit non-silent warning is surfaced; zero cases are never emitted silently (build-spec §9.1)

### Valid-input synthesis is predicate-aware

- **Given** an operation with a predicate-guarded param (e.g. `isPositive(amount)`)
- **When** the generator synthesizes valid inputs for satisfaction/invariant cases
- **Then** the param receives a value the registered predicate accepts (e.g. a positive amount, never `0` for `isPositive`), derived deterministically from registry example hints or `paramTypes`-aware defaults (build-spec §9.1)

### Emitted calls match the extracted method shape

- **Given** manifest method metadata recording `placeOrder` as an instance method with positional params `[x]` and a void return, `create` as a static method, and `sourcePath` entries for their components
- **When** the emitter renders generated tests
- **Then** instance calls render `new OrderService().placeOrder(x)`, static calls render `OrderService.create(...)`, params pass positionally in declared order, void accept cases carry no return-value assertion, and imports derive from `sourcePath` module paths (deterministic default when absent) (build-spec §9.4)

### Instance void-operation accept/invariant cases assert instance state

- **Given** a void-returning **instance** operation (e.g. `Order.addItem(...)` returning `void`) and an accept/invariant case that must assert component state (e.g. `subtotal`)
- **When** the emitter renders the case
- **Then** the case binds the component instance and calls on it — `const instance = new Order(); instance.addItem("initial"); expect(instance.subtotal)...` — assertions target instance state, never the void return value; no `const result = ...` binding is created for a void call (build-spec §9.4; VERSAILLES-26)

### Static void operations with assertions render a bare call

- **Given** a static void-returning operation (e.g. `OrderService.reset()` with `static: true`, `returnType: "void"`) whose accept case carries assertions (e.g. asserting `subtotal`)
- **When** the emitter renders the case
- **Then** the case renders the bare static call — `OrderService.reset(...);` — with **no** `const instance = new OrderService();` binding and **no** `expect(instance.<field>)` assertion, because the static call never touches a constructed instance; asserting on one would be misleading (false red or false green) (build-spec §9.4; VERSAILLES-26 follow-up)

### Planned operations missing from source warn, never emit dead calls

- **Given** a planned operation with no matching method in the source manifest (no method metadata and no resolvable source method, e.g. staged `Order.setSubtotal` with no `setSubtotal` in `src/order.ts`)
- **When** the generator plans/emits the suite
- **Then** a non-silent non-blocking `UNPLANNABLE_OPERATION` warning appears in `CliResult.warnings` (exit 0 — same tier as `PREDICATE_UNPLANNABLE`) and the generated surface contains no unrunnable static options-object call for that operation (build-spec §9.1; VERSAILLES-25)

### Zero-method refreshed components still warn for every planned op

- **Given** a refreshed manifest entry carrying `methods: {}` (the first-class zero-methods signal — the component truly has no methods) and a planned operation on that component
- **When** the generator plans/emits the suite
- **Then** the `UNPLANNABLE_OPERATION` guard fires — the `methods` key is present and missing the planned op — the operation gets a non-silent warning, and no legacy static options-object call is emitted; an empty map is never treated as a preserved legacy entry (build-spec §9.1; VERSAILLES-25 follow-up)

### Import specifiers resolve to the real source file

- **Given** a covered component with project-root-relative `sourcePath` `src/order.ts` in a nested layout (`<root>/src/order.ts` exists)
- **When** the emitter derives the module import specifier
- **Then** the specifier resolves to the real source file from the generated file's directory (verified against the filesystem) — not a path joined against a source-root-relative value like `order.ts` and not merely a matching extension or suffix (build-spec §9.4; VERSAILLES-24)

### Postcondition-satisfaction resolves `old(...)`; invariants are preserved

- **Given** an operation with postconditions (possibly referencing `old(field)`) and a component with invariants
- **When** the generator emits satisfaction and invariant-preservation cases
- **Then** satisfaction cases assert every postcondition on the result with `old(field)` resolved against captured pre-call state, and invariant tests build a valid pre-state, call with valid inputs, and assert every invariant still holds post-call (build-spec §9.1–§9.2)

### Traceability and coverage are machine-checkable

- **Given** a generated test suite and `generated/coverage.json`
- **When** any contract clause ID is queried
- **Then** the generated tests covering it are identifiable via traceability comments and the coverage manifest maps clause ID → test IDs, so a clause with zero generated tests is detectable (build-spec §9.3)

## Constraints

- `must_not` run generation against a context where `isValid: false` — invalid contracts block generation (build-spec §9).
- `must_not` invoke an LLM at generation time or anywhere in the tool — no LLM client, no prompting logic, no retry loop (ADR-0010, ADR-0002).
- `must_not` hardcode "throws" in rejection assertions — rejection assertions read the configured idiom from `config.json` and apply it to both §9.1 violation and §9.2 expected-rejection surfaces (ADR-0007).
- `must_not` place framework-specific rendering logic in the core — all rendering lives behind the emitter plugin seam (ADR-0008).
- `must_not` treat hand-edited `generated/` content as source or preserve it — the directory is fully tool-owned and full-file regenerated (build-spec §9.4).
- `must_not` emit a coverage manifest that hides gaps — every clause maps to its generated test IDs; zero-coverage clauses remain detectable (build-spec §9.3).
- The generator `must_not` be nondeterministic — same context in, byte-identical suite out, no randomness, no timestamps, no LLM (ADR-0002).
- The generator `must_not` emit zero tests for a predicate-call precondition silently — a genuinely unplannable predicate call surfaces an explicit non-silent warning (build-spec §9.1).
- The generator `must_not` emit a "valid" input that a registered predicate in the operation's preconditions would reject — predicate-aware synthesis must satisfy registered predicates (build-spec §9.1).
- The generator `must_not` render calls that mismatch the extracted method metadata — static calls on instance methods, options-object argument lists where positional params are declared, return-value assertions on void operations, or `instance.<field>` assertions on static void operations (build-spec §9.4; VERSAILLES-26 follow-up).
- The generator `must_not` emit the legacy static options-object call (`<Component>.<op>({ ...inputs })`) for a planned operation with no matching method metadata and no resolvable source method — it must surface a non-silent `UNPLANNABLE_OPERATION` warning instead. The guard fires whenever the component's entry carries a `methods` key — empty or not — missing the planned op; only preserved legacy entries lacking the `methods` key entirely may keep the legacy default (build-spec §9.1; VERSAILLES-25, VERSAILLES-25 follow-up).
- The generator `must_not` bind a result for a void-returning accept/invariant case and assert `result.<field>` — assertions target the component instance (`const instance = new <Component>(); instance.<op>(...); expect(instance.<field>)...`), never the void return value; and it `must_not` assert `instance.<field>` on a static void operation's accept case — the static call never touches a constructed instance, so the case renders the bare call without assertions (build-spec §9.4; VERSAILLES-26, VERSAILLES-26 follow-up).
- The generator `must_not` emit an import specifier that fails to resolve to the real source file from the generated file's directory — resolvability is required, not just a matching extension or suffix (build-spec §9.4; VERSAILLES-24).

## Non-Goals

- No SMT-backed witness synthesis for compound boolean preconditions or predicate calls (v2, build-spec §9.5) — v1 predicate planning uses deterministic heuristics over registry `paramTypes` + example hints.
- No test execution or CI running of generated tests — generation writes files only.
- No framework-specific emitters in the core — all rendering lives behind the emitter seam (ADR-0008), and no emitters beyond the ADR-0009 matrix (vitest, xUnit, pytest).
- No LLM involvement of any kind inside the tool (ADR-0010).
- No hand-editing of `generated/` as a supported workflow (build-spec §9.4).

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial draft from build-spec §9, §2; ADR-0002/0007/0008/0009/0010 |
| 2026-08-13 | associate-head-coach | Removed Linked Plans section — execution plans are tracked outside the public repo |
| 2026-08-16 | associate-head-coach | Superseded "vitest first / no xUnit-pytest in the first milestone" scope — the full ADR-0009 emitter matrix (vitest, xUnit, pytest) is shipped (PR feat/review-ecosystem) |
| 2026-08-17 | general-manager | Mirrored contract changes (PR fix/generator-emitter-runnability): predicate-call preconditions get violation coverage or an explicit warning (never silent zero), predicate-aware valid-input synthesis, and shape-aware emission from manifest method metadata + sourcePath module paths — backs VERSAILLES-20/22/23 |
| 2026-08-18 | general-manager | Mirrored contract changes (PR fix/generator-emitter-runnability): (V-24) emitted import specifiers must resolve to the real source file from project-root-relative POSIX sourcePath; (V-25) planned operations with no matching source method surface a non-silent UNPLANNABLE_OPERATION warning and never emit an unrunnable static call; (V-26) void-operation accept/invariant cases assert component instance state — backs VERSAILLES-24/25/26 |
| 2026-08-18 | general-manager | Mirrored the review-warning contract follow-ups (fix/generator-emitter-runnability): (W3/VERSAILLES-25) the UNPLANNABLE_OPERATION guard fires whenever the component's entry carries a methods key — empty or not — missing the planned op, so a refreshed zero-method component's methods: {} is never treated as a legacy entry; (W1/VERSAILLES-26) a static void operation with assertions renders the bare call with no instance.<field> assertion — instance-state assertions stay reserved for instance void operations |