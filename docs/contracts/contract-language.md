# Contract Summary: Contract Language

**Machine contract:** [contract-language.contract.yaml](contract-language.contract.yaml)
**Spec:** [docs/specs/contract-language.md](../specs/contract-language.md)
**Status:** draft · **Validated:** pending

## What this context does

Contract language is the **validation kernel** of Versailles. It reads the boolean-valued clause
expressions written in contract files (`preconditions`, `postconditions`, `invariants`) and
turns them into the canonical AST — the *only* shape the rest of the pipeline is allowed to
consume. Nothing downstream ever sees a raw, unparsed, or invalid expression.

## What it guarantees (must)

- Well-formed expressions parse into the frozen AST node set (`or | and | not | compare |
  arithmetic | old | predicateCall | fieldRef | literal`) — no other node types exist.
- `old(field)` is only legal inside a `postconditions[]` entry; anywhere else it is a
  **parse error**, rejected before semantic checking.
- The grammar is boolean-valued only — no assignments, loops, or statements can be expressed.
- Semantic validation resolves every field reference, checks type compatibility and `in`
  operands, and verifies every predicate call against `predicates.json`.
- Predicates may be referenced **only** if registered with `verifiedPure: true`; anything else
  is a hard error.
- All failures come back as **structured error objects** (parse shape and validation shape)
  that external agents, the review UI, and CI can read and re-inject programmatically.

## What it forbids (must not)

- No `old(...)` acceptance outside postconditions; no assignments/loops/statements.
- No predicate resolution at parse time (shape only), no unverified predicate references.
- No unstructured throws — never a raw exception on malformed input.
- No per-language grammar variants; no LLM client, prompting, or retry anywhere in this
  context; no drifting AST node set without a build-spec change.

## Grounding

[build-spec §4–§5](../build-spec.md) · ADR-0004 (permissive warnings) · ADR-0006 (verifiedPure
gate) · ADR-0008 (language-agnostic core) · ADR-0010 (CLI never drives an LLM)