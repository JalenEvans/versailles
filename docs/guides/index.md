# Guides — Versailles

Task-oriented, user-facing walkthroughs built on the reference layer ([build spec](../build-spec.md), [specs](../specs/index.md), [contracts](../contracts/index.md)). Guides link to the reference docs instead of duplicating them, and they speak the shared [ubiquitous language](../glossary.md).

## Guide map

| Guide | Audience | Covers |
|---|---|---|
| [Getting started — zero to green](getting-started.md) | New users | The full contract-first TDD loop: scaffold, author a contract (inline-first, with one named predicate), validate (+ `--verbose`), generate, read the suite, Red → Green, `check` + commit; brownfield via `extract-manifests` |
| [Seeded PBT emission](pbt-emission.md) | Users opting into `propertyBased` | The `propertyBased` feature (ADR-0017, VERSAILLES-158/165): what you get, the four emitted layouts, reading a failing property, warning tiers |

See also: [Features](../features/index.md) · [Glossary](../glossary.md) · [Build spec](../build-spec.md)