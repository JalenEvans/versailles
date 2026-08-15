# Contract Summary: Predicate Registry

**Machine contract:** [predicate-registry.contract.yaml](predicate-registry.contract.yaml)
**Spec:** [docs/specs/predicate-registry.md](../specs/predicate-registry.md)
**Status:** draft · **Validated:** pass

## What this context does

The predicate registry owns **`predicates.json`** — the named, verified-pure functions contract
expressions are allowed to call (build-spec §3.4). Milestone 8 adds the tooling around it: a
registration CLI that adds/updates one entry at a time, and the **purity gate**: `verifiedPure`
is asserted **manually** by a human via lint/manual review at registration time — never by
automated analysis (ADR-0006, build-spec §14 default). The purity-check reminder then surfaces
any unverified predicates to reviewers so `verifiedPure` can be set after the lint.

## What it guarantees (must)

- Every entry conforms to the §3.4 schema: `params`, `paramTypes`, `returnType`, `sourceRef`,
  `sourceHash`, `verifiedPure`.
- Registration writes are **single-entry read-modify-writes** — never a full-file rewrite —
  recorded in git (ADR-0003 discipline).
- `sourceRef`/`sourceHash` are mechanically verified against real source before writing;
  nothing is invented.
- `verifiedPure: true` happens only through a human's registration-time lint/review gate or the
  post-lint `verify_purity` path. The tool itself never analyzes purity.
- The reminder reports exactly the entries with `verifiedPure` missing or false, and never
  auto-verifies.

## What it forbids (must not)

- No automated purity/termination analysis; no defaulting `verifiedPure` to true.
- No wholesale `predicates.json` rewrites; no implicit removal of entries.
- No expression parsing or semantic validation — that is contract-language's validator, reached
  through the workspace-context loader.
- No review approval/reject flow — review owns that; the reminder only surfaces information.
- No LLM invocation anywhere (ADR-0010).

## Grounding

[build-spec §3.4, §13 milestone 8, §14](../build-spec.md) · ADR-0003 (git audit trail) ·
ADR-0006 (registration-time purity gate) · ADR-0010 (no in-tool LLM)