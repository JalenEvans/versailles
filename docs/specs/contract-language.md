# Spec: Contract Language

**ID:** SPEC-cl
**Lifecycle:** draft
**Owner:** associate-head-coach
**Threshold:** public-api (the expression grammar, AST node contract, and structured error contract are consumed by external agents, review UI, and CI), data (the parsed AST and validation results gate what enters `contracts.json`)
**Linked contract:** `docs/contracts/contract-language.contract.yaml` *(pending)*
**Canonical source:** `~/.opencode/skills/spec-builder/references/spec.template.md`

---

## Behavioral Intent

The contract language is the boolean-valued expression grammar (build-spec §4.1) that turns clause `expr` strings into the frozen AST node set (build-spec §4.3). The parser enforces structural constraints at parse time (build-spec §4.2) — `old(field)` is valid only in `postconditions[]`, and the grammar never produces assignments, loops, or statements — and the semantic validator (build-spec §5.1) checks field resolution, type compatibility, `in` operand shape, and predicate usage against the registered predicate registry. Both parser and validator always return structured error results (build-spec §4.4, §5.2), never unstructured throws, so external agents, the review UI, and CI can consume and re-inject them programmatically. Predicate calls resolve only to registered predicates with `verifiedPure: true` (ADR-0006); the validator hard-errors on anything else. The context is language-agnostic (ADR-0008) and never invokes an LLM (ADR-0010).

## Scope

**In scope:**
- EBNF grammar parse (build-spec §4.1) to the frozen AST node types (build-spec §4.3), without semantic interpretation at parse time.
- Structural (grammar-level) constraints enforced by the parser itself (build-spec §4.2): boolean-valued grammar only, `old(...)` only inside a `postconditions[]` entry, predicate calls shape-checked but not resolved.
- Semantic validation checks (build-spec §5.1): root and transitive nested field resolution, type compatibility, `in` operand shape, predicate existence/arity/arg-types, `verifiedPure === true`, and the low-confidence field warning tier.
- The structured error contract (build-spec §4.4 parse errors, §5.2 validation results): typed error objects, never unstructured throws.
- Predicate registry integration: contract expression predicate calls resolve only to `predicates.json` entries registered with `verifiedPure: true` (ADR-0006).
- The hard-error gate: validation errors block the contract from reaching human review in the authoring flow and block CI in the lint flow (build-spec §5.2).

**Out of scope:**
- SMT-LIB translation of the AST (v2 stretch, build-spec §9.5) — the frozen AST is designed to keep that translation mechanical, but it is not built here.
- Running of tests, emission of test files, or any other consumer of the validated AST.
- Version-gated joint loading of the `.versailles/` file set (workspace-context) — this context consumes the full context but does not load it.
- Source-side manifest derivation (manifest-extraction).
- Any LLM involvement: this context surfaces structured results for an external agent to consume; the tool itself never invokes an LLM (ADR-0010).

## Behavior

### Well-formed expressions parse to the frozen AST

- **Given** a clause `expr` string that conforms to the grammar (build-spec §4.1)
- **When** the parser parses it
- **Then** it returns an AST built only from the node types in build-spec §4.3 (`or | and | not | compare | arithmetic | old | predicateCall | fieldRef | literal`) with no parse errors

### `old(...)` outside a postcondition is a parse error, not a semantic error

- **Given** an expression containing `old(field)` while parsing a `preconditions[]` or `invariants[]` entry
- **When** the parser parses it
- **Then** it returns a structured parse error (build-spec §4.4 shape: `{ contractId, field, position, found, expected, message }`) and the parse is rejected before semantic validation runs

### Out-of-grammar constructs are rejected, never interpreted

- **Given** an expression containing an assignment (`=`), a loop, a statement, or any token outside the grammar
- **When** the parser parses it
- **Then** it returns a structured parse error with the expected alternatives (e.g. `expected: ["=="]` for a single `=`), and no non-boolean-valued expression is ever produced

### Semantic hard errors block the contract

- **Given** an expression that parsed successfully but references an unknown field, mismatches declared types, has a malformed `in` operand, or calls a predicate with wrong arity/arg types
- **When** the semantic validator runs against the full context (contracts + manifests + predicates)
- **Then** it returns `{ valid: false, errors: [ { contractId, code, field, detail } ] }` (build-spec §5.2) and the contract cannot pass validation

### Unverified predicates are a hard error

- **Given** a predicate call resolving to a `predicates.json` entry where `verifiedPure` is missing or `false`
- **When** the semantic validator runs
- **Then** it hard-errors — the contract cannot reference an unverified predicate (ADR-0006)

### Low-confidence fields warn but never block

- **Given** a field that resolves but whose manifest entry is flagged as inferred/low-confidence
- **When** the semantic validator runs
- **Then** it emits a non-blocking warning in `warnings[]`, and `valid` remains `true` unless a hard error exists (ADR-0004)

## Constraints

- The expression grammar is boolean-valued only — `must_not` produce assignments, loops, statements, or side-effecting constructs; anything outside the grammar is a parse error (build-spec §4.2).
- `must_not` accept `old(...)` in `preconditions[]` or `invariants[]` — it is a parse-level rejection, never deferred to semantic validation (build-spec §4.2).
- `must_not` resolve predicate calls at parse time — only call-shape is checked; resolution happens in semantic validation (build-spec §4.2).
- `must_not` allow a predicate call unless the named predicate is registered with `verifiedPure === true`; `verifiedPure: false` or missing is a hard error (ADR-0006).
- `must_not` throw unstructured exceptions on malformed input — parser and validator always return structured error results (build-spec §4.4).
- `must_not` fork per target language — the grammar, parser, and validator stay language-agnostic (ADR-0008).
- `must_not` invoke an LLM anywhere in this context — no LLM client, no prompting logic, no retry loop (ADR-0010).
- The AST node set is frozen at build-spec §4.3; `must_not` add node types without a build-spec change.

## Non-Goals

- No SMT-LIB translation / verified witness synthesis (v2, build-spec §9.5).
- No executable or side-effecting code inside expressions beyond registered, verified-pure predicate calls (build-spec §1 non-goals).
- No automated purity/termination analysis — the `verifiedPure` flag is a manual registration-time gate (ADR-0006).
- No grammar variants per programming language (ADR-0008).
- No LLM-assisted authoring inside the tool — the structured-error surface exists for external agents to iterate against (ADR-0010).

## Linked Plans

- PLAN-20260811-001 (llama plan "Overview" — Versailles v1 Pipeline): these specs are the behavioral layer; execution detail and sequencing live in the plan.

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-11 | associate-head-coach | Initial draft from build-spec §4–§5, ADR-0006/0008/0010 |