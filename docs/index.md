# Docs Index — Versailles

Contributor map. Start here. If you can't find what you need, open an issue — this index is the map, and a missing entry is a bug in the map.

**Master build spec:** [docs/build-spec.md](build-spec.md) — the authoritative implementation reference (grammar, schemas, milestones, open decisions). This index is the map; the build spec is the territory.

## Structure Tree

Implemented layout (pipeline core, generator, extractor, CLI, and tests are shipped):

```
versailles
├── .versailles/      ← tool state: config.json, contracts.json (with top-level predicates
│   │                    map), manifests.json, generated/ — loaded as one unit
│   └── generated/    ← deterministic generator output (tool-owned, never hand-edited)
├── packages/            ← bun workspaces monorepo ("workspaces": ["packages/*"]); packages are
│   │                     @versailles/*; per-package licensing recorded in ADR-0015
│   │                     (core/engine/cli/frontend-ts MIT, ir Apache-2.0)
│   ├── core/src/        ← grammar parser+validator (core/), joint loader (loader/), predicates (predicates/)
│   ├── engine/src/      ← deterministic generator + vitest/xUnit/pytest emitters (generator/)
│   ├── cli/src/         ← five-command CLI (cli/)
│   ├── frontend-ts/src/ ← TypeScript manifest extractor (extractors/)
│   └── ir/              ← VIR schema placeholder (Apache-2.0, scaffold-only; full schema deferred to D1 phase)
├── src/                 ← public package entry: index.ts (packageName const)
│   ├── index.ts         ← packageName const export
│   └── emitters/        ← empty placeholder dir
├── tests/            ← implemented: init, config-schema enum, smoke, parser, validator, loader, generator,
│                       extractor, CLI (unit + property, vitest)
├── examples/         ← committed reference example: order-service/ — a real TypeScript service with a
│                       .versailles/ workspace + generated vitest suite; regenerated
│                       deterministically by `bun run example:generate`
├── docs/             ← this layer (DDD knowledge base)
│   ├── domains/      ← bounded contexts (contract-language, manifest-extraction,
│   │                    workspace-context, deterministic-generation, predicate-registry)
│   ├── architecture/ ← context map + pluggable-edge seams (ADR-0008/0009)
│   ├── features/     ← user-visible capabilities (CLI surface)
│   ├── guides/       ← user-facing walkthroughs (zero-to-green tutorial, seeded PBT consumer guide)
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
| Contract language (grammar + parser + validator) | `packages/core/src/core/parser`, `packages/core/src/core/validator` | expression grammar, AST, semantic checks, structured error contract | [docs/specs/contract-language.md](specs/contract-language.md) | [draft](contracts/contract-language.contract.yaml) |
| Loader / context | `packages/core/src/loader` | unified context, no version gates (additive-only, ADR-0018), scoped extraction helper | [docs/specs/workspace-context.md](specs/workspace-context.md) | [draft](contracts/workspace-context.contract.yaml) |
| Manifest extractor | `packages/frontend-ts/src/extractors` | source → `manifests.json`, structural `sourceHash` | [docs/specs/manifest-extraction.md](specs/manifest-extraction.md) | [draft](contracts/manifest-extraction.contract.yaml) |
| Deterministic generator | `packages/engine/src/generator` | test-case IR → test files, `generated/coverage.json` | [docs/specs/deterministic-generation.md](specs/deterministic-generation.md) | [draft](contracts/deterministic-generation.contract.yaml) |
| CLI | `packages/cli/src/cli` | command surface (`init`, `extract-manifests`, `validate`, `check`, `generate`), machine-readable structured output + exit codes for CI and external consumers | [docs/specs/versailles.md](specs/versailles.md) | [draft](contracts/versailles.contract.yaml) |

Each module maps to a [bounded context](domains/index.md); the shared vocabulary is the [ubiquitous language](glossary.md).

## Key Patterns

- **Contracts as single source of truth** — everything downstream (validation, generation) reads `contracts.json`; nothing re-derives intent from source at generation time (build-spec §1). Predicates are declared inline in `contracts.json` (top-level `predicates` map), not in a separate registry file (ADR-0013).
- **Deterministic codegen** — generation is a pure function of validated contracts; regeneration is idempotent and full-file (build-spec §9.4).
- **Structured error contract** — parser and validator return structured objects, never unstructured throws, so CI and external tooling can re-inject them programmatically (build-spec §4.4, §5.2). `validate --verbose` additionally surfaces raw `expr` strings alongside their parsed AST as a parser-sanity check.
- **Authored file + git commit = approval** — contracts are authored directly into `contracts.json`; `validate`/`check` + CI gate correctness; the git commit is the approval (ADR-0003, ADR-0012). No in-tool approval ceremony.
- **Language-agnostic core, pluggable edges** — grammar/validator/generator stay language-agnostic; only the manifest extractor (per language) and output emitter (per framework) plug in (ADR-0008).

## Run / Build / Test

The v1 pipeline is implemented: parser/validator (`packages/core/src/core`), joint loader (`packages/core/src/loader`), TypeScript manifest extractor (`packages/frontend-ts/src/extractors`), deterministic generator with the vitest/xUnit/pytest emitters (`packages/engine/src/generator`), and the five-command machine-readable CLI (`packages/cli/src/cli` + `bin/versailles`). Tests cover each module (unit + property).

A committed reference example lives at `examples/order-service/` — `bun run example:generate` rebuilds, re-extracts, regenerates, and asserts the output is byte-identical to the committed workspace.

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
- `.versailles/` files are loaded as a single unit — never interpret one file in isolation.
- `generated/` is fully tool-owned — never hand-edited, always regenerated from `contracts.json`.
- No implementation starts without a registered contract (`contract_gate`).

## Registries

- [Domains](domains/index.md) — bounded contexts, ownership, and the context map
- [Architecture](architecture/index.md) — how the contexts interact; [plugin seams](architecture/plugin-seams.md) (ADR-0008/0009)
- [Features](features/index.md) — user-visible capabilities mapped to the CLI surface
- [Guides](guides/index.md) — user-facing walkthroughs (zero-to-green tutorial, seeded PBT consumer guide)
- [Glossary](glossary.md) — ubiquitous language (single vocabulary — no competing definitions)
- [Contracts](contracts/index.md) — machine-checkable DbC contracts
- [Specs](specs/index.md) — behavioral specs, one per bounded context
- [Decisions](decisions/index.md) — architecture decision records