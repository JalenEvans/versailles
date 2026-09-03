# versailles

[![npm (beta)](https://img.shields.io/npm/v/versailles-dbc/beta)](https://www.npmjs.com/package/versailles-dbc)
[![CI](https://github.com/JalenEvans/versailles/actions/workflows/validation.yml/badge.svg)](https://github.com/JalenEvans/versailles/actions/workflows/validation.yml)
[![license: MIT](https://img.shields.io/npm/l/versailles-dbc)](LICENSE)
[![status: beta](https://img.shields.io/badge/status-beta-yellow)](https://www.npmjs.com/package/versailles-dbc)

Deterministic test generation from Design-by-Contract specifications.

Author your contracts — invariants, preconditions, postconditions — once. Versailles compiles them into a test suite. Same contract in, same suite out, byte-identical and run-to-run reproducible. No LLM at generation time.

## What it does

You write the contract; Versailles writes the tests. Declare what must hold in `.versailles/contracts.json` — the single source of truth — and `versailles generate` emits a deterministic suite into `.versailles/generated/` that checks exactly that.

```json
{
  "contracts": {
    "OrderService": {
      "operations": {
        "addItem": {
          "params": [{ "name": "price", "type": "number" }],
          "preconditions":  [{ "id": "addItem.pre.pricePositive", "expr": "price > 0" }],
          "postconditions": [{ "id": "addItem.post.balanceIncrements", "expr": "balance == old(balance) + price" }]
        }
      }
    }
  }
}
```

```bash
versailles generate
```

```ts
// .versailles/generated/OrderService.test.ts (abridged)
it("addItem rejects price = 0 — falsifies addItem.pre.pricePositive", () => { /* ... */ });
it("addItem rejects price = -1 — falsifies addItem.pre.pricePositive", () => { /* ... */ });
it("addItem accepts price = 1 — satisfies addItem.pre.pricePositive", () => { /* ... */ });
it("addItem keeps balance == old(balance) + price — satisfies addItem.post.balanceIncrements", () => { /* ... */ });
```

The end-to-end walkthrough lives in the [getting-started guide](docs/guides/getting-started.md); the grammar is specified in the [contract-language spec](docs/specs/contract-language.md).

## Features

- **Deterministic, byte-identical output** — same contract in, same suite out. Regeneration is idempotent and full-file; `coverage.json` maps every clause to the tests covering it, so nothing is emitted silently ([ADR-0002](docs/decisions/0002-deterministic-generation-llm-authoring-only.md)).
- **Contracts as the single source of truth** — invariants, preconditions, and postconditions live in one `.versailles/contracts.json`; nothing re-derives intent from source at generation time.
- **Five-command CLI** — `init`, `extract-manifests`, `validate`, `generate`, `check`, with machine-readable output and stable exit codes for CI.
- **Language-agnostic core, pluggable edges** — the grammar, validator, and generator stay language-agnostic; only the manifest extractor (per language) and the output emitters (per framework) plug in — vitest, xUnit, and pytest today ([ADR-0008](docs/decisions/0008-language-agnostic-core-pluggable-plugins.md)).
- **Seeded property-based emission (opt-in)** — seed-pinned fast-check property blocks alongside the concrete cases; failures reproduce run-to-run ([ADR-0017](docs/decisions/0017-property-based-test-emission-mit-core.md)).
- **Totality of emission** — generated output type-checks or the tool refuses loudly ([ADR-0021](docs/decisions/0021-totality-of-emission.md)).
- **No in-tool review ceremony** — `validate`/`check` gate correctness; approval lives in the ordinary git workflow, not a tool ceremony ([ADR-0012](docs/decisions/0012-git-commit-as-approval-remove-review-gate.md)).

## Install

```bash
npm install -g versailles-dbc@beta
```

Then `versailles <command>` works anywhere. The npm package is `versailles-dbc`; the CLI binary is `versailles` ([ADR-0001](docs/decisions/0001-package-and-cli-naming.md)).

> **Beta:** the current release is `0.1.0-beta.0`, published on the `beta` dist-tag — the `@beta` in the install command is intentional until the first stable release. Prefer installing from source? See [Contributing](#contributing).

## Quick start

```bash
cd your-project
versailles init                    # scaffold .versailles/ (config + empty stores) — fresh projects only
# author .versailles/contracts.json — invariants, preconditions, postconditions
versailles validate                # single gate: parse + semantic + predicate checks
versailles generate                # deterministic suite → .versailles/generated/
bun run test                       # run the generated tests (Red → Green)
versailles check                   # CI lint: validate + staleness (exit 0/1/2)
git commit
```

- **Greenfield (contract-first, [ADR-0011](docs/decisions/0011-contract-first-emission.md)):** write the contract *before* any source. `generate` emits tests that fail via import error — legitimate TDD Red — then implement the source until the tests pass (Green).
- **Brownfield:** run `versailles extract-manifests` first to derive `manifests.json` from existing source, then proceed through the loop.

### The five commands

| Command | Purpose |
|---|---|
| `init` | Scaffold `.versailles/` — default config + empty stores (new projects only) |
| `extract-manifests` | Derive `manifests.json` from source (brownfield only; `--prune` removes entries no longer in source) |
| `validate` | Parse + semantically validate the whole workspace; structured report, exit 0/1. Use `--verbose` to see raw expr + parsed AST per clause |
| `generate` | Deterministic tests from contracts → `.versailles/generated/` |
| `check` | CI lint: validate + staleness; exit `0` clean · `1` parse/validation · `2` blocking staleness |

### Contract expression cheat-sheet

A clause is a boolean expression (full grammar: [build-spec §4](docs/build-spec.md#4-contract-expression-grammar), [contract-language spec](docs/specs/contract-language.md)). Example clauses:

```text
invariant      balance >= 0
precondition   sku != ""
precondition   price > 0                        # inline when the grammar can express it — use a named predicate only for what it can't (e.g. format checks)
postcondition  balance == old(balance) + price   # old(field) is postconditions ONLY
```

Grammar you can use anywhere (build-spec §4.1):

```text
comparison     ==  !=  >  >=  <  <=  in      # e.g. balance in [0, 1, 2]
boolean        and  or  not                  # e.g. sku != "" and price > 0 — no parentheses
literals       42  "open"  true  false  null  [1, 2, 3]
field paths    order.items[].sku             # [] = any element · [0] = by index
```

Gotchas: `old(field)` anywhere but a postcondition is a parse error; predicate calls must resolve to a predicate declared in the top-level `"predicates"` map of `contracts.json`; single `=` is a parse error (`==` only).

### Root-level flags

`versailles -v` / `versailles --version` prints the tool version (the package `version`, currently `0.1.0-beta.0`) and exits `0` from any directory — it is a **root-level flag, not a command**: it short-circuits before command dispatch and never touches the workspace. Subcommands reject `-v` / `--version` as usage errors; `--verbose` remains the only flag on `validate` (long-only).

## Using in CI

```bash
versailles check
# exit 0 = clean · 1 = parse/validation error · 2 = blocking staleness
```

GitHub Actions:

```yaml
- run: versailles check
  # 0 clean · 1 parse/validation · 2 stale (source drifted from contracts)
```

Set `staleness.blockOnStale: false` in `.versailles/config.json` to warn instead of fail (exit 0). Details: [staleness-check](docs/features/staleness-check.md), [build-spec §8](docs/build-spec.md#8-staleness--ci-lint).

## Property-based tests (opt-in)

`generate` emits deterministic, concrete cases by default. Opt into seeded property-based test (PBT) emission in `.versailles/config.json`:

```json
{
  "propertyBased": {
    "enabled": false,
    "numRuns": 100
  }
}
```

- `enabled` (default `false`) — when `true`, the generator additionally emits seed-pinned property blocks (vitest + fast-check) alongside the concrete cases; the concrete cases remain the audit spine for `coverage.json` traceability.
- `numRuns` (default `100`) — property runs per emitted block.
- `seed` (optional) — explicit 32-bit override; when absent, each block's seed is derived deterministically from the context (clause IDs + grammar version), so regeneration stays byte-identical and failures reproduce run-to-run.

Requires `fast-check` as a dev dependency of the consuming project (the tool ships the codegen, not the library). Details: [deterministic-generation spec](docs/specs/deterministic-generation.md), [build-spec §9.6](docs/build-spec.md#96-seeded-pbt-emission-opt-in-adr-0017), [ADR-0017](docs/decisions/0017-property-based-test-emission-mit-core.md), [PBT consumer guide](docs/guides/pbt-emission.md).

## Docs

- **Contributor map:** [docs/index.md](docs/index.md) — start here
- **Master build spec:** [docs/build-spec.md](docs/build-spec.md) — the authoritative reference
- **Getting started:** [docs/guides/getting-started.md](docs/guides/getting-started.md) — zero to green, end to end
- **Seeded PBT emission:** [docs/guides/pbt-emission.md](docs/guides/pbt-emission.md)
- **Contract language:** [docs/specs/contract-language.md](docs/specs/contract-language.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — the contribution flow, CLA, and open-core commitment. Requires [bun](https://bun.sh) (Node ≥ 20 and npm work too — `npm install` runs the same `prepare` build that materializes `dist/`).

```bash
git clone https://github.com/JalenEvans/versailles.git
cd versailles
bun install        # builds dist/ via the prepare hook
bun link           # register the CLI globally
```

### Run the committed example — fast path

```bash
bun run example:generate          # build → re-extract → regenerate, asserts byte-identical output
cd examples/order-service && bun run test   # run the committed generated suite (vitest)
```

### The full loop, step by step

The example ships a fully-authored workspace (contract already in `contracts.json` — inline expressions only), so every step is re-runnable in place and stays byte-identical to what's committed:

```bash
cd examples/order-service

versailles extract-manifests          # 1. derive manifests.json from source (brownfield only)
versailles validate                   # 2. parse + semantic + predicate checks
versailles generate                   # 3. write the deterministic suite to .versailles/generated/
versailles check                      # 4. CI lint: validate + staleness (exit 0)
bun run test                          # 5. run the generated tests
# git commit the workspace
```

The committed contract (`examples/order-service/.versailles/contracts.json`) uses only inline expressions — no named predicates — demonstrating the inline-first doctrine; the predicate path is taught in the [getting-started guide](docs/guides/getting-started.md).

### Run the test suite

```bash
bun test
```

Gates (run before opening a PR):

```bash
scripts/validate-docs.sh
scripts/validate-contracts.sh
```

## License

MIT — see [LICENSE](LICENSE).

Versailles™ is a trademark of Jalen Evans. Common-law trademark rights accrue from use in commerce; registration is deferred. Use of the name for derived works or distributions requires permission.