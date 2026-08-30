# Guide: Getting Started — Zero to Green with Versailles

**Audience:** a new user who wants to see the whole loop once, end to end.
**Vocabulary:** [glossary](../glossary.md) — *contract, clause, invariant, precondition, postcondition, declarative predicate, `.versailles/` workspace, generated test, traceability comment, exit code*

## What you're building

Versailles is deterministic test generation from Design-by-Contract specifications: you author contracts (invariants, preconditions, postconditions) in `.versailles/contracts.json`, and the tool compiles them into a test suite — same contract in, same suite out, no LLM at generation time. The [contributor map](../index.md) is the map and the [build spec](../build-spec.md) is the territory; this guide is a taught walkthrough of the primary loop, not a reference.

You will build a small `BankAccount` component from zero: write a contract, validate it, generate a test suite, watch it fail (Red), implement the source, watch it pass (Green), and land it with `versailles check` in CI and a git commit. **No source file exists until Step 5** — that ordering is the whole point (contract-first, [ADR-0011](../decisions/0011-contract-first-emission.md)).

## Before you start

You need a working `versailles` CLI (install from source — see the [README](../../README.md#contributing--install-from-source); the package is not yet published to npm) and a TypeScript project with vitest wired up. Nothing else: no source file, no manifest, no hand-written test.

The loop you're about to run, as a preview:

```bash
versailles init        # scaffold .versailles/
# …author the contract in .versailles/contracts.json…
versailles validate    # gate 1: parse + semantic + predicate checks
versailles generate    # deterministic suite → .versailles/generated/
bun run test           # Red (import error) → Green (after Step 5)
versailles check       # CI lint: validate + staleness (exit 0/1/2)
git commit             # the commit IS the approval (ADR-0012)
```

## Step 0 — Scaffold the workspace

```bash
cd your-project
versailles init
```

`init` creates the [`.versailles/` workspace](../domains/workspace-context.md) — the jointly-loaded tool state:

```
.versailles/
├── config.json        # seeded defaults: $schema pointer, sourceRoots, language, testFramework, …
├── contracts.json     # empty store: {}
└── manifests.json     # empty store: {}  (filled by extract-manifests, brownfield only)
```

`config.json` is seeded with TypeScript + vitest defaults and `staleness.blockOnStale: true`. `contracts.json` and `manifests.json` start as empty stores — you author the contract next, and you never hand-author the manifest.

> `init` re-seeds the schema files, so only run it on a fresh project — not one you've already authored.

## Step 1 — Author your first contract

Open `.versailles/contracts.json` and write the whole contract. This is the artifact that drives everything downstream:

```json
{
  "predicates": {
    "isPositive": {
      "source": "BankAccount.isPositive",
      "params": ["amount"],
      "paramTypes": ["number"],
      "returnType": "boolean",
      "verifiedPure": true
    }
  },
  "contracts": {
    "BankAccount": {
      "invariants": [
        { "id": "BankAccount.inv0", "expr": "balance >= 0" }
      ],
      "operations": {
        "withdraw": {
          "id": "BankAccount.withdraw",
          "params": [{ "name": "amount", "type": "number" }],
          "preconditions": [
            { "id": "BankAccount.withdraw.pre0", "expr": "isPositive(amount)" }
          ],
          "postconditions": [
            { "id": "BankAccount.withdraw.post0", "expr": "balance == old(balance) - amount" }
          ],
          "effects": [
            { "field": "balance", "kind": "mutate" }
          ],
          "sourceHash": "00000000"
        }
      }
    }
  }
}
```

What each piece means (vocabulary lives in the [glossary](../glossary.md); the grammar is [build-spec §4](../build-spec.md#4-contract-expression-grammar)):

- **`predicates` map (top level)** — the [declarative predicate](../glossary.md) `isPositive` is declared inline here, no separate registry file, no registration CLI ([ADR-0013](../decisions/0013-declarative-predicates-remove-registration-cli.md)). `verifiedPure: true` is your human assertion that the function is side-effect-free and terminating — `validate` hard-errors on anything else ([ADR-0006](../decisions/0006-predicate-purity-registration-gate.md)).
- **`invariants`** — `balance >= 0` must hold for every instance at all times, before and after every operation call. A clause.
- **`operations.withdraw`** — one operation with a typed `params` list, a `preconditions` clause (`isPositive(amount)` — a predicate-call precondition), a `postconditions` clause that compares against pre-call state via `old(balance)`, and an `effects` declaration saying `withdraw` mutates `balance` (the generator uses effects to know which field a postcondition-satisfaction test should assert against).
- **`sourceHash`** — a placeholder in greenfield; the git commit is the approval anyway ([ADR-0012](../decisions/0012-git-commit-as-approval-remove-review-gate.md)). On the brownfield path, `extract-manifests` computes real structural hashes.

Grammar gotchas worth knowing before you type: single `=` is a parse error (use `==`), `old(field)` is legal **only** in postconditions, and predicate calls must resolve to a declared predicate with `verifiedPure: true` (build-spec §4.1).

## Step 2 — `validate`: the single gate

```bash
versailles validate
```

**What passing looks like:** exit `0`, a clean structured report. Your contract parses, semantically validates (fields resolve, types line up), and the predicate declaration verifies.

**What a structured error looks like:** make a typo — change the postcondition to a single `=`:

```bash
versailles validate   # exit 1
```

```json
{
  "contractId": "BankAccount.withdraw.post0",
  "field": "postconditions[0]",
  "position": 20,
  "found": "=",
  "expected": ["=="],
  "message": "Unexpected token '=' at position 20 — did you mean '=='?"
}
```

This is a [rejected command](../features/command-rejection.md) outcome: a machine-readable structured error, never a crash, never a silent partial run. Fix the typo and re-run until exit `0` — everything downstream depends on `isValid: true`. Use `validate --verbose` any time you want the raw `expr` next to its parsed AST as a parser-sanity view.

## Step 3 — `generate`: the deterministic suite

```bash
versailles generate
```

Because you have a contract and **no manifests**, generation runs contract-first ([ADR-0011](../decisions/0011-contract-first-emission.md)) — module paths are derived from the contract, not from source. What lands in `.versailles/generated/`:

```
.versailles/generated/
├── BankAccount.test.ts   # the vitest suite (one file per component)
└── coverage.json         # coverage manifest: clause ID → test IDs
```

`coverage.json` maps every contract clause ID to the tests covering it, so a clause with zero generated tests is detectable ([build-spec §9.3](../build-spec.md#93-traceability)). Full-file, idempotent, fully tool-owned — never hand-edit `generated/`, always regenerate ([build-spec §9.4](../build-spec.md#94-output-emitters), [ADR-0002](../decisions/0002-deterministic-generation-llm-authoring-only.md)).

## Step 4 — Run the generated tests and read the suite

```bash
bun run test
```

**Expect Red — legitimately.** The generated suite imports a module that does not exist yet:

```
FAIL  .versailles/generated/BankAccount.test.ts
Cannot find module '../../src/BankAccount.js' imported from .versailles/generated/BankAccount.test.ts
```

That `MODULE_NOT_FOUND` is the canonical TDD Red via import error ([ADR-0011](../decisions/0011-contract-first-emission.md)) — not a tooling failure. Before you make it green, read what the generator wrote. Open `BankAccount.test.ts`:

```ts
// Auto-generated by the Versailles deterministic generator core.
// Do not edit — regenerate with `versailles generate`.
// traces: "BankAccount.inv0", "BankAccount.withdraw.pre0", "BankAccount.withdraw.post0"
import { describe, expect, it } from "vitest";

import { BankAccount } from "../../src/BankAccount.js";
import { isPositive } from "../../src/BankAccount.js";

describe("withdraw", () => {
	it("BankAccount.withdraw.precondition-violation-0 — violates BankAccount.withdraw.pre0 (predicate isPositive falsified via amount)", () => {
		expect(() => new BankAccount().withdraw(-1)).toThrow();
	});

	it("BankAccount.withdraw.postcondition-satisfaction-0 — valid input asserting postconditions BankAccount.withdraw.post0", () => {
		const instance = new BankAccount();
		instance.balance = 50;
		instance.withdraw(1);
		expect(instance.balance).toEqual(49);
	});
});

describe("BankAccount invariants", () => {
	it("BankAccount.withdraw.invariant-0 — call BankAccount.withdraw and assert invariant BankAccount.inv0 still holds", () => {
		const instance = new BankAccount();
		instance.balance = 50;
		instance.withdraw(1);
		expect(instance.balance).toBeGreaterThanOrEqual(0);
	});
});
```

Walk one concrete case — `postcondition-satisfaction-0`. The generator built a valid input (`amount = 1`, satisfying `isPositive`), **captured the pre-call state** (`instance.balance = 50`), called the operation, and asserted the postcondition with `old(balance)` resolved against that captured state: `49 == 50 - 1`. The `effects` declaration told it which field to assert.

Now the traceability. Every generated test carries a [traceability comment](../glossary.md) back to the clause that produced it:

- The file header lists every clause covered: `// traces: "BankAccount.inv0", "BankAccount.withdraw.pre0", "BankAccount.withdraw.post0"`.
- Each test name encodes clause ID + case kind: `BankAccount.withdraw.precondition-violation-0` → clause `BankAccount.withdraw.pre0`, a violation case asserting the rejection idiom (default `throws`).
- `coverage.json` maps each clause ID → the test IDs covering it:

```json
{
  "coverage": {
    "BankAccount.inv0": ["BankAccount.withdraw.invariant-0"],
    "BankAccount.withdraw.pre0": ["BankAccount.withdraw.precondition-violation-0"],
    "BankAccount.withdraw.post0": ["BankAccount.withdraw.postcondition-satisfaction-0"]
  }
}
```

Every clause is covered; nothing is silent. (The default suite is concrete cases only. Opt into seeded property-based blocks later — see the [PBT consumer guide](pbt-emission.md).)

## Step 5 — Implement the source (Red → Green)

Write `src/BankAccount.ts` — just enough to satisfy the contract:

```ts
/** Registered pure predicate: amount must be a positive number. */
export function isPositive(amount: number): boolean {
	return amount > 0;
}

/** A bank account with a non-negative balance. */
export class BankAccount {
	private balance: number;

	constructor(initial: number = 0) {
		this.balance = initial;
	}

	/**
	 * Withdraws amount. Precondition: isPositive(amount).
	 * Postcondition: balance == old(balance) - amount.
	 */
	withdraw(amount: number): void {
		if (!isPositive(amount)) {
			throw new Error("amount must be positive");
		}
		this.balance -= amount;
	}
}
```

Re-run:

```bash
bun run test   # Green — all generated tests pass
```

The suite didn't change; the source caught up to the contract. That's the whole contract-first TDD loop: contract → tests (Red via import error) → implementation (Green). No stub source was ever fabricated to satisfy the tool.

## Step 6 — `check` in CI, and the commit is the approval

```bash
versailles check
# exit 0 = clean · 1 = parse/validation error · 2 = blocking staleness
```

`check` is the CI lint: it re-validates **and** recomputes staleness — if your source ever drifts from the contract (or vice versa), `blockOnStale: true` fails the build with exit `2` ([build-spec §8](../build-spec.md#8-staleness--ci-lint), [features/staleness-check](../features/staleness-check.md)). Wire it into GitHub Actions:

```yaml
- run: versailles check
```

Then commit the workspace:

```bash
git add .versailles src
git commit -m "BankAccount contract-first: contract, generated suite, source"
```

The **git commit is the approval** ([ADR-0012](../decisions/0012-git-commit-as-approval-remove-review-gate.md)) — there is no in-tool review or staging ceremony. Git history is the audit trail; a PR diff is the human review ([ADR-0003](../decisions/0003-git-history-as-audit-trail.md)).

## Brownfield? Run `extract-manifests` instead

Everything above assumed you're starting from zero. If you have **existing source**, the on-ramp is different: run `versailles extract-manifests` first to derive `manifests.json` from source (field types, structural `sourceHash`, method metadata) — then the loop continues the same way, and staleness checking is live from day one. Static analysis first, never LLM-authored ([ADR-0005](../decisions/0005-static-analysis-first-manifest-extraction.md)). See [features/manifest-extraction](../features/manifest-extraction.md) for the full picture.

## Next steps

- [Guide: Seeded Property-Based Test Emission](pbt-emission.md) — opt into `propertyBased` and get seed-pinned property blocks alongside the concrete cases.
- [README: the five commands](../../README.md#the-five-commands) — `init`, `extract-manifests`, `validate`, `generate`, `check`.
- [Build spec](../build-spec.md) — the authoritative reference (§3 schemas, §4 grammar, §9 generation, §12 CLI surface).
- [Glossary](../glossary.md) — the shared vocabulary, with every term you met here.