# Contract Summary: Predicate Registry

**Machine contract:** [predicate-registry.contract.yaml](predicate-registry.contract.yaml)
**Spec:** [docs/specs/predicate-registry.md](../specs/predicate-registry.md)
**Status:** draft · **Validated:** pass

## What this context does

The predicate registry owns the **declarative predicate declarations** in the top-level
`predicates` map of `contracts.json` — the named, verified-pure functions contract
expressions are allowed to call (build-spec §3.4, ADR-0013). Predicates are declared inline
in `contracts.json`; `validate` mechanically verifies every declaration: predicate name
validity (IDENT grammar), `sourceRef` resolution under `config.sourceRoots` (resolve-or-warn
→ `PREDICATE_SOURCE_UNRESOLVED` warning), and the `verifiedPure` gate (ADR-0006 preserved —
unverified predicates are a hard error when referenced by a contract). The registration CLI
(`register-predicate` / `verify-purity` / `remind-unverified`) and the stored `sourceHash`
are removed (ADR-0013).

## What it guarantees (must)

- Every entry conforms to the §3.4 schema: `source`, `params`, `paramTypes`, `returnType`,
  `verifiedPure`.
- `validate` verifies every predicate declaration's name is a valid IDENT (invalid names are
  `INVALID_PREDICATE_NAME` hard errors).
- `validate` resolves every predicate declaration's `source` field under `config.sourceRoots`
  (unresolvable sources produce `PREDICATE_SOURCE_UNRESOLVED` warnings — resolve-or-warn,
  ADR-0005, ADR-0013).
- `verifiedPure: true` happens only through a human's manual lint/review, recorded as data
  in `contracts.json`. The tool itself never analyzes purity.

## What it forbids (must not)

- No automated purity/termination analysis; no defaulting `verifiedPure` to true.
- No stored `sourceHash` for predicates (ADR-0013).
- No predicate registration CLI (ADR-0013).
- No separate `predicates.json` file — predicates are declared inline in `contracts.json`.
- No expression parsing or semantic validation — that is contract-language's validator, reached
  through the workspace-context loader.
- No LLM invocation anywhere (ADR-0010).

## Grounding

[build-spec §3.4, §13 milestone 8, §14](../build-spec.md) · ADR-0003 (git audit trail) ·
ADR-0006 (purity gate) · ADR-0010 (no in-tool LLM) · ADR-0013 (declarative predicates)
