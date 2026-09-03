# Guide: Getting Started — Zero to Green with Versailles

**Audience:** a new user who wants to see the whole loop once, end to end.
**Vocabulary:** [glossary](../glossary.md) — *contract, clause, invariant, precondition, postcondition, predicate, declarative predicate, `.versailles/` workspace, generated test, traceability comment, exit code*

## What you're building

Versailles is deterministic test generation from Design-by-Contract specifications: you author contracts (invariants, preconditions, postconditions) in `.versailles/contracts.json`, and the tool compiles them into a test suite — same contract in, same suite out, no LLM at generation time. The [contributor map](../index.md) is the map and the [build spec](../build-spec.md) is the territory; this guide is a taught walkthrough of the primary loop, not a reference.

You will build the `OrderService` component — the same domain as the committed [example workspace](../../examples/order-service/) — from zero: write a contract, validate it, generate a test suite, watch it fail (Red), implement the source, watch it pass (Green), and land it with `versailles check` in CI and a git commit. **No source file exists until Step 5** — that ordering is the whole point (contract-first, [ADR-0011](../decisions/0011-contract-first-emission.md)).

The authoring judgment you'll learn in Step 1 is the heart of Versailles' predicate model:

- **Inline-first** — checks the expression grammar already expresses (e.g. `price > 0`, `balance >= 0`) stay **inline** in the clause, not promoted to named predicates.
- **Named predicates** — the shared layer for logic the grammar *cannot* express: regex/string-format checks like `isValidSku(sku)`, cross-field computation, anything shared across components. Each is declared once in the top-level `predicates` map with full ceremony.

## Before you start

You need a working `versailles` CLI — install the beta from npm with `npm install -g versailles-dbc@beta`, or install from source (see the [README](../../README.md#contributing)) — and a TypeScript project with vitest wired up. Nothing else: no source file, no manifest, no hand-written test.

Check the tool version first — it lives in the **binary**, never in the workspace ([ADR-0018](../decisions/0018-additive-only-format-versioning.md)):

```bash
versailles -v
```

`-v` (and `--version`) is a root-level flag, not a command: it short-circuits before any workspace load, prints the machine-readable envelope with the tool version, and exits `0` from any directory:

```json
{ "ok": true, "errors": [], "warnings": [], "exitCode": 0, "output": { "version": "0.1.0-beta.0" } }
```

The loop you're about to run, as a preview:

```bash
versailles init        # scaffold .versailles/ (config with $schema pointer, empty stores)
# …author the contract in .versailles/contracts.json…
versailles validate    # gate 1: parse + semantic + predicate checks
versailles generate    # deterministic suite → .versailles/generated/
bun run test           # Red (import error) → Green (after Step 5)
versailles check       # CI lint: validate + staleness (exit 0/1/2)
git commit
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

`config.json` is seeded with TypeScript + vitest defaults, a `"$schema": "../../config.schema.json"` pointer (the machine-checkable source of truth for the config shape — the replacement for the removed version gates, [ADR-0018](../decisions/0018-additive-only-format-versioning.md)), and `staleness.blockOnStale: true`. There are **no version fields anywhere** in the workspace: `contracts.json` and `manifests.json` start as empty stores — you author the contract next, and you never hand-author the manifest.

> `init` re-seeds the schema files, so only run it on a fresh project — not one you've already authored.

## Step 1 — Author your first contract

Open `.versailles/contracts.json` and write the whole contract. This is the artifact that drives everything downstream:

```json
{
  "predicates": {
    "isValidSku": {
      "source": "OrderService.isValidSku",
      "params": ["sku"],
      "paramTypes": ["string"],
      "returnType": "boolean"
    }
  },
  "contracts": {
    "OrderService": {
      "invariants": [
        { "id": "OrderService.inv0", "expr": "balance >= 0" }
      ],
      "operations": {
        "addItem": {
          "id": "OrderService.addItem",
          "params": [
            { "name": "sku", "type": "string" },
            { "name": "price", "type": "number" }
          ],
          "preconditions": [
            { "id": "OrderService.addItem.pre0", "expr": "isValidSku(sku)" },
            { "id": "OrderService.addItem.pre1", "expr": "price > 0" }
          ],
          "postconditions": [
            { "id": "OrderService.addItem.post0", "expr": "balance == old(balance) + price" }
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

- **`predicates` map (top level)** — the [declarative predicate](../glossary.md) `isValidSku` is declared inline here, no separate registry file, no registration CLI ([ADR-0013](../decisions/0013-declarative-predicates-remove-registration-cli.md)). The declaration: `source` (`OrderService.isValidSku` — the qualified name of the real function, resolved under `config.sourceRoots`), `params`/`paramTypes` (arity and argument types), `returnType` (`boolean`). The declaration itself is the attestation — `validate` resolves the `sourceRef` against real source on every run, and no purity gate applies ([ADR-0019](../decisions/0019-drop-verified-pure-field.md)).
- **Why `isValidSku`, not an inline expression?** The two preconditions show the inline-vs-predicate judgment (see the inline-vs-predicate callout below): `price > 0` is grammar-expressible, so it stays **inline**; `isValidSku(sku)` checks a string *format* (regex — the grammar has no pattern matching), so it cannot be inline and earns a named predicate. It is also named for the reusable property, not for this one consumer.
- **`invariants`** — `balance >= 0` must hold for every instance at all times, before and after every operation call. A clause.
- **`operations.addItem`** — one operation with a typed `params` list, two `preconditions` clauses (a predicate-call precondition and an inline comparison), a `postconditions` clause that compares against pre-call state via `old(balance)`, and an `effects` declaration saying `addItem` mutates `balance` (the generator uses effects to know which field a postcondition-satisfaction test should assert against).
- **`sourceHash`** — a placeholder in greenfield; approval lives in the authored commit, not a tool ceremony ([ADR-0012](../decisions/0012-git-commit-as-approval-remove-review-gate.md)). On the brownfield path, `extract-manifests` computes real structural hashes.

> **Inline vs predicate — the judgment call**
>
> **Inline** when the check is grammar-expressible **and** single-use: `price > 0`, `balance >= 0`, `sku != ""`, `status in ["OPEN", "CLOSED"]`. Promoting these to named predicates is a smell — you pay the declaration ceremony (sourceRef, paramTypes) for logic the grammar already expresses.
>
> **Predicate** when the check is **not** grammar-expressible — regex/string-format logic (`isValidSku`), cross-field computation, anything needing statements — and when the same non-grammar check is shared across components. Name it for the reusable property it checks (`isValidSku`), **never after a single consumer** (`addItemSkuIsOk` is a smell; the generic-naming rule).
>
> The reverse-reference index (`validate --verbose` → `predicateReferences`, Step 2) is what makes the shared predicate layer discoverable — including declared-but-unused predicates.

Grammar gotchas worth knowing before you type: single `=` is a parse error (use `==`), `old(field)` is legal **only** in postconditions, and predicate calls must resolve to a declared predicate in the top-level `predicates` map (build-spec §4.1).

One more thing worth knowing about how the generator treats your predicate: v1 does not solve predicates (no SMT, build-spec §9.5). It synthesizes the **violation** input deterministically from `paramTypes` (string → `""`, number → `-1`, boolean → `false`) and uses deterministic defaults on the **accept** side (string → `"initial"`, number → `1`). So `isValidSku` gets falsified with `""`, and the accept cases call `addItem` with `"initial"` — the Step 5 implementation accepts both, so the generated suite goes Green.

## Step 2 — `validate`: the single gate

```bash
versailles validate
```

**What passing looks like:** exit `0` and the machine-readable envelope with a clean report. Your contract parses, semantically validates (fields resolve, types line up), and the predicate declaration verifies:

```json
{ "ok": true, "errors": [], "warnings": [], "exitCode": 0, "output": { "valid": true } }
```

**What a structured error looks like:** make a typo — change the postcondition to a single `=`:

```bash
versailles validate   # exit 1
```

```json
{
  "ok": false,
  "errors": [
    {
      "code": "PARSE_ERROR",
      "field": "postconditions[0]",
      "detail": "Unexpected token '=' at position 8 — did you mean '=='?"
    }
  ],
  "warnings": [],
  "exitCode": 1,
  "output": { "valid": false }
}
```

This is a [rejected command](../features/command-rejection.md) outcome: a machine-readable structured error, never a crash, never a silent partial run. Fix the typo and re-run until exit `0` — everything downstream depends on `isValid: true`.

**Look under the hood with `validate --verbose`.** The `--verbose` flag adds two parser-sanity views to the output ([build-spec §5.2](../build-spec.md#52-validator-output-contract)):

```bash
versailles validate --verbose   # exit 0, adds output.verbose
```

```json
{
  "valid": true,
  "verbose": {
    "exprViews": [
      { "id": "OrderService.inv0", "clause": "invariants", "expr": "balance >= 0", "ast": { "type": "compare", "op": ">=" } },
      { "id": "OrderService.addItem.pre0", "clause": "preconditions", "expr": "isValidSku(sku)", "ast": { "type": "predicateCall", "name": "isValidSku" } },
      { "id": "OrderService.addItem.pre1", "clause": "preconditions", "expr": "price > 0", "ast": { "type": "compare", "op": ">" } },
      { "id": "OrderService.addItem.post0", "clause": "postconditions", "expr": "balance == old(balance) + price", "ast": { "type": "compare", "op": "==" } }
    ],
    "predicateReferences": [
      { "predicate": "isValidSku", "source": "OrderService.isValidSku", "clauses": ["OrderService.addItem.pre0"], "singleUse": true }
    ]
  }
}
```

- `exprViews` — one entry per clause (sorted by id): the raw `expr` next to its parsed AST (the `ast` shown here is abbreviated; the real value is the full AST node, build-spec §4.3). A clause that failed to parse appears with `ast: null` — the parse error is already in `errors`.
- `predicateReferences` — the reverse-reference index: exactly one entry per **declared** predicate, mapping it to the clauses that call it. `singleUse: true` means exactly one clause references it. A declared predicate that nothing calls still appears — `clauses: []`, `singleUse: false` — the unused-predicate signal that makes the shared layer discoverable. No declared predicates → `[]`.

## Step 3 — `generate`: the deterministic suite

```bash
versailles generate
```

Because you have a contract and **no manifests**, generation runs contract-first ([ADR-0011](../decisions/0011-contract-first-emission.md)) — module paths are derived from the contract, not from source. What lands in `.versailles/generated/`:

```
.versailles/generated/
├── OrderService.test.ts   # the vitest suite (one file per component)
└── coverage.json          # coverage manifest: clause ID → test IDs
```

`coverage.json` maps every contract clause ID to the tests covering it, so a clause with zero generated tests is detectable ([build-spec §9.3](../build-spec.md#93-traceability)). Full-file, idempotent, fully tool-owned — never hand-edit `generated/`, always regenerate ([build-spec §9.4](../build-spec.md#94-output-emitters), [ADR-0002](../decisions/0002-deterministic-generation-llm-authoring-only.md)).

## Step 4 — Run the generated tests and read the suite

```bash
bun run test
```

**Expect Red — legitimately.** The generated suite imports a module that does not exist yet:

```
FAIL  .versailles/generated/OrderService.test.ts
Cannot find module '../../src/OrderService.ts' imported from .versailles/generated/OrderService.test.ts
```

That `MODULE_NOT_FOUND` is the canonical TDD Red via import error ([ADR-0011](../decisions/0011-contract-first-emission.md)) — not a tooling failure. Before you make it green, read what the generator wrote. Open `OrderService.test.ts`:

```ts
// Auto-generated by the Versailles deterministic generator core.
// Do not edit — regenerate with `versailles generate`.
// traces: "OrderService.inv0", "OrderService.addItem.pre0", "OrderService.addItem.pre1", "OrderService.addItem.post0"
import { describe, expect, it } from "vitest";

import { OrderService } from "../../src/OrderService.ts";

describe("addItem", () => {
	it("OrderService.addItem.precondition-violation-0 — violates OrderService.addItem.pre0 (predicate isValidSku falsified via sku)", () => {
		expect(() => new OrderService().addItem("", 1)).toThrow();
	});

	it("OrderService.addItem.boundary-0 — boundary-1 (reject): price=-1 falsifies OrderService.addItem.pre1", () => {
		expect(() => new OrderService().addItem("initial", -1)).toThrow();
	});

	it("OrderService.addItem.boundary-1 — boundary (reject): price=0 falsifies OrderService.addItem.pre1", () => {
		expect(() => new OrderService().addItem("initial", 0)).toThrow();
	});

	it("OrderService.addItem.boundary-2 — boundary+1 (accept): price=1 satisfies OrderService.addItem.pre1", () => {
		new OrderService().addItem("initial", 1);
	});

	it("OrderService.addItem.postcondition-satisfaction-0 — valid input asserting postconditions OrderService.addItem.post0", () => {
		const instance = new OrderService();
		(instance as any).balance = 50;
		instance.addItem("initial", 1);
		expect((instance as any).balance).toEqual(51);
	});
});

describe("OrderService invariants", () => {
	it("OrderService.addItem.invariant-0 — call OrderService.addItem and assert invariant OrderService.inv0 still holds", () => {
		const instance = new OrderService();
		(instance as any).balance = 50;
		instance.addItem("initial", 1);
		expect((instance as any).balance).toBeGreaterThanOrEqual(0);
	});
});
```

Walk one concrete case — `postcondition-satisfaction-0`. The generator built a valid input (`sku = "initial"`, `price = 1`), **captured the pre-call state** (`(instance as any).balance = 50`), called the operation, and asserted the postcondition with `old(balance)` resolved against that captured state: `51 == 50 + 1`. The `effects` declaration told it which field to assert. Note the cast: `balance` is declared `private` in source, the manifest records `fieldAccess: { balance: "private" }`, and the emitter reaches non-public state through the deliberate, documented `(instance as any).<field>` white-box idiom — public fields are never cast ([ADR-0021](../decisions/0021-totality-of-emission.md)).

Then notice what the generator did with your two precondition styles: `pre0` (`isValidSku(sku)`) got its violation synthesized from the predicate's `paramTypes` (string → `""`), while `pre1` (`price > 0`) got the full boundary sweep (−1, 0, +1) because the comparison is grammar-expressible — the inline-first doctrine paying off in generated coverage.

Now the traceability. Every generated test carries a [traceability comment](../glossary.md) back to the clause that produced it:

- The file header lists every clause covered: `// traces: "OrderService.inv0", "OrderService.addItem.pre0", "OrderService.addItem.pre1", "OrderService.addItem.post0"`.
- Each test name encodes clause ID + case kind: `OrderService.addItem.precondition-violation-0` → clause `OrderService.addItem.pre0`, a violation case asserting the rejection idiom (default `throws`).
- `coverage.json` maps each clause ID → the test IDs covering it:

```json
{
  "coverage": {
    "OrderService.inv0": ["OrderService.addItem.invariant-0"],
    "OrderService.addItem.pre0": ["OrderService.addItem.precondition-violation-0"],
    "OrderService.addItem.pre1": ["OrderService.addItem.boundary-0", "OrderService.addItem.boundary-1", "OrderService.addItem.boundary-2"],
    "OrderService.addItem.post0": ["OrderService.addItem.postcondition-satisfaction-0"]
  }
}
```

Every clause is covered; nothing is silent. (The default suite is concrete cases only. Opt into seeded property-based blocks later — see the [PBT consumer guide](pbt-emission.md).)

> **About the call shape you see here.** This is exactly the shape the committed example workspace emits (`bun run example:generate` regenerates it byte-identically): imports derived from the manifest's `sourcePath` (`../../src/OrderService.ts`), instance calls, real matcher assertions, and the deliberate `(instance as any)` casts for the private `balance` field — decided from the manifest's `fieldAccess: { balance: "private" }`, never applied to public fields ([ADR-0021](../decisions/0021-totality-of-emission.md)). The committed example also enables `propertyBased`, so its generated file additionally shows **typed oracle lambdas** — `(sku: string) => sku !== ""`, `(price: number) => price > 0` — explicit param types from the contract/manifest, never implicit `any`. In a pure greenfield workspace with no manifests yet, calls fall back to the legacy static options-object form and imports to the default `../../src/<Component>.js` — either resolves through vitest's module resolution once `src/OrderService.ts` exists. Run `extract-manifests` (below) and regenerate to get the source-aware shape.

## Step 5 — Implement the source (Red → Green)

Write `src/OrderService.ts` — just enough to satisfy the contract:

```ts
/** Registered pure predicate: SKU must be a valid format (letters, digits, hyphens). */
export function isValidSku(sku: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9-]{2,}$/.test(sku);
}

/** An order accumulates a non-negative balance as items are added. */
export class OrderService {
	private balance: number;

	constructor() {
		this.balance = 0;
	}

	/**
	 * Adds an item to the order. Preconditions: isValidSku(sku), price > 0.
	 * Postcondition: balance == old(balance) + price.
	 */
	addItem(sku: string, price: number): void {
		if (!isValidSku(sku)) {
			throw new Error("sku has an invalid format");
		}
		if (price <= 0) {
			throw new Error("price must be positive");
		}
		this.balance += price;
	}
}
```

Re-run:

```bash
bun run test   # Green — all generated tests pass
```

The suite didn't change; the source caught up to the contract. That's the whole contract-first TDD loop: contract → tests (Red via import error) → implementation (Green). No stub source was ever fabricated to satisfy the tool.

## Step 6 — `check` in CI, and the commit

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
git commit -m "OrderService contract-first: contract, generated suite, source"
```

Approval lives in the authored commit, not a tool ceremony ([ADR-0012](../decisions/0012-git-commit-as-approval-remove-review-gate.md)) — there is no in-tool review or staging ceremony. Git history is the audit trail; a PR diff is the human review ([ADR-0003](../decisions/0003-git-history-as-audit-trail.md)).

## Brownfield? Run `extract-manifests` instead

Everything above assumed you're starting from zero. If you have **existing source**, the on-ramp is different: run `versailles extract-manifests` first to derive `manifests.json` from source (field types + per-field `fieldAccess`/`fieldReadonly`, structural `sourceHash`, method metadata) — then the loop continues the same way, and staleness checking is live from day one. Static analysis first, never LLM-authored ([ADR-0005](../decisions/0005-static-analysis-first-manifest-extraction.md)). See [features/manifest-extraction](../features/manifest-extraction.md) for the full picture. The committed example workspace is exactly this path: `bun run example:generate` re-extracts and regenerates it, and the generated suite shows the source-aware shape (Step 4's note).

## Next steps

- [Guide: Seeded Property-Based Test Emission](pbt-emission.md) — opt into `propertyBased` and get seed-pinned property blocks alongside the concrete cases.
- [README: the five commands](../../README.md#the-five-commands) — `init`, `extract-manifests`, `validate`, `generate`, `check` (plus the root-level `-v` / `--version` flags).
- [Build spec](../build-spec.md) — the authoritative reference (§3 schemas, §4 grammar, §9 generation, §12 CLI surface).
- [Glossary](../glossary.md) — the shared vocabulary, with every term you met here.