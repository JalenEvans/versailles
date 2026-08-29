# ADR: CLA Assistant with derived Apache templates (supersedes ADR-0015's EasyCLA choice)

**ID:** ADR-0016
**Date:** 2026-08-25
**Status:** accepted
**Owner:** associate-head-coach
**Template:** MADR-derived decision record

---

## Context and Problem Statement

ADR-0015 (accepted 2026-08-24) recorded the CLA mechanism as **EasyCLA** (Linux Foundation) with Apache ICLA / Harmony templates used **unmodified**. Before the beta ships, two practical blockers emerged with that choice:

- **EasyCLA is Linux Foundation-hosted.** EasyCLA is an LF project and operationally assumes Linux Foundation project hosting — an LF account, LF-managed identity flows, and LF CLA group administration. That is heavy machinery for a solo project that is not an LF-hosted project and is about to publish its beta.
- **A verbatim Apache template names the wrong party.** The unmodified Apache ICLA and Corporate CLA name the Apache Software Foundation as the recipient of the grants and direct signers to `secretary@apache.org`. Versailles is not the ASF; a verbatim template would send contributors' grants to the wrong legal entity. The ASF CLA FAQ explicitly permits reuse and modification of its CLAs provided ASF-specific references are removed — with a note that the version is derived from the ASF original.

This decision supersedes only the CLA-mechanism clause of ADR-0015. ADR-0015's other decisions — the MIT core license, the per-package licensing intent (`packages/ir` = Apache-2.0), and the trademark posture — remain in force.

## Decision Drivers

- **Solo-project proportionality** — the mechanism must be operable by a single maintainer on a non-LF project about to publish its beta, without standing up Linux Foundation project administration.
- **Correct legal party** — the signed agreement must grant rights to the Project (Versailles), not to the Apache Software Foundation.
- **Template legitimacy preserved** — the substantive legal terms must remain intact; only party identification and ASF-specific machinery change, per the ASF's stated reuse permission.
- **Contributor friction minimal** — the sign-on-first-PR flow already promised in CONTRIBUTING.md must keep working.
- **Open-core relicensing freedom preserved** — the CLA must still let the project include contributor work in both the free and commercial tiers (the reason a CLA, not a DCO, is required).

## Considered Options

- **Option A — CLA Assistant with derived Apache templates (chosen)** — cla-assistant.io (gist-based GitHub App); templates derived from the Apache ICLA v2.2 and the Apache Corporate CLA (r190612), party swapped from "the Apache Software Foundation" to "the Project" (Versailles), ASF-specific fields and instructions removed, plus a header note recording that the agreement is derived from Apache's template. Substantive legal terms (definitions; copyright and patent grants; representations; warranties; third-party submissions; notification) preserved intact.
- **Option B — EasyCLA (recorded in ADR-0015; rejected now)** — Linux Foundation-hosted; operationally requires LF project hosting and administration, which is disproportionate for a solo pre-beta project. This was the ADR-0015 choice; it is superseded for the CLA-mechanism clause only.
- **Option C — CLA Assistant with the verbatim, unmodified Apache template** — keeps the template text byte-identical but names the Apache Software Foundation as the recipient and directs signers to `secretary@apache.org` — the wrong party for Versailles. Legally confused; rejected.

## Decision Outcome

Chosen option: **Option A — CLA Assistant (cla-assistant.io, gist-based GitHub App) with derived Apache templates (Apache ICLA v2.2 and Corporate CLA r190612, party swapped to "the Project" (Versailles), ASF-specific fields/instructions removed, derivation note added, substantive legal terms preserved intact)**, **because** it is self-serve and proportionate for a solo non-LF project about to publish its beta, it grants rights to the correct party (Versailles, not the ASF) while keeping the Apache template's substantive legal terms intact per the ASF's stated reuse permission, and it preserves the sign-on-first-PR flow documented in CONTRIBUTING.md. This supersedes ADR-0015's EasyCLA choice for the CLA mechanism only; ADR-0015's MIT-core, per-package licensing, and trademark decisions remain in force.

### Consequences

- **Positive:** self-serve setup that works for a solo, non-LF project; no Linux Foundation project administration required. The gist-based flow matches CONTRIBUTING.md's "sign the CLA before your first PR" flow. The derived templates keep the Apache substantive legal terms while naming the right party, per the ASF's explicit reuse permission.
- **Negative:** CLA Assistant's maintenance is weaker than EasyCLA's (last release 2023, companion action archived, 2026 reliability reports). Dual-document ICLA + CCLA for the same repo is not confirmed — the practical flow is one gist per repo, with the corporate case handled when a real corporate contributor appears (the derived CCLA draft is prepared and ready). The modified-template approach should be reviewed by counsel before the project attracts significant external contributions.
- **Neutral:** supersedes only the CLA-mechanism clause of ADR-0015; the remaining ADR-0015 decisions (MIT core, per-package licensing, trademark) are untouched.

### Confirmation

- CLA Assistant app installed and ICLA gist linked — a human step tracked in VERSAILLES-32 (LIC-4 setup, HUMAN), pending.
- A test PR shows the CLA signing prompt (to be verified once the gist is linked).
- `scripts/validate-docs.sh` passes with this ADR linked from the decisions index.

## More Information / Links

- Supersedes [ADR-0015](0015-licensing-and-contribution-model.md) — CLA mechanism only (EasyCLA → CLA Assistant); ADR-0015's MIT-core, per-package, and trademark decisions remain.
- Tickets: VERSAILLES-31 (LIC-3 — CLA framework selection), VERSAILLES-32 (LIC-4 — CLA Assistant setup, HUMAN)
- [CONTRIBUTING.md](../../CONTRIBUTING.md) (CLA section references this ADR for the mechanism)
- [ASF CLA FAQ — re-use and modification](https://www.apache.org/licenses/cla-faq.html) (stated permission to modify/reuse ASF CLAs, with the derivation-note requirement)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-08-25 | associate-head-coach | Initial proposal |
| 2026-08-25 | associate-head-coach | Accepted by Head Coach |