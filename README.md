# versailles

Deterministic test generation from Design-by-Contract specifications. Contracts
(invariants, preconditions, postconditions) are the single source of truth — same
contract in, same test suite out, no LLM at generation time.

Package name `versailles-dbc`, CLI binary `versailles` — see
[ADR-0001](docs/decisions/0001-package-and-cli-naming.md).

## How To Use

### Install

```bash
npm install -g versailles-dbc
```

Then `versailles <command>` works anywhere.

> **Honest note:** the package is not yet published to npm. Until it is, install
> from source — see the [Contributing](#contributing--install-from-source)
> section below.

### Set up a project

```bash
cd your-project
versailles init
```

`init` scaffolds `.versailles/` with a default config and empty stores. It
re-seeds the schema files, so only run it on a fresh project — not on one you've
already authored.

### Author your contract

Write your contract directly in `.versailles/contracts.json` — invariants,
preconditions, postconditions. Declare any predicates inline in the top-level
`"predicates"` map (no separate `predicates.json`, no staged directory, no
review step). See the [contract expression cheat-sheet](#contract-expression-cheat-sheet)
below for the grammar.

### The TDD loop

The primary flow, once your contract is authored:

```bash
versailles validate      # single gate: parse + semantic + predicate checks
versailles generate      # deterministic suite → .versailles/generated/
bun run test             # run the generated tests
versailles check         # CI lint: validate + staleness (exit 0/1/2)
git commit               # the commit IS the approval (ADR-0012)
```

**Greenfield (contract-first, ADR-0011):** skip `extract-manifests` entirely —
write the contract *before* any source. `generate` emits tests that fail via
import error (legitimate TDD Red), then implement the source until the tests
pass (Green).

**Brownfield:** run `versailles extract-manifests` first to derive
`manifests.json` from existing source, then proceed through the loop.

### The five commands

| Command | Purpose |
|---|---|
| `init` | Scaffold `.versailles/` — default config + empty stores (new projects only) |
| `extract-manifests` | Derive `manifests.json` from source (brownfield only; `--prune` removes entries no longer in source) |
| `validate` | Parse + semantically validate the whole workspace; structured report, exit 0/1. Use `--verbose` to see raw expr + parsed AST per clause |
| `generate` | Deterministic tests from contracts → `.versailles/generated/` |
| `check` | CI lint: validate + staleness; exit `0` clean · `1` parse/validation · `2` blocking staleness |

### Contract expression cheat-sheet

A clause is a boolean expression (full grammar: [build-spec §4](docs/build-spec.md#4-contract-expression-grammar),
[contract-language spec](docs/specs/contract-language.md)). Example clauses:

```text
invariant      balance >= 0
precondition   sku != ""
precondition   isPositive(price)          # predicate declared in the contracts.json predicates map
postcondition  balance == old(balance) + price   # old(field) is postconditions ONLY
```

Grammar you can use anywhere (build-spec §4.1):

```text
comparison     ==  !=  >  >=  <  <=  in      # e.g. balance in [0, 1, 2]
boolean        and  or  not                  # e.g. sku != "" and price > 0 — no parentheses
literals       42  "open"  true  false  null  [1, 2, 3]
field paths    order.items[].sku             # [] = any element · [0] = by index
```

`old(field)` anywhere but a postcondition is a parse error; predicate calls must
resolve to a predicate declared in the top-level `"predicates"` map of
`contracts.json` with `verifiedPure: true`; single `=` is a parse error
(`==` only).

### Using in CI

```bash
versailles check
# exit 0 = clean · 1 = parse/validation error · 2 = blocking staleness
```

GitHub Actions:

```yaml
- run: versailles check
  # 0 clean · 1 parse/validation · 2 stale (source drifted from contracts)
```

Set `staleness.blockOnStale: false` in `.versailles/config.json` to warn instead of
fail (exit 0). Details: [staleness-check](docs/features/staleness-check.md),
[build-spec §8](docs/build-spec.md#8-staleness--ci-lint).

## Contributing / Install from source

Requires [bun](https://bun.sh) (Node ≥ 20 and npm work too — `npm install` runs the
same `prepare` build that materializes `dist/`).

```bash
git clone https://github.com/JalenEvans/versailles.git
cd versailles
bun install        # builds dist/ via the prepare hook
bun link           # register the CLI globally
```

### Run the committed example — fast path

```bash
bun run example:generate          # build → re-extract → regenerate, asserts byte-identical output
cd examples/order-service && bun run test   # 4 generated tests pass
```

### Run the test suite

```bash
bun test
```

Gates (run before opening a PR):

```bash
scripts/validate-docs.sh
scripts/validate-contracts.sh
```

### The full loop, step by step

The example ships a fully-authored workspace (contract + inline predicate
declaration already in `contracts.json`), so every step is re-runnable in place
and stays byte-identical to what's committed:

```bash
cd examples/order-service

versailles extract-manifests          # 1. derive manifests.json from source (brownfield only)
versailles validate                   # 2. parse + semantic + predicate checks
versailles generate                   # 3. write the deterministic suite to .versailles/generated/
versailles check                      # 4. CI lint: validate + staleness (exit 0)
bun run test                          # 5. run the generated tests (4 pass)
# git commit the workspace — the commit IS the approval
```

The committed contract (`examples/order-service/.versailles/contracts.json`)
declares the `isPositive` predicate inline in the top-level `"predicates"` map —
no separate `predicates.json`, no staged directory, no review step.

### Docs

- **Master build spec:** [docs/build-spec.md](docs/build-spec.md)
- **Contract language:** [docs/specs/contract-language.md](docs/specs/contract-language.md)
- **Contributor map:** [docs/index.md](docs/index.md)

## Trademark

Versailles™ is a trademark of Jalen Evans. Common-law trademark rights accrue from use in commerce; registration is deferred. Use of the name for derived works or distributions requires permission.
