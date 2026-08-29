# Contributing to Versailles

Thanks for your interest in contributing. This guide covers the contribution flow — from opening an issue to merging a PR.

## The Open-Core Commitment

> Versailles is developed as open core. The contract grammar, parser, validator, IR, CLI, and emitters are MIT-licensed and will remain so. Advanced code-analysis capabilities may in future be offered under a commercial license. Contributions require signing a CLA, which lets us include your work in both.

This is a formal commitment, not an internal intent. The free tier (contract grammar, parser, validator, the generator's in-memory test-case IR, CLI, emitters) stays MIT permanently. `packages/ir` (the VIR schema package) is Apache-2.0 per the per-package intent. The commercial tier (advanced code-analysis capabilities, L3/L4) lives in a separate private repo. For the full licensing model, see [ADR-0015](docs/decisions/0015-licensing-and-contribution-model.md).

## Before You Start

**Open an issue first** for big changes (new commands, grammar extensions, breaking changes). Small fixes (typos, bug fixes, docs improvements) can go straight to PR.

**Contract-first note:** tests in this repo are generated from contracts via `versailles generate`. If you're changing the contract grammar or generator, the tests are downstream — validate the contract first, then regenerate.

## The CLA

**Contributions (pull requests) require signing a Contributor License Agreement before merging.**

The CLA mechanism is **CLA Assistant** (cla-assistant.io); contributors sign via the CLA Assistant bot on their first PR; templates are derived from the Apache ICLA v2.2 and Corporate CLA, adapted for Versailles per the ASF's reuse permission (see [ADR-0016](docs/decisions/0016-cla-assistant-derived-templates.md)).

You'll be prompted to sign via the CLA Assistant bot when you open your first PR. The CLA must be signed before your PR can merge. For the rationale on the CLA mechanism (why CLA over DCO, why CLA Assistant over EasyCLA), see [ADR-0016](docs/decisions/0016-cla-assistant-derived-templates.md); for the overall licensing model (MIT core, open-core commitment), see [ADR-0015](docs/decisions/0015-licensing-and-contribution-model.md).

## Development Setup

Requires [bun](https://bun.sh) (Node ≥ 20 and npm work too — `npm install` runs the same `prepare` build that materializes `dist/`).

```bash
git clone https://github.com/JalenEvans/versailles.git
cd versailles
bun install        # builds dist/ via the prepare hook
bun link           # register the CLI globally
```

## The TDD Loop

The primary development flow (mirrors README §"The TDD loop"):

```bash
versailles validate      # single gate: parse + semantic + predicate checks
versailles generate      # deterministic suite → .versailles/generated/
bun run test             # run the generated tests
versailles check         # CI lint: validate + staleness (exit 0/1/2)
git commit               # the commit IS the approval (ADR-0012)
```

**Greenfield (contract-first, ADR-0011):** skip `extract-manifests` entirely — write the contract *before* any source. `generate` emits tests that fail via import error (legitimate TDD Red), then implement the source until the tests pass (Green).

**Brownfield:** run `versailles extract-manifests` first to derive `manifests.json` from existing source, then proceed through the loop.

## Verification Gates

Run these before opening a PR:

```bash
bun test                     # unit + property tests
scripts/validate-docs.sh     # docs drift gate
scripts/validate-contracts.sh # contract validity gate
```

PRs and pushes to `main` run these automatically via `.github/workflows/validation.yml` — `code-validation.yml` (lint, format, build, smoke, tests) and `docs-validation.yml` (the two scripts above).

## Opening a PR

Use the PR template at `.github/pull_request_template.md`. Include:

- **Summary:** what this change does (1-3 sentences, grounded in the diff)
- **Why:** why now, link the spec / issue / ADR / contract it implements
- **Test plan:** the exact commands run and their results (never invent tests)
- **Risks:** regressions, security, performance, rollback

For changes that cross a spec threshold (money / permissions / public API / data / state) and have no spec, flag the gap explicitly in the PR.

## Docs

- **Master build spec:** [docs/build-spec.md](docs/build-spec.md) — the authoritative implementation reference
- **Contract language:** [docs/specs/contract-language.md](docs/specs/contract-language.md)
- **Contributor map:** [docs/index.md](docs/index.md)
- **Architecture decisions:** [docs/decisions/](docs/decisions/)

## Questions?

Open an issue. This guide is the map; if something's missing, that's a bug in the map.
