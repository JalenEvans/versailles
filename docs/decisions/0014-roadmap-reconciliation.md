# ADR: Roadmap reconciliation — SMT as soundness requirement; roadmap supersedes BS§9.5/BS§13

**ID:** ADR-0014
**Date:** 2026-08-24
**Status:** accepted
**Owner:** maintainer
**Template:** MADR-derived decision record

---

## Context and Problem Statement

Versailles is building toward a deterministic test generation tool grounded in Design-by-Contract specifications. The repo's build-spec (the authoritative technical plan for v1) describes SMT-backed witness synthesis as a "v2 stretch" goal (§9.5, §13 item 9) — something to consider after the v1 pipeline is proven end-to-end.

This framing contradicts the external L3/L4 analysis-engine roadmap (lives in Llama plans / Obsidian, not in this repo). The roadmap defines SMT-backed generation as a **soundness requirement** for the L3/L4 code-path analysis engine (roadmap §4), not a stretch goal. The roadmap further defines a phase sequence beyond the v1 milestone: Phase 0 foundation (the current licensing/phase-0 sprint), then L3/L4 engine phases 1–8 (Roslyn CFG viability spike, D1 decision + VIR design, CFG front-end, branch coverage with contract oracle, spec-vs-code divergence report, bounded path enumeration + incremental pruning, compositional summaries + memory model, paid packaging + evidence layer) — culminating in the phase-0 exit condition (roadmap §16) that gates this sprint's completion.

Until the repo reflects the roadmap, a maintainer reading only the repo sees a contradicting plan and — per the §1 convention (the repo is the single source of truth) — correctly prefers the repo over the roadmap. This makes Phase 0 (the current sprint) not optional: the repo must be reconciled with the roadmap before implementation proceeds, or future maintainers will read a build-spec that describes SMT as "stretch" when the roadmap requires it as soundness infrastructure.

## Decision Drivers

- **Roadmap authority** — the L3/L4 analysis-engine roadmap is the authoritative source for what SMT-backed generation is (soundness requirement, not stretch) and the phase sequence beyond v1. The repo must reflect it.
- **§1 convention** — the repo is the single source of truth; when the repo contradicts the roadmap, maintainers prefer the repo. If the repo says "v2 stretch" and the roadmap says "soundness requirement," maintainers will implement the wrong thing.
- **Phase sequencing clarity** — the build-spec's §13 item 9 ("SMT-backed generation (v2 stretch) — only after v1 pipeline is proven end-to-end") is a single stretch entry. The roadmap defines a phase sequence (Phase 0 → phases 1–8) that must be recorded so future maintainers understand the sequencing.
- **No v1 scope change** — v1 still ships without SMT-based synthesis. The reframing is about sequencing and intent (soundness requirement vs. stretch goal), not about changing what v1 delivers.
- **Immutable ADRs** — ADR-0011, ADR-0012, and ADR-0013 are already accepted (landed 2026-08-21/22). This ADR is numbered 0014 to preserve immutability.

## Considered Options

- **Option A — Roadmap supersedes build-spec (chosen)** — the roadmap is the authoritative source for SMT's role (soundness requirement) and the phase sequence beyond v1. Build-spec §9.5 and §13 are amended to reference this ADR and the roadmap. No v1 scope change; v1 still ships without SMT-based synthesis, but the framing shifts from "stretch" to "soundness requirement, sequenced after v1."
- **Option B — Keep build-spec as-is, document the contradiction** — add a note to the build-spec saying "SMT is a stretch goal here but a soundness requirement in the roadmap; consult the roadmap for the authoritative view." This preserves the §1 convention violation (maintainers prefer the repo) and leaves the contradiction unresolved, forcing every future maintainer to disambiguate.
- **Option C — Remove SMT from the build-spec entirely** — delete §9.5 and §13 item 9, leaving the roadmap as the only source. This loses the in-repo record that SMT is planned (just sequenced differently), and makes the build-spec incomplete for maintainers that don't consult the roadmap.

## Decision Outcome

Chosen option: **Option A — roadmap supersedes build-spec §9.5 and §13; SMT is a soundness requirement (not a v2 stretch goal); §13's single stretch entry is replaced with the roadmap phase sequence**, **because** it resolves the contradiction between the repo and the roadmap, preserves the §1 convention (the repo is the single source of truth), records the phase sequence for future maintainers, and makes no change to v1 scope (v1 still ships without SMT-based synthesis — that's unchanged, just reframed as sequencing not "stretch"). The roadmap remains the authoritative source for phase details; the build-spec references it.

### Consequences

- **Positive:** the repo no longer describes SMT as a "v2 stretch" goal. Build-spec §9.5 and §13 reference ADR-0014 and the roadmap. Future maintainers reading only the repo see a consistent plan: SMT is a soundness requirement for the L3/L4 engine, sequenced after v1. The phase sequence is recorded at summary level in §13, with the roadmap as the authoritative source for details.
- **Negative:** the build-spec now carries a reference to an external roadmap (Llama plans / Obsidian) that is not in the repo. If the roadmap changes, the build-spec must be updated to stay in sync. This is acceptable because the roadmap is the authoritative source for L3/L4 engine phases, and the build-spec only records the decision and phase sequence at summary level.
- **Neutral:** v1 scope is unchanged. V1 still ships without SMT-based synthesis. The reframing is about sequencing and intent (soundness requirement vs. stretch goal), not about changing what v1 delivers. Build-spec §9.5's two bullet points (AST→SMT-LIB translation, grammar design) are preserved but reframed under the soundness-requirement framing.

### Confirmation

- The repo no longer describes SMT-backed generation as a "v2 stretch" goal.
- Build-spec §9.5 and §13 reference ADR-0014 and the roadmap.
- Build-spec §13 item 9 is replaced with the roadmap phase sequence (Phase 0 foundation → L3/L4 engine phases 1–8 per ADR-0014 / roadmap §16).
- `scripts/validate-docs.sh` passes with this ADR linked from the decisions index.

### D3 decision (restructure timing)

**D3 = Restructure now.** The repo will be restructured to the §12.2 monorepo layout (bun workspaces: `packages/ir`, `packages/core`, `packages/engine`, `packages/cli`, plus future `frontend-ts`, `bridge-ts`, `emitter-*`) in the current phase — **not** deferred to phase 11 as the roadmap's original timeline suggested.

**Rationale (maintainer, 2026-08-24):**

- **Per-package licensing is executable now.** Splitting `packages/ir` (Apache-2.0) from the rest of the workspace is a prerequisite for the planned `versailles-pro` repo and the pro-tier dependency surface; doing it later forces a mid-engine migration.
- **Clean dependency surface for pro tier.** Restructuring before phase 9 (bounded path enumeration) avoids carrying a single-package layout through the compositional-summaries and paid-packaging phases, where the licensing boundary becomes load-bearing.
- **Roadmap §18-D3 timing argument.** Restructuring before phase 9 is materially cheaper than restructuring after the engine's core is in place; the roadmap explicitly argues for early restructuring on these grounds.
- **Migration cost is acceptable now.** Phase 0 is the natural restructuring window — the workspace is small, the dependency graph is shallow, and the bun-workspaces migration is a one-time cost that compounds positively for every subsequent phase.

**Tracking:** the actual restructure is tracked by **R-3 (VERSAILLES-37)** and its subtasks **VERSAILLES-80, VERSAILLES-81, VERSAILLES-82, VERSAILLES-83**. This ADR records the *decision*; R-3 records the *execution*.

## More Information / Links

- Ticket: VERSAILLES-35
- [Build spec §9.5 — SMT-backed generation](../build-spec.md#95-smt-backed-generation-soundness-requirement-roadmap-§16)
- [Build spec §13 — Build milestones](../build-spec.md#13-build-milestones-implementation-order-roadmap-phase-sequence-per-adr-0014)
- Roadmap: external L3/L4 analysis-engine roadmap (Llama plans / Obsidian) — authoritative source for phase details
- Supersedes nothing; complements [ADR-0011](0011-contract-first-emission.md), [ADR-0012](0012-git-commit-as-approval-remove-review-gate.md), [ADR-0013](0013-declarative-predicates-remove-registration-cli.md) (all accepted 2026-08-21/22; this ADR is numbered 0014 to preserve immutability).

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-24 | maintainer | Initial proposal |
| 2026-08-24 | maintainer | Accepted |
| 2026-08-24 | maintainer | D3 recorded — restructure now |
