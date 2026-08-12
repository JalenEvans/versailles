# Domain: Contract Language

**Bounded context:** `contract-language`

## Responsibility (what this context owns)

The contract specification language and everything needed to know whether a contract is valid:

- The contract expression grammar (build-spec §4.1), its structural constraints, and the canonical AST (build-spec §4.3).
- The parser: `expr` strings → AST, enforcing structural constraints at parse time (e.g. `old(...)` only in `postconditions[]`).
- The semantic validator (build-spec §5.1): field resolution, nested field resolution, type compatibility, `in` operand shape, predicate existence/arity/arg-types, predicate purity, and the low-confidence warning tier.
- The structured error contract (build-spec §4.4, §5.2) — machine-readable results, never unstructured throws.
- The predicate registry (`predicates.json`): named predicates with the `verifiedPure` registration gate (ADR-0006).

This context is **language-agnostic** (ADR-0008): the grammar, parser, and validator never fork per target language.

## Domain model

**Contract** (aggregate root) — the component-level specification stored in `contracts.json`:
- `id` (e.g. `OrderService`)
- *invariants* — one `invariants` list per component (Meyer/DbC scoping: invariant is per-component, never per-operation)
- *operations* — one contract object per operation

**OperationContract** (entity, part of a Contract):
- `id` (`OrderService.placeOrder`), `params` (name + typeRef), `preconditions[]`, `postconditions[]`, `effects[]`, `sourceHash`

**Clause** (entity) — a single invariant/precondition/postcondition with a clause ID (e.g. `OrderService.placeOrder.pre0`) and an `expr` string.

**Expression** (value object) — the boolean-valued string; root of the parse.

**AST** (value object) — the canonical node tree: `or | and | not | compare | arithmetic | old | predicateCall | fieldRef | literal` (build-spec §4.3).

**Predicate** (entity in the registry) — `predicates.json` entry: params, paramTypes, returnType, sourceRef, sourceHash, `verifiedPure`.

**StructuredError** (value object) — parse form: `{ contractId, field, position, found, expected, message }`; validation form: `{ contractId, code, field, detail }`.

**ValidationResult** (value object) — `{ valid, errors[], warnings[] }`.

## Ubiquitous language

Uses from [glossary](../glossary.md): *contract, clause, invariant, precondition, postcondition, effect, expression, component, operation, AST, structured error, predicate, verifiedPure*. No synonyms — a "rule" is a *clause*, a "function check" is a *predicate call*, a "parse failure" is a *structured error*.

## Domain events

- `contractInvalid` — hard parse/validation errors found; downstream commands reject.
- `predicateRegistered` — a named predicate entered the registry with `verifiedPure`.

## Relationships

| Relation | Context | Nature |
|---|---|---|
| Downstream of | workspace-context | Semantic validation requires the full context (contracts + manifests + predicates) loaded together; the loader orchestrates parse + validation. |
| Downstream of | manifest-extraction | Field references resolve against manifest entries and param types. |
| Upstream of | authoring-loop | Its validation result is the gate between LLM output and staging (failed output → correction prompt). |
| Upstream of | review | Review displays warnings and pretty-printed AST as a parser-sanity check. |
| Upstream of | deterministic-generation | Generation only runs on `isValid: true`; the validated AST is the future SMT input (v2). |
| Upstream of | (CLI) | `versailles validate` / `versailles check` surface its structured report. |

## Business rules

- The grammar is boolean-valued only: no assignment, no loops, no statements (build-spec §4.2). Anything outside the grammar is a **parse error**.
- `old(...)` is syntactically valid **only** when parsing a `postconditions[]` entry; encountering it in `preconditions[]` or `invariants[]` is a parse error, not a semantic one (build-spec §4.2). The validator re-asserts as defense-in-depth.
- `predicate_call` identifiers are resolved at semantic validation, not parse time — the parser only checks the call-shape is well-formed.
- Hard errors (unknown field, type mismatch, bad `in` shape, unknown predicate, arity/type mismatch, `verifiedPure !== true`) block the contract from reaching human review in the authoring flow, and block CI in the lint flow (build-spec §5.2).
- Warnings are non-blocking and surfaced for reviewer awareness.
- The parser and validator always return structured results — never throw unstructured exceptions (build-spec §4.4).

## Open questions

- Exact wording and richness of the "did you mean" suggestions in parse errors (build-spec §4.4 example).
- Whether the warning tier is extended in v1 (build-spec §5.1 marks it an extension point, not required).

## Source of authority

[build-spec.md §4–§5](../build-spec.md) · [ADR-0006 predicate purity gate](../decisions/0006-predicate-purity-registration-gate.md) · [ADR-0008 language-agnostic core](../decisions/0008-language-agnostic-core-pluggable-plugins.md)