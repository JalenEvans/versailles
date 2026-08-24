# ADR: Licensing and contribution model — MIT core, EasyCLA, open-core commitment

**ID:** ADR-0015
**Date:** 2026-08-24
**Status:** accepted
**Owner:** associate-head-coach
**Template:** MADR-derived decision record

---

## Context and Problem Statement

Versailles is a deterministic test-generation tool built on Design-by-Contract specifications. The project is approaching its first public release, and the licensing and contribution model must be recorded before external contributors arrive. Open-core projects blow up for *changing the deal* (Redis, Elastic, HashiCorp — relicensing after contributors have already shipped code under the original license), not for having a commercial tier from day one. The licensing intent must be stated from day one.

Three prerequisite decisions are already resolved:

- **D2 (VERSAILLES-30, 2026-08-24):** core license is MIT. Core = contract grammar, parser, validator, IR, CLI, emitters. The free tier (L0–L2) stays MIT permanently.
- **LIC-1 (VERSAILLES-29, 2026-08-24):** employment IP check passed — no IP assignment clause found; Versailles is personally owned by the author.
- **LIC-3 (VERSAILLES-31, 2026-08-24):** CLA framework is EasyCLA (Linux Foundation), with both ICLA and CCLA required, using Apache ICLA and Harmony UNMODIFIED templates.

What remains is to record the full licensing and contribution model as an immutable ADR: the per-package licensing layout, the open-core commitment, the CLA mechanism, and the trademark posture — so that future sessions and external contributors encounter a consistent, published position.

## Decision Drivers

- **Open-core sustainability** — the project must be able to offer advanced code-analysis capabilities (L3/L4 code-path analysis + evidence layer) under a commercial license without violating the licenses already granted to free-tier contributors.
- **Contributor clarity** — external contributors must know before contributing: (a) what license their code ships under, (b) that a CLA is required, (c) that the project may include their contribution in both free and commercial tiers.
- **Relicensing freedom preserved** — a CLA (not a DCO) is required so that the project retains the ability to include contributor work in the commercial tier. A DCO-only model would erode this freedom permanently the moment an external contributor's code is accepted without a CLA.
- **Free-tier commitment published** — the contract grammar, parser, validator, IR, CLI, and emitters are MIT-licensed and will remain so. This is a public commitment, not an internal intent.
- **Per-package licensing intent** — `packages/ir` is designated Apache-2.0; the per-package layout itself is blocked on D3 (R-2, monorepo restructure decision) but the intent is recorded now.
- **Trademark protection** — Versailles™ is used in commerce; common-law trademark rights accrue from use. Registration is deferred but the mark is asserted.

## Considered Options

### Core license

- **Option A — MIT (chosen)** — permissive, widely understood, compatible with the open-core model. The free tier stays MIT permanently; the commercial tier is a separate private repo (`versailles-pro`), not a relicensing of the core.
- **Option B — Apache-2.0** — considered for the core; ultimately kept for `packages/ir` only (per-package designation). Apache-2.0's patent clause is valuable but MIT's simplicity and ecosystem familiarity win for the core.

### CLA mechanism

- **Option A — EasyCLA (chosen)** — Linux Foundation project. Only evaluated tool with confirmed dual-document (ICLA + CCLA) support. Templates: Apache ICLA / Harmony UNMODIFIED (editing a legal template without counsel voids it).
- **Option B — CLA Assistant** — rejected: weak maintenance (last release 2023, companion action archived, 2026 reliability reports), dual-document ICLA+CCLA not confirmed for the same repo.
- **Option C — DCO-only** — rejected: insufficient for open core. An external contributor accepted without a CLA erodes relicensing freedom permanently — the project cannot include that contributor's code in the commercial tier.
- **Option D — GitHub CLA workflow** — rejected: manual, no dual-document automation, not suitable for the scale of contributor onboarding the project expects.

### Per-package licensing layout

- **Option A — Record intent now, execute after D3 (chosen)** — the per-package layout (§15.3) is recorded as intent. The actual layout is blocked on D3 (R-2, monorepo restructure decision). The intent is: `packages/ir` = Apache-2.0; pro/paid tier (L3/L4) = separate private repo (`versailles-pro`); free core = MIT.
- **Option B — Execute the layout now** — rejected: blocked on D3. The monorepo restructure has not been decided; executing the layout prematurely would create churn when D3 is resolved.

## Decision Outcome

Chosen option: **MIT core permanently; per-package mixed licensing (ir = Apache-2.0); pro tier in separate private repo; EasyCLA for ICLA + CCLA with Apache/Harmony templates unmodified; trademark Versailles™ with registration deferred**, **because** it preserves relicensing freedom for the open-core model, publishes the free-tier commitment to contributors, records the per-package licensing intent without executing it prematurely (blocked on D3), and asserts the trademark without incurring registration cost before the project has traction.

### Consequences

- **Positive:** contributors sign a CLA before merging, preserving the project's ability to include contributor work in both the free and commercial tiers. The free-tier commitment (MIT, permanent) is published — external contributors know the deal from day one. The per-package licensing intent is recorded, so future sessions understand the plan without executing it prematurely. The trademark is asserted.
- **Negative:** the CLA adds contributor friction — every external contributor must sign before their first PR is merged. The per-package layout is unexecutable until D3 (monorepo restructure) is resolved. The commercial tier lives in a separate private repo, which adds operational overhead (two repos to maintain, sync boundaries to define).
- **Neutral:** `package.json` already carries `"license": "MIT"` (verified, no change needed). `THIRD-PARTY-NOTICES.md` is generated (see below). `CONTRIBUTING.md` is published separately (LIC-5) and will reference this ADR for the CLA process.

### Confirmation

- ADR-0015 exists in the decisions index (`docs/decisions/index.md`).
- `package.json` license field is present and reads `"MIT"` (verified, no change needed).
- `THIRD-PARTY-NOTICES.md` is generated at the repo root, covering current runtime dependencies and planned bundled artifacts.
- `README.md` carries the trademark note (see below).
- `scripts/validate-docs.sh` passes with this ADR linked from the decisions index.

## More Information / Links

- Tickets: VERSAILLES-34 (this ADR), VERSAILLES-30 (D2 — core license), VERSAILLES-31 (LIC-3 — CLA framework), VERSAILLES-29 (LIC-1 — employment IP check)
- [Build spec §15 — Licensing](../build-spec.md#15-licensing) (roadmap licensing section)
- [CONTRIBUTING.md](../../CONTRIBUTING.md) (published separately, LIC-5; references this ADR for the CLA process)
- [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) (third-party software notices)
- Supersedes nothing; complements [ADR-0014](0014-roadmap-reconciliation.md) (roadmap reconciliation — this ADR records the licensing model that the roadmap's Phase 0 requires).

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-24 | associate-head-coach | Initial proposal |
| 2026-08-24 | associate-head-coach | Accepted by Head Coach |
| 2026-08-24 | general-manager | D3 restructure landed; IR naming disambiguated — the generator's in-memory test-case IR stays MIT, `packages/ir` (VIR schema) is Apache-2.0 |
