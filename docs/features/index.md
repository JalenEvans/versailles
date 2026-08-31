# Features — Versailles

User-visible capabilities mapped from the [build spec](../build-spec.md). Each capability is phrased as behavior a user (developer or CI pipeline) experiences, with the vocab of the shared [ubiquitous language](../glossary.md).

## Feature map

| Feature | Command | Primary context(s) | Build-spec ref | Doc |
|---|---|---|---|---|
| Deterministic generation | `versailles generate` | deterministic-generation, workspace-context | §9 | [deterministic-generation.md](deterministic-generation.md) |
| Staleness check (CI lint) | `versailles check` | workspace-context, contract-language, manifest-extraction | §8 | [staleness-check.md](staleness-check.md) |
| Predicate declarations | declared inline in `contracts.json`; verified by `validate` | predicate-registry, contract-language, workspace-context | §3.4, §13 m8 | [predicate-registry.md](predicate-registry.md) |
| Rejected-command output | any command on an invalid/stale context | cross-cutting (CLI) | §4.4, §5.2, §8, §12 | [command-rejection.md](command-rejection.md) |
| Manifest extraction | `versailles extract-manifests` | manifest-extraction, workspace-context | §7 | [manifest-extraction.md](manifest-extraction.md) |
| Workspace init | `versailles init` | workspace-context | §12 | (scaffolds `.versailles/`; see [workspace-context](../domains/workspace-context.md)) |

The headline capabilities of this layer are **deterministic generation**, **staleness check via sourceHash**, **declarative predicate verification**, and **rejected-command output** — the rest complete the five-command CLI surface. Human review happens in the git layer (PR/diff); the git commit is the approval (ADR-0003, ADR-0012).

## How features map to contexts

Every feature spans at least one context; features never own domain logic of their own — they are the user-visible faces of the contexts. See [architecture](../architecture/index.md) for the interaction model.

See also: [Domains](../domains/index.md) · [Glossary](../glossary.md) · [Decisions](../decisions/index.md) · [Build spec](../build-spec.md)