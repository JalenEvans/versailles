# versailles

Deterministic test generation from Design-by-Contract specifications. Contracts
(invariants, preconditions, postconditions) are the single source of truth — same
contract in, same test suite out, no LLM at generation time.

Package name `versailles-dbc`, CLI binary `versailles` — see
[ADR-0001](docs/decisions/0001-package-and-cli-naming.md).

## Quickstart (~10 minutes)

Requires [bun](https://bun.sh) (Node ≥ 20 and npm work too — `npm install` runs the
same `prepare` build that materializes `dist/`).

```bash
git clone https://github.com/JalenEvans/versailles.git
cd versailles
bun install        # builds dist/ via the prepare hook
bun link           # register the CLI globally
```

### 1. Run the committed example — fast path

```bash
bun run example:generate          # build → re-extract → regenerate, asserts byte-identical output
cd examples/order-service && bun run test   # 4 generated tests pass
```

### 2. The full loop, step by step

The example ships a fully-authored workspace, so every step is re-runnable in
place and stays byte-identical to what's committed:

```bash
cd examples/order-service

versailles extract-manifests          # 1. derive manifests.json from source
# 2. author the contract — the staged object is already at
#    .versailles/staged/OrderService.json; edit it to change the contract
versailles register-predicate isPositive \
  --source OrderService.isPositive --params amount --paramTypes number \
  --verifiedPure                     # 3. register the pure predicate the contract calls
versailles review OrderService       # 4. inspect the staged contract (expr + parsed AST)
versailles review OrderService --approve   # 5. validate + merge the staged object into contracts.json
versailles validate                  # 6. validate the whole workspace
versailles generate                  # 7. write the deterministic suite to .versailles/generated/
versailles check                     # 8. CI lint: validate + staleness (exit 0)
bun run test                         # 9. run the generated tests (4 pass)
```

For a **new** project, prepend `versailles init` (scaffolds `.versailles/` with a
default config + empty stores — it re-seeds the schema files, so don't run it on
an authored workspace) and write your contract to
`.versailles/staged/<Component>.json` before the `review … --approve` step.

## The nine commands

| Command | Purpose |
|---|---|
| `init` | Scaffold `.versailles/` — default config + empty stores (new projects only) |
| `extract-manifests` | Derive `manifests.json` from source (`--prune` removes entries no longer in source) |
| `validate` | Parse + semantically validate the whole workspace; structured report, exit 0/1 |
| `check` | CI lint: validate + staleness; exit `0` clean · `1` parse/validation · `2` blocking staleness |
| `generate` | Deterministic tests from approved contracts → `generated/` |
| `review <Component> [operation]` | Human review of a staged contract; `--approve` merges the single object, `--reject` writes nothing |
| `register-predicate <name> --source <Module.functionName>` | Register a predicate with verified `sourceRef`/`sourceHash`; `--verifiedPure` is the human purity gate |
| `verify-purity <name>` | Flip `verifiedPure` true after a manual lint (never recomputes hashes) |
| `remind-unverified` | List predicates missing `verifiedPure`; never writes |

## Contract expression cheat-sheet

A clause is a boolean expression (full grammar: [build-spec §4](docs/build-spec.md#4-contract-expression-grammar),
[contract-language spec](docs/specs/contract-language.md)). The committed example's
clauses (`examples/order-service/.versailles/contracts.json`):

```text
invariant      balance >= 0
precondition   sku != ""
precondition   isPositive(price)          # registered, verified-pure predicate call
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
resolve to a registered `verifiedPure: true` predicate; single `=` is a parse
error (`==` only).

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

Set `staleness.blockOnStale: false` in `.versailles/config.json` to warn instead of
fail (exit 0). Details: [staleness-check](docs/features/staleness-check.md),
[build-spec §8](docs/build-spec.md#8-staleness--ci-lint).

## Docs

- **Master build spec:** [docs/build-spec.md](docs/build-spec.md)
- **Contract language:** [docs/specs/contract-language.md](docs/specs/contract-language.md)
- **Contributor map:** [docs/index.md](docs/index.md)