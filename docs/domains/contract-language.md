# Domain: Contract Language

**Bounded context:** `contract-language`

## Responsibility (what this context owns)

The contract specification language and everything needed to know whether a contract is valid:

- The contract expression grammar (build-spec §4.1), its structural constraints, and the canonical AST (build-spec §4.3).
- The parser: `expr` strings → AST, enforcing structural constraints at parse time (e.g. `old(...)` only in `postconditions[]`).
- The semantic validator (build-spec §5.1): field resolution, nested field resolution, type compatibility, `in` operand shape, predicate existence/arity/arg-types, and the low-confidence warning tier — no purity gate (ADR-0019).
- The structured error contract (build-spec §4.4, §5.2) — machine-readable results, never unstructured throws.
- The predicate registry (top-level `predicates` map in `contracts.json`): named predicates declared with `source`, `params`, `paramTypes`, `returnType` — no purity gate (ADR-0013, ADR-0019).

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

**Predicate** (entity in the registry) — entry in the top-level `predicates` map of `contracts.json`: `source`, `params`, `paramTypes`, `returnType`.

**StructuredError** (value object) — parse form: `{ contractId, field, position, found, expected, message }`; validation form: `{ contractId, code, field, detail }`.

**ValidationResult** (value object) — `{ valid, errors[], warnings[] }`.

## Ubiquitous language

Uses from [glossary](../glossary.md): *contract, clause, invariant, precondition, postcondition, effect, expression, component, operation, AST, structured error, predicate*. No synonyms — a "rule" is a *clause*, a "function check" is a *predicate call*, a "parse failure" is a *structured error*.

## Domain events

- `contractInvalid` — hard parse/validation errors found; downstream commands reject.
- `predicateDeclarationVerified` — a predicate declaration was verified by `validate` (name valid, sourceRef resolved or warned).

## Relationships

| Relation | Context | Nature |
|---|---|---|
| Downstream of | workspace-context | Semantic validation requires the full context (contracts + manifests + predicates) loaded together; the loader orchestrates parse + validation. |
| Downstream of | manifest-extraction | Field references resolve against manifest entries and param types. |
| Upstream of | deterministic-generation | Generation only runs on `isValid: true`; the validated AST is the future SMT input (v2). |
| Upstream of | (CLI) | `versailles validate` / `versailles check` surface its structured report. |

## Business rules

- The grammar is boolean-valued only: no assignment, no loops, no statements (build-spec §4.2). Anything outside the grammar is a **parse error**.
- `old(...)` is syntactically valid **only** when parsing a `postconditions[]` entry; encountering it in `preconditions[]` or `invariants[]` is a parse error, not a semantic one (build-spec §4.2). The validator re-asserts as defense-in-depth.
- `predicate_call` identifiers are resolved at semantic validation, not parse time — the parser only checks the call-shape is well-formed.
- An undeclared predicate call (`UNKNOWN_PREDICATE`) appends at most 2 "did you mean" suggestions to its detail for declared keys within Levenshtein distance ≤ 2, ordered distance-then-alphabetically; suggestions never add fields to the structured error (VERSAILLES-172).
- Hard errors (unknown field, type mismatch, bad `in` shape, unknown predicate, arity/type mismatch) block the contract from passing validation, and block CI in the lint flow (build-spec §5.2).
- Warnings are non-blocking and surfaced for awareness.
- The parser and validator always return structured results — never throw unstructured exceptions (build-spec §4.4).

## Open questions

- Exact wording and richness of the "did you mean" suggestions in parse errors (build-spec §4.4 example).
- Whether the warning tier is extended in v1 (build-spec §5.1 marks it an extension point, not required).

## Source of authority

[build-spec.md §4–§5](../build-spec.md) · [ADR-0008 language-agnostic core](../decisions/0008-language-agnostic-core-pluggable-plugins.md) · [ADR-0019 no purity gate](../decisions/0019-drop-verified-pure-field.md)