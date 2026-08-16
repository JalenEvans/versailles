# Docs Index — Versailles

Contributor map. Start here. If you can't find what you need, open an issue — this index is the map, and a missing entry is a bug in the map.

**Master build spec:** [docs/build-spec.md](build-spec.md) — the authoritative implementation reference (grammar, schemas, milestones, open decisions). This index is the map; the build spec is the territory.

## Structure Tree

Implemented layout (pipeline core, generator, extractor, CLI, human review flow, predicate registry tooling, and tests are shipped):

```
versailles
├── .versailles/      ← tool state: config.json, contracts.json, manifests.json,
│   │                    predicates.json, generated/ — versioned and loaded as one unit
│   └── generated/    ← deterministic generator output (tool-owned, never hand-edited)
├── src/              ← implemented: core parser+validator, joint loader, TS extractor, generator + vitest/xUnit/pytest
│   │                    emitters, review flow, predicate registry tooling, nine-command CLI (src/cli + bin/versailles)
├── tests/            ← implemented: init, config-schema enum, smoke, parser, validator, loader, generator,
│                       extractor, CLI (unit + property, vitest)
├── docs/             ← this layer (DDD knowledge base)
│   ├── domains/      ← bounded contexts (contract-language, manifest-extraction,
│   │                    workspace-context, deterministic-generation, review)
│   ├── architecture/ ← context map + pluggable-edge seams (ADR-0008/0009)
│   ├── features/     ← user-visible capabilities (CLI surface)
│   ├── contracts/    ← DbC contracts (one machine-checkable contract per bounded context)
│   ├── specs/        ← behavioral specs, one per bounded context
│   ├── decisions/    ← architecture decision records (ADRs)
│   └── glossary.md   ← ubiquitous language (single vocabulary for all docs)
├── scripts/          ← repo-level validation scripts
└── .github/          ← PR validation pipeline (workflows/) + PR description template
```

## Modules / Boundaries

Module boundaries per the build spec (§13 milestones). Contracts/specs are registered for each implemented context.

| Module | Path | Owns | Spec | Contract |
|--------|------|------|------|----------|
| Contract language (grammar + parser + validator) | `src/core/parser`, `src/core/validator` | expression grammar, AST, semantic checks, structured error contract | [docs/specs/contract-language.md](specs/contract-language.md) | [draft](contracts/contract-language.contract.yaml) |
| Loader / context | `src/loader` | unified versioned context, version gates, scoped extraction helper | [docs/specs/workspace-context.md](specs/workspace-context.md) | [draft](contracts/workspace-context.contract.yaml) |
| Manifest extractor | `src/extractors` | source → `manifests.json`, structural `sourceHash` | [docs/specs/manifest-extraction.md](specs/manifest-extraction.md) | [draft](contracts/manifest-extraction.contract.yaml) |
| Deterministic generator | `src/generator` | test-case IR → test files, `generated/coverage.json` | [docs/specs/deterministic-generation.md](specs/deterministic-generation.md) | [draft](contracts/deterministic-generation.contract.yaml) |
| CLI | `src/cli` | command surface (`init`, `extract-manifests`, `validate`, `check`, `generate`, `review`, `register-predicate`, `verify-purity`, `remind-unverified`), machine-readable structured output + exit codes for external agents | [docs/specs/versailles.md](specs/versailles.md) | [draft](contracts/versailles.contract.yaml) |

Each module maps to a [bounded context](domains/index.md); the shared vocabulary is the [ubiquitous language](glossary.md).

## Key Patterns

- **Contracts as single source of truth** — everything downstream (validation, generation) reads `contracts.json`; nothing re-derives intent from source at generation time (build-spec §1).
- **Deterministic codegen** — generation is a pure function of approved contracts; regeneration is idempotent and full-file (build-spec §9.4).
- **Structured error contract** — parser and validator return structured objects, never unstructured throws, so external agents and CI can re-inject them programmatically (build-spec §4.4, §5.2).
- **Single-object merge on approval** — human review merges one key of `contracts.json`, never a full-file rewrite; git history is the audit trail (build-spec §11).
- **Language-agnostic core, pluggable edges** — grammar/validator/generator stay language-agnostic; only the manifest extractor (per language) and output emitter (per framework) plug in (ADR-0008).

## Run / Build / Test

The v1 pipeline is implemented: parser/validator (`src/core`), joint loader (`src/loader`), TypeScript manifest extractor (`src/extractors`), deterministic generator with the vitest/xUnit/pytest emitters (`src/generator`), the human review flow (`src/review` + `versailles review`), predicate registry tooling (`src/predicates` + `register-predicate` / `verify-purity` / `remind-unverified`), and the nine-command machine-readable CLI (`src/cli` + `bin/versailles`). Tests cover each module (unit + property).

```bash
# docs + contract validation
scripts/validate-docs.sh
scripts/validate-contracts.sh
```

PRs and pushes to `main` run both gates automatically via `.github/workflows/validation.yml` — `code-validation.yml` (lint, format, build, smoke, tests) and `docs-validation.yml` (the two scripts above).

## Conventions

- Docs are the single knowledge source — never duplicate them into chat.
- ADRs are immutable once accepted; new decisions supersede, never edit (see [decisions/](decisions/index.md)).
- Spec threshold rule: write a spec only where the change touches money / permissions / public API / data / state.
- `.versailles/` files are versioned together and loaded as a single unit — never interpret one file in isolation.
- `generated/` is fully tool-owned — never hand-edited, always regenerated from `contracts.json`.
- No implementation starts without a registered contract (`contract_gate`).

## Registries

- [Domains](domains/index.md) — bounded contexts, ownership, and the context map
- [Architecture](architecture/index.md) — how the contexts interact; [plugin seams](architecture/plugin-seams.md) (ADR-0008/0009)
- [Features](features/index.md) — user-visible capabilities mapped to the CLI surface
- [Glossary](glossary.md) — ubiquitous language (single vocabulary — no competing definitions)
- [Contracts](contracts/index.md) — machine-checkable DbC contracts
- [Specs](specs/index.md) — behavioral specs, one per bounded context
- [Decisions](decisions/index.md) — architecture decision records