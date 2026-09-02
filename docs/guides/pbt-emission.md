# Guide: Seeded Property-Based Test Emission (`propertyBased`)

**Audience:** a user who has the basic loop working (see the [zero-to-green guide](getting-started.md)) and wants to opt into property-based testing.
**Vocabulary:** [glossary](../glossary.md) — *property block, seeded PBT emission, seed literal, `propertyBased`, joint sampling, equality-mirror, record sampling, `PROPERTY_UNPLANNABLE`*

This is a **user-facing** guide to the `propertyBased` feature ([ADR-0017](../decisions/0017-property-based-test-emission-mit-core.md), VERSAILLES-158/165) — what you get, what the emitted code looks like, and how to read it. For the full rules and the strategy-selection machinery, the authoritative references are [build-spec §9.6](../build-spec.md#96-seeded-pbt-emission-opt-in-adr-0017) and the [deterministic-generation spec](../specs/deterministic-generation.md). This guide links to those instead of duplicating them.

## What seeded PBT emission gives you

The default `versailles generate` output is deterministic, **concrete** cases: boundary values, equivalence partitions, precondition-violation cases, postcondition-satisfaction cases, invariant tests. Those cover each clause well at its own boundaries — but compound boolean preconditions can produce *vacuous* interaction cases: each clause is exercised individually, and the *combination* of clauses is barely probed. That is the v1 "silent lie" defect ([ADR-0017](../decisions/0017-property-based-test-emission-mit-core.md)).

Seeded PBT emission is the cheap, statistical mitigation: when you enable it, the generator additionally emits **property blocks** — `fc.assert(prop, { seed, numRuns })`-style tests whose inputs are drawn from fast-check arbitraries derived from the contract's types and constraint bounds, with the contract clauses codegen'd into the test as the oracle. Use it for **interaction coverage beyond per-clause boundaries** — the compound shapes concrete cases can't explore.

Two things stay true:

- **Generation is still deterministic.** Each block's seed is a literal derived from the context (clause IDs + grammar version), so `versailles generate` twice produces byte-identical files — including the seed literal. Only the *emitted test's runtime* is random, and it's pinned by that seed.
- **The concrete cases remain the audit spine.** Property blocks are emitted **additively**; `coverage.json` traceability continues to map every clause to concrete test IDs.

## Prerequisites

The tool ships the **codegen, not the library**: the consuming project needs `fast-check` as a dev dependency.

```bash
bun add -d fast-check
```

Enable the feature in `.versailles/config.json`:

```json
{
  "propertyBased": {
    "enabled": true,
    "numRuns": 100
  }
}
```

- `enabled` — default `false`; when `false` or absent, output is byte-identical to the v1 concrete suite (backward-compat pin).
- `numRuns` — property runs per emitted block, default `100`. Raise it (e.g. `500`) when you want more confidence on a critical operation; lower it (e.g. `25`) to keep CI fast. Each run is cheap — the trade-off is purely coverage confidence vs. runtime.
- `seed` — optional explicit 32-bit override; when absent, each block's seed is derived deterministically from the context. Pin it when you need cross-edit reproduction (below).

Full schema: [build-spec §3.1](../build-spec.md#31-configjson).

## What generated property blocks look like

The generator picks a sampling strategy per clause automatically — you never write these by hand. There are four shipped layouts (all shown trimmed; the full rules are [build-spec §9.6](../build-spec.md#96-seeded-pbt-emission-opt-in-adr-0017)). Note each block carries a §9.3 traceability comment and a pinned `fc.assert(prop, { seed, numRuns })`, and every oracle lambda param carries an explicit type from the contract/manifest — `(sku: string) => sku !== ""` — never an implicit `any` (the emission-soundness guarantee, [ADR-0021](../decisions/0021-totality-of-emission.md)). Container op-param typeRefs render recursively: `list<X>` → `X[]` (e.g. `(tags: string[]) => isNonEmpty(tags)`), `optional<X>` → `X | undefined` (e.g. `(count: number | undefined) => isNonNegative(count)`). An op-param with no renderable TS form even then (e.g. `list<Order>`) surfaces the non-silent `EMISSION_UNRENDERABLE` warning and its oracles are omitted from the block.

### 1. Per-param filter — single-param oracles

A single-param guard (e.g. `sku != ""`) samples that param and `.filter`s on the oracle:

```ts
// traces: "OrderService.addItem.pre0"
const sku = fc.string();
const OrderService_addItem_pre0 = (sku: string) => sku !== "";
const prop = fc.property(sku.filter(OrderService_addItem_pre0), (sku) => {
	new OrderService().addItem(sku, 1);
	expect(OrderService_addItem_pre0(sku)).toBe(true);
});
fc.assert(prop, { seed: 1514751120, numRuns: 100 });
```

### 2. Equality-mirror — param-param equality (`p1 == p2`)

A bothSideFieldRef equality whose operands are **both operation params** (e.g. a postcondition `status == newStatus`) is mirrored, never filtered: the source param is sampled, the target mirrors it, and the oracle holds by construction — zero filter sparsity ([glossary: equality-mirror](../glossary.md)):

```ts
const status = fc.string();
const AccountService_setStatus_post0 = (status: string, newStatus: string) => status === newStatus;
const prop = fc.property(status, (status) => {
	const newStatus = status;   // ← the mirror: target param mirrors the source
	new AccountService().setStatus(newStatus);
	expect(AccountService_setStatus_post0(status, newStatus)).toBe(true);
});
fc.assert(prop, { seed: 777, numRuns: 100 });
```

### 3. Record + bounded filter — coupled numeric compounds

A coupled compound over multiple params (e.g. `a >= 0 and b >= 0 and a + b <= 100`) is sampled as a **joint region**: the planner derives per-param bounds first — including cross-param propagation from the sum/difference leaves (`a + b <= 100` with `a >= 0`, `b >= 0` → each bounded by `100 −` the other's lower bound) — so the space is bounded before any filter and the valid region stays healthy (~≥50%), never filter-sparse, never a hang ([glossary: record sampling](../glossary.md)):

```ts
const OrderService_placeOrder_pre0 = (a: number, b: number) => a >= 0 && b >= 0 && a + b <= 100;
const prop = fc.property(
	fc.record({ a: fc.integer({ min: 0, max: 100 }), b: fc.integer({ min: 0, max: 100 }) })
		.filter(({ a, b }) => OrderService_placeOrder_pre0(a, b)),
	({ a, b }) => {
		new OrderService().placeOrder(a, b);
		expect(OrderService_placeOrder_pre0(a, b)).toBe(true);
	}
);
fc.assert(prop, { seed: 808, numRuns: 100 });
```

### 4. FIELD-BOUND — field-source equality (`status == newStatus`)

A bothSideFieldRef equality with a **manifest-field** operand (e.g. `status == newStatus` where `status` is instance state) is not mirrored and not recorded: the field is never a sampled arbitrary. The block samples **only the op-param**, binds the component instance, calls with the sampled param, and asserts the oracle with the field mapped to `instance.<field>` — a genuine post-state check ([build-spec §9.6](../build-spec.md#96-seeded-pbt-emission-opt-in-adr-0017)); for a non-public field the field maps to the deliberate `(instance as any).<field>` cast instead ([ADR-0021](../decisions/0021-totality-of-emission.md)):

```ts
const newStatus = fc.string();
const AccountService_setStatus_post0 = (status: string, newStatus: string) => status === newStatus;
const prop = fc.property(newStatus, (newStatus) => {
	const instance = new AccountService();
	instance.setStatus(newStatus);
	expect(AccountService_setStatus_post0(instance.status, newStatus)).toBe(true);
});
fc.assert(prop, { seed: 777, numRuns: 100 });
```

Which layout you get is decided by the clause shape — you just enable the feature and read the output.

## Reading a failing property

When a property block finds a counterexample, fast-check prints it with the **seed and path** that produced it:

```
Property failed after 1 test
{ seed: 1514751120, path: "0:1", endOnFailure: true }
Counterexample: [sku: "", price: 1]
```

- **Reproduce run-to-run:** the seed is already pinned in the emitted file (`fc.assert(prop, { seed: 1514751120, ... })`), so re-running the suite replays the exact same exploration. No environment flakiness.
- **Reproduce across contract edits:** any contract edit reshuffles the derived seeds (they hash clause IDs + grammar version), so a failure you're investigating can move. To hold it still while you edit, pin the seed explicitly in config:

```json
{
  "propertyBased": {
    "enabled": true,
    "numRuns": 100,
    "seed": 1514751120
  }
}
```

Regenerate, and every block now pins to that seed — the counterexample stays reproducible across edits ([build-spec §9.6](../build-spec.md#96-seeded-pbt-emission-opt-in-adr-0017)).

## The warning tiers (non-silent, exit 0)

Not every clause can become a runnable property. When the planner can't route a clause to a sampling strategy, it surfaces a **`PROPERTY_UNPLANNABLE`** warning in `CliResult.warnings` — exit `0`, never a silent zero. The shapes that land here are genuinely unrepresentable:

- **non-mirrorable equality** — `!=` / `!==` (the mirror only works for `==`/`===`), and equality-of-sums like `a + b == C`
- **field-operand couplings** — a coupling that references a manifest-field operand (the record/filter layouts can't sample instance state)
- **inverted / unsatisfiable regions** — a coupling whose cross-param propagation yields inverted bounds (no valid region exists)
- **zero-param field-field equalities** — `f1 == f2`, both operands manifest fields (no arbitrary to sample)
- **component-typed params** — a param with no ArbitrarySpec kind at all

The clause's property block is skipped, but it is **never hidden**: the clause ID stays in the suite's clause stream, so `coverage.json` maps it to a visible zero-coverage gap ([build-spec §9.3](../build-spec.md#93-traceability)), and the strategy record still reports the selector's choice (`property`) — a warning on top of a recorded strategy, never a silent hole.

Two sibling tiers work the same way and are worth knowing:

- **`PREDICATE_UNPLANNABLE`** — a predicate-call precondition from which no deterministic violation input can be derived; the predicate gets no violation case and a non-silent warning.
- **`UNPLANNABLE_OPERATION`** — a planned operation with no matching source method; it is never emitted as an unrunnable call, just warned.

All three ride the same non-blocking tier: warning in `CliResult.warnings`, exit `0` — your pipeline keeps running, and the coverage gap stays visible.

## When to use it (and when not to)

- **Use it** when compound preconditions or postconditions interact in ways boundary cases can't probe — that's the defect it exists to mitigate. The cost is a `fast-check` dev dependency and a wider emitted surface.
- **Keep it off** when the v1 concrete suite is enough and you want the smallest possible generated surface.
- **Don't mistake it for proof.** PBT is stochastic exploration — it finds bugs, it can't prove their absence. The sound successor (SMT-backed witness synthesis) is deferred to the paid engine ([build-spec §9.5](../build-spec.md#95-smt-backed-generation-soundness-requirement-roadmap-§16), [ADR-0014](../decisions/0014-roadmap-reconciliation.md)).

## Source of authority

[build-spec §9.6](../build-spec.md#96-seeded-pbt-emission-opt-in-adr-0017) · [Spec: deterministic-generation](../specs/deterministic-generation.md) · [ADR-0017](../decisions/0017-property-based-test-emission-mit-core.md) · [Glossary: PBT terms](../glossary.md) · [Feature: deterministic generation](../features/deterministic-generation.md)