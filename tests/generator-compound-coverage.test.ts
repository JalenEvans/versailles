import { describe, expect, it } from "vitest";

import { parseExpression } from "../packages/core/src/core/parser.js";
import type { ClauseKind, Node } from "../packages/core/src/core/parser.js";
import type {
	ContractClause,
	ContractsFile,
	ManifestsFile,
	PredicatesFile,
	VersaillesContext,
	WorkspaceConfig,
} from "../packages/core/src/loader/workspace.js";
import { renderClausePredicate } from "../packages/engine/src/generator/codegen.js";
import {
	coverageManifest,
	emitSuite,
	planPropertyBlocks,
	planTestCases,
} from "../packages/engine/src/generator/index.js";
import type {
	PlannedCase,
	PlannedSuite,
} from "../packages/engine/src/generator/index.js";
import { derivePropertySeed } from "../packages/engine/src/generator/seed.js";

/**
 * Compound-precondition interaction coverage (ADR-0017, build-spec §9.6) —
 * the story's core motivation, demonstrated as a fixture.
 *
 * The v1 deterministic heuristic (build-spec §9.5 keeps SMT out of scope)
 * analyzes clauses PER CLAUSE: classifyClause (planner.ts) recognizes only
 * top-level numeric comparisons, `in` partitions, and predicate calls. A
 * COMPOUND precondition over multiple params — e.g.
 * `a >= 0 and b >= 0 and a + b <= 100` — is classified "other", and the
 * falsifier synthesis (falsifyingInput) cannot derive an input from an `and`
 * node. The result: the v1 concrete plan silently misses the clause entirely
 * (zero cases, a detectable zero-coverage gap in coverage.json), and even the
 * split-clause variant only probes the PER-CLAUSE boundaries (a=-1/0/1 with
 * b=0, b=-1/0/1 with a=0) — it never probes the INTERACTION region
 * (a=60, b=60), where both per-clause lower bounds hold (60 >= 0 ✓, 60 >= 0 ✓)
 * but the compound fails (60 + 60 = 120 > 100 ✗).
 *
 * The seeded PBT property planner (planPropertyBlocks) covers exactly that
 * interaction space — WHEN the clause's codegen'd oracle is SINGLE-param. A
 * 1-param compound (e.g. `amount >= 10 and amount <= 100` →
 * `(amount) => amount >= 10 && amount <= 100`) maps to strategy "property"
 * and plans an accept-side satisfies descriptor whose emitted property
 * filters its arbitrary with that oracle, so the valid region is precisely
 * the interaction space the per-clause heuristic cannot see — and the emitted
 * block RUNS (the W1 execution gate in tests/emitters-pbt.test.ts).
 *
 * A 2-param coupled compound (e.g. `a >= 0 and b >= 0 and a + b <= 100` →
 * `(a, b) => ...`) is PLANNED under VERSAILLES-165 via the **record +
 * bounded filter** joint-sampling strategy: the planner derives per-param
 * bounds INCLUDING cross-param propagation from the sum leaf BEFORE any
 * filter (`a + b <= 100` with lower bounds L_a = 0, L_b = 0 → `a <= 100`,
 * `b <= 100`), so the sampled joint region is bounded first and the valid
 * region stays healthy (~>=50%) — never filter-sparse, never a hang. The
 * clause's descriptor carries the derived bounds (`a: { min: 0, max: 100 }`,
 * `b: { min: 0, max: 100 }`) and NO `PROPERTY_UNPLANNABLE` warning — the
 * multi-param oracle is never emitted as a per-param `.filter` (fast-check's
 * filter passes ONE value, so a per-param filter would evaluate the predicate
 * against undefined and hang). Only genuinely unrepresentable shapes — an
 * unboundable coupling (no derivable cross-param bounds), a coupling whose
 * propagation yields INVERTED bounds (min > max — an unsatisfiable region,
 * Center W1), a coupling referencing a manifest-FIELD operand (Center B2),
 * non-mirrorable equality, equality-of-sums, an `or`-clause whose bounds are
 * excluded from propagation (Center W4), unrenderable oracles, component-typed
 * params — stay `PROPERTY_UNPLANNABLE` (same non-blocking tier as
 * `PREDICATE_UNPLANNABLE` — `CliResult.warnings`, exit 0), descriptor skipped,
 * strategy record kept at "property" (the SELECTOR still chooses property; the
 * PLANNER finds it unplannable). The v1 heuristic misses the clause SILENTLY
 * (zero cases) — PBT plans it non-silently (VERSAILLES-165).
 *
 * Fixture style mirrors tests/generator.test.ts / generator-planner-pbt.test.ts
 * (in-memory, fully-loaded, isValid VersaillesContext built from real parsed
 * ASTs — no files, no loader).
 */

// ── Fixture helpers (mirroring generator-planner-pbt.test.ts conventions) ────

const EMPTY_MANIFESTS: ManifestsFile = { manifests: {} };
const EMPTY_PREDICATES: PredicatesFile = { predicates: {} };

function makeConfig(
	propertyBased?: WorkspaceConfig["propertyBased"],
): WorkspaceConfig {
	const config: WorkspaceConfig = {
		sourceRoots: ["src/**/*.ts"],
		language: "typescript",
		testFramework: "vitest",
		generatedDir: ".versailles/generated",
		staleness: { blockOnStale: false },
	};
	if (propertyBased !== undefined) {
		config.propertyBased = propertyBased;
	}
	return config;
}

/** Parses every fixture expr with the real parser (loader-shaped context). */
function parseAll(contracts: ContractsFile): Record<string, Node> {
	const parsed: Record<string, Node> = {};
	const walk = (clauses: ContractClause[], kind: ClauseKind): void => {
		for (const clause of clauses) {
			const result = parseExpression(clause.expr, kind, clause.id);
			// Narrow on the `errors` property rather than `!result.ok`: under
			// the non-strict tsc flags TS inverts the `ok` discriminant
			// narrowing, so `result.errors` after `!result.ok` fails to
			// type-check (the same quirk behind the pre-existing TS2339s at
			// parser.ts:827 and workspace.ts:665). Property-presence narrowing
			// is discriminant-independent and holds in both modes.
			if ("errors" in result) {
				throw new Error(
					`fixture parse failed for ${clause.id}: ${JSON.stringify(result.errors)}`,
				);
			}
			parsed[clause.id] = result.ast;
		}
	};
	for (const component of Object.values(contracts.contracts)) {
		walk(component.invariants ?? [], "invariants");
		for (const operation of Object.values(component.operations ?? {})) {
			walk(operation.preconditions ?? [], "preconditions");
			walk(operation.postconditions ?? [], "postconditions");
		}
	}
	return parsed;
}

function makeContext(
	contracts: ContractsFile,
	propertyBased?: WorkspaceConfig["propertyBased"],
	manifests: ManifestsFile = EMPTY_MANIFESTS,
): VersaillesContext {
	return {
		config: makeConfig(propertyBased),
		contracts,
		manifests,
		predicates: EMPTY_PREDICATES,
		parsedContracts: parseAll(contracts),
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

function allCases(suite: PlannedSuite): PlannedCase[] {
	return [
		...suite.operations.flatMap((group) => group.cases),
		...suite.invariantCases,
	];
}

// ── Fixture: the flagship interaction contract ───────────────────────────────
// OrderService.placeOrder(a: number, b: number) with ONE compound precondition
// clause. Each per-clause bound (a >= 0, b >= 0) is individually satisfiable at
// the interaction point (60, 60), but the COUPLED constraint (a + b <= 100) is
// violated — the exact shape per-clause boundary analysis cannot see.
const COMPOUND_CLAUSE_ID = "OrderService.placeOrder.pre0";

function compoundContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					placeOrder: {
						id: "OrderService.placeOrder",
						params: [
							{ name: "a", type: "number" },
							{ name: "b", type: "number" },
						],
						preconditions: [
							{
								id: COMPOUND_CLAUSE_ID,
								expr: "a >= 0 and b >= 0 and a + b <= 100",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "placeorder-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, {
		enabled: true,
		numRuns: 100,
	});
}

// ── v1 concrete plan: the per-clause heuristic misses the interaction ────────

describe("v1 concrete plan — the per-clause heuristic misses the compound interaction", () => {
	it("classifies the compound as 'other' and plans ZERO concrete cases — a detectable zero-coverage gap", () => {
		const ctx = compoundContext();
		const suite = planTestCases(ctx);

		// The clause is in the source stream...
		expect(suite.clauseIds).toContain(COMPOUND_CLAUSE_ID);

		// ...but NO concrete case covers it: the operation group is empty
		// (classifyClause → "other" → falsifyingInput cannot derive an input
		// from an `and` node → no boundary, no violation case).
		const concrete = allCases(suite);
		expect(concrete).toEqual([]);
		expect(
			concrete.some((case_) => case_.traces.includes(COMPOUND_CLAUSE_ID)),
		).toBe(false);

		// coverage.json maps the clause to an empty array — the detectable
		// zero-coverage representation (§9.3), never a silent zero.
		expect(coverageManifest(suite).coverage[COMPOUND_CLAUSE_ID]).toEqual([]);
	});

	it("never probes the interaction point (a=60, b=60) — no planned input reaches it", () => {
		const ctx = compoundContext();
		const suite = planTestCases(ctx);

		const inputs = allCases(suite).map((case_) => case_.inputs);
		expect(inputs.some((i) => i.a === 60 && i.b === 60)).toBe(false);
	});

	it("per-clause reasoning cannot flag the interaction: at (60,60) every per-param lower bound holds but the compound fails", () => {
		const ctx = compoundContext();
		const ast = ctx.parsedContracts[COMPOUND_CLAUSE_ID];
		expect(ast).toBeDefined();

		// The codegen'd oracle IS the compound — the exact JS the PBT property
		// filters with. Executing it at the interaction point shows why
		// per-clause boundary analysis is insufficient.
		const code = renderClausePredicate(ast);
		expect(code).toBe("(a, b) => a >= 0 && b >= 0 && a + b <= 100");
		const oracle = new Function(`return (${code})`)() as (
			a: number,
			b: number,
		) => boolean;

		// (0, 60): every per-clause bound holds AND the compound holds.
		expect(oracle(0, 60)).toBe(true);
		// (60, 60): both per-clause lower bounds hold (60 >= 0 ✓, 60 >= 0 ✓)
		// but the coupled constraint fails (60 + 60 = 120 > 100 ✗) — the
		// interaction region per-clause boundaries never visit.
		expect(oracle(60, 60)).toBe(false);
		expect(oracle(70, 70)).toBe(false);
	});
});

// ── PBT plan: the 2-param coupled compound is PLANNED via record + bounded filter ──

describe("planPropertyBlocks — the 2-param coupled compound is PLANNED via record + bounded filter (VERSAILLES-165)", () => {
	it("plans the coupled compound — cross-param bounds derived from the sum leaf, NO warning, descriptor present, strategy stays property", () => {
		const ctx = compoundContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		// The SELECTOR still maps the compound to "property" (the strategy is
		// the open-question coverage record); the PLANNER now plans it.
		expect(strategies[COMPOUND_CLAUSE_ID]).toBe("property");

		// The codegen'd oracle (a, b) is a 2-param oracle. Under VERSAILLES-165
		// this is NOT blanket-unplannable: it routes to record + bounded
		// filter. The planner derives the cross-param bounds from the sum leaf
		// `a + b <= 100` with the operation's known lower bounds L_a = 0
		// (`a >= 0`), L_b = 0 (`b >= 0`) → a <= 100 - L_b = 100,
		// b <= 100 - L_a = 100. NO PROPERTY_UNPLANNABLE warning.
		const code = renderClausePredicate(
			ctx.parsedContracts[COMPOUND_CLAUSE_ID] as Node,
		);
		expect(code).toBe("(a, b) => a >= 0 && b >= 0 && a + b <= 100");

		expect(warnings).toEqual([]);
		expect(descriptors).toHaveLength(1);
		expect(descriptors[0]).toEqual({
			id: "OrderService.placeOrder.property-satisfies-0",
			component: "OrderService",
			operation: "placeOrder",
			// Derived cross-param bounds: each param is bounded by the sum leaf
			// (≤ 100 − the sibling's lower bound = 100) AND its own lower bound.
			params: [
				{
					param: "a",
					typeRef: "number",
					kind: "number",
					bounds: { min: 0, max: 100 },
				},
				{
					param: "b",
					typeRef: "number",
					kind: "number",
					bounds: { min: 0, max: 100 },
				},
			],
			clauses: [
				{
					clauseId: COMPOUND_CLAUSE_ID,
					code: "(a, b) => a >= 0 && b >= 0 && a + b <= 100",
				},
			],
			outcome: "satisfies",
			traces: [COMPOUND_CLAUSE_ID],
			seed: derivePropertySeed([COMPOUND_CLAUSE_ID], "1.0"),
		});

		// The clause id remains in the suite's clause stream — mapped to the
		// planned descriptor, not an empty coverage array.
		expect(suite.clauseIds).toContain(COMPOUND_CLAUSE_ID);
	});

	it("the coupled clause is no longer a zero-coverage gap — the descriptor traces it and no warning surfaces", () => {
		const ctx = compoundContext();
		const suite = planTestCases(ctx);
		const plan = planPropertyBlocks(suite, ctx);

		expect(plan.warnings).toEqual([]);
		const descriptor = plan.descriptors.find((d) =>
			d.traces.includes(COMPOUND_CLAUSE_ID),
		);
		expect(descriptor).toBeDefined();

		// The emitter renders the record + bounded filter layout
		// (`fc.record({ a: ..., b: ... }).filter(({ a, b }) => <oracle>)`)
		// over the bounded joint region — the byte-pinned emitter contract
		// lives in tests/emitters-pbt-joint.test.ts. The planner's contract
		// here is the descriptor with derived bounds.
		expect(descriptor?.params).toEqual([
			{
				param: "a",
				typeRef: "number",
				kind: "number",
				bounds: { min: 0, max: 100 },
			},
			{
				param: "b",
				typeRef: "number",
				kind: "number",
				bounds: { min: 0, max: 100 },
			},
		]);
		// No mirrorOf — this is the record + bounded filter strategy.
		expect(descriptor?.params.some((spec) => spec.mirrorOf !== undefined)).toBe(
			false,
		);
		expect(suite.clauseIds).toContain(COMPOUND_CLAUSE_ID);
	});
});

// ── PBT plan: the SINGLE-param compound IS planned + emitted ────────────────
// The same interaction-coverage story, but with a 1-param compound — the
// planable form the design keeps as a runnable property. The bounds are
// extracted from the compound's numeric sub-expressions and the emitted block
// filters the bounded arbitrary with the single-param oracle (the W1
// execution gate in tests/emitters-pbt.test.ts proves this layout RUNS).

const SINGLE_CLAUSE_ID = "OrderService.withdraw.pre0";

function singleParamCompoundContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					withdraw: {
						id: "OrderService.withdraw",
						params: [{ name: "amount", type: "number" }],
						preconditions: [
							{
								id: SINGLE_CLAUSE_ID,
								expr: "amount >= 10 and amount <= 100",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "withdraw-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, {
		enabled: true,
		numRuns: 100,
	});
}

describe("planPropertyBlocks — the SINGLE-param compound IS planned + emitted as a runnable property", () => {
	it("plans a satisfies descriptor for the 1-param compound whose oracle carries the interaction", () => {
		const ctx = singleParamCompoundContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		expect(warnings).toEqual([]);
		expect(strategies[SINGLE_CLAUSE_ID]).toBe("property");

		expect(descriptors).toHaveLength(1);
		const descriptor = descriptors[0];
		expect(descriptor).toEqual({
			id: "OrderService.withdraw.property-satisfies-0",
			component: "OrderService",
			operation: "withdraw",
			// Integer range from the compound's numeric constraint bounds — the
			// planner extracts bounds from the compound's numeric
			// sub-expressions, not just top-level numeric clauses.
			params: [
				{
					param: "amount",
					typeRef: "number",
					kind: "number",
					bounds: { min: 10, max: 100 },
				},
			],
			// The codegen'd oracle is SINGLE-param — planable and runnable.
			clauses: [
				{
					clauseId: SINGLE_CLAUSE_ID,
					code: "(amount) => amount >= 10 && amount <= 100",
				},
			],
			outcome: "satisfies",
			traces: [SINGLE_CLAUSE_ID],
			seed: derivePropertySeed([SINGLE_CLAUSE_ID], "1.0"),
		});
	});

	it("the emitted property block filters the arbitrary with the single-param oracle — the interaction region becomes the valid region", () => {
		const ctx = singleParamCompoundContext();
		const suite = planTestCases(ctx);
		const plan = planPropertyBlocks(suite, ctx);

		const files = emitSuite(suite, "vitest", {
			propertyPlan: plan,
			propertyNumRuns: 100,
		});
		const file = files.find((f) => f.path.endsWith("OrderService.test.ts"));
		expect(file).toBeDefined();

		// The single-param oracle is embedded verbatim as the filter/assert
		// const — never a multi-param filter.
		expect(file?.content).toContain(
			"\t\tconst OrderService_withdraw_pre0 = (amount) => amount >= 10 && amount <= 100;",
		);
		expect(file?.content).toContain(
			"fc.property(amount.filter(OrderService_withdraw_pre0), (amount) => {",
		);
		// The assertion re-checks the compound oracle on the sampled inputs.
		expect(file?.content).toContain(
			"expect(OrderService_withdraw_pre0(amount)).toBe(true);",
		);
		// The seeded run is pinned on the descriptor's derived seed.
		expect(file?.content).toContain(
			`fc.assert(prop, { seed: ${derivePropertySeed([SINGLE_CLAUSE_ID], "1.0")}, numRuns: 100 });`,
		);
	});
});

// ── Contrast: the split-clause variant ───────────────────────────────────────
// The same interaction written as THREE per-clause preconditions is the form
// the v1 heuristic DOES produce concrete cases for — and the demonstration is
// sharpest there: the boundary cases sit exactly at the per-clause edges
// (a=-1/0/1 with b=0, b=-1/0/1 with a=0) and never reach a=60/b=60, while the
// coupled inequality (a + b <= 100) — unclassifiable per-clause ("other") —
// gets NO concrete case at all.
//
// Under VERSAILLES-165 the coupled inequality IS planned as a PBT property:
// its codegen'd oracle `(a, b) => a + b <= 100` is a 2-param oracle, but the
// sum-leaf cross-param propagation uses the OPERATION-WIDE numeric bounds —
// the sibling clauses pre0 (`a >= 0`) and pre1 (`b >= 0`) provide the lower
// bounds, so the coupling is boundable (a <= 100, b <= 100) and routes to
// record + bounded filter — never a silent zero, never a per-param filter.
const SPLIT_CLAUDE_IDS = {
	pre0: "OrderService.placeOrder.pre0", // a >= 0
	pre1: "OrderService.placeOrder.pre1", // b >= 0
	pre2: "OrderService.placeOrder.pre2", // a + b <= 100 (the interaction)
} as const;

function splitContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					placeOrder: {
						id: "OrderService.placeOrder",
						params: [
							{ name: "a", type: "number" },
							{ name: "b", type: "number" },
						],
						preconditions: [
							{ id: SPLIT_CLAUDE_IDS.pre0, expr: "a >= 0" },
							{ id: SPLIT_CLAUDE_IDS.pre1, expr: "b >= 0" },
							{ id: SPLIT_CLAUDE_IDS.pre2, expr: "a + b <= 100" },
						],
						postconditions: [],
						effects: [],
						sourceHash: "placeorder-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, {
		enabled: true,
		numRuns: 100,
	});
}

describe("contrast — the split-clause variant: v1's per-clause boundaries never probe the interaction", () => {
	it("plans boundary cases exactly at the per-clause edges — and the coupled inequality gets NO concrete case", () => {
		const ctx = splitContext();
		const suite = planTestCases(ctx);

		// The v1 per-clause boundary sweep: three cases per numeric
		// comparison, the sibling param pinned at its valid default (0).
		const boundaryPairs = allCases(suite)
			.filter((case_) => case_.kind === "boundary")
			.map((case_) => `${case_.inputs.a},${case_.inputs.b}`)
			.sort();
		expect(boundaryPairs).toEqual(["-1,0", "0,-1", "0,0", "0,0", "0,1", "1,0"]);

		// The per-clause edges — a ∈ {-1,0,1} with b=0, b ∈ {-1,0,1} with
		// a=0 — never include the interaction point.
		expect(
			allCases(suite).some(
				(case_) => case_.inputs.a === 60 && case_.inputs.b === 60,
			),
		).toBe(false);

		// The coupled inequality `a + b <= 100` is "other" per-clause: no
		// falsifier can be derived, so it gets ZERO concrete cases — a
		// zero-coverage gap exactly like the single-compound form.
		const covered = allCases(suite).filter((case_) =>
			case_.traces.includes(SPLIT_CLAUDE_IDS.pre2),
		);
		expect(covered).toEqual([]);
		expect(coverageManifest(suite).coverage[SPLIT_CLAUDE_IDS.pre2]).toEqual([]);
	});

	it("the coupled inequality is PLANNED via cross-param propagation from the sibling clauses' lower bounds (VERSAILLES-165)", () => {
		const ctx = splitContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		// Fixture clause-code verification: `a + b <= 100` codegen's to a
		// TWO-param oracle `(a, b) => ...` — it references BOTH params. Under
		// VERSAILLES-165 this is NOT blanket-unplannable: the sum leaf's
		// cross-param propagation uses the OPERATION-WIDE numeric bounds — the
		// sibling clauses pre0 (`a >= 0` → L_a = 0) and pre1 (`b >= 0` → L_b =
		// 0) provide the lower bounds, so `a + b <= 100` derives a <= 100 - L_b
		// = 100, b <= 100 - L_a = 100. The coupling IS boundable → PLANNED.
		const pre2Ast = ctx.parsedContracts[SPLIT_CLAUDE_IDS.pre2];
		expect(pre2Ast).toBeDefined();
		expect(renderClausePredicate(pre2Ast)).toBe("(a, b) => a + b <= 100");

		// Strategy gating is UNCHANGED: the simple numeric-bound clauses stay
		// "example" (their v1 boundary cases fully cover them); the coupled
		// inequality — unclassifiable per-clause — still maps to "property"
		// (the SELECTOR's decision). The PLANNER then plans the boundable
		// coupling.
		expect(strategies).toEqual({
			[SPLIT_CLAUDE_IDS.pre0]: "example",
			[SPLIT_CLAUDE_IDS.pre1]: "example",
			[SPLIT_CLAUDE_IDS.pre2]: "property",
		});

		// NO PROPERTY_UNPLANNABLE warning — the clause is planned.
		expect(warnings).toEqual([]);

		// The descriptor is planned for the coupled inequality, its params
		// carrying the derived cross-param bounds (own lower bound 0 from the
		// sibling clause + the propagated upper bound 100 from the sum leaf).
		expect(descriptors).toHaveLength(1);
		expect(descriptors[0]).toEqual({
			id: "OrderService.placeOrder.property-satisfies-0",
			component: "OrderService",
			operation: "placeOrder",
			params: [
				{
					param: "a",
					typeRef: "number",
					kind: "number",
					bounds: { min: 0, max: 100 },
				},
				{
					param: "b",
					typeRef: "number",
					kind: "number",
					bounds: { min: 0, max: 100 },
				},
			],
			clauses: [
				{
					clauseId: SPLIT_CLAUDE_IDS.pre2,
					code: "(a, b) => a + b <= 100",
				},
			],
			outcome: "satisfies",
			traces: [SPLIT_CLAUDE_IDS.pre2],
			seed: derivePropertySeed([SPLIT_CLAUDE_IDS.pre2], "1.0"),
		});

		// The clause id stays in the suite's clause stream — mapped to the
		// planned descriptor, never a silent zero.
		expect(suite.clauseIds).toContain(SPLIT_CLAUDE_IDS.pre2);
	});
});

// ── B2: a coupled leaf referencing a manifest FIELD is NOT plannable ─────────
// Center B2: a sum/difference coupling whose operand is a manifest FIELD (not
// an op param) can never be joint-sampled — the field is instance state, never
// a record key, never a sampled arbitrary, never a destructured filter param.
// Even with sound bounds on BOTH sides (balance >= 0 below gives the field a
// lower bound), the coupling is PROPERTY_UNPLANNABLE: descriptor absent,
// warning present, strategy stays "property".
const FIELD_COUPLING_CLAUSE_ID = "OrderService.purchase.pre2";

function fieldOperandCouplingContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					purchase: {
						id: "OrderService.purchase",
						params: [{ name: "amount", type: "number" }],
						preconditions: [
							{
								id: "OrderService.purchase.pre0",
								expr: "amount >= 0",
							},
							{
								id: "OrderService.purchase.pre1",
								expr: "balance >= 0",
							},
							{
								id: FIELD_COUPLING_CLAUSE_ID,
								expr: "amount + balance <= 100",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "field-coupling-hash",
					},
				},
			},
		},
	};
	const manifests: ManifestsFile = {
		manifests: {
			OrderService: {
				sourceHash: "man-field-coupling",
				fields: { balance: "number" },
			},
		},
	};
	return makeContext(contracts, { enabled: true, numRuns: 100 }, manifests);
}

describe("planPropertyBlocks — a coupling referencing a manifest-FIELD operand is PROPERTY_UNPLANNABLE (Center B2)", () => {
	it("`amount + balance <= 100` with balance a manifest field is NOT plannable — descriptor absent, warning present, strategy stays property", () => {
		const ctx = fieldOperandCouplingContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		// Fixture clause-code verification: the coupling oracle references the
		// field balance — a TWO-param oracle `(amount, balance) => ...`.
		const code = renderClausePredicate(
			ctx.parsedContracts[FIELD_COUPLING_CLAUSE_ID] as Node,
		);
		expect(code).toBe("(amount, balance) => amount + balance <= 100");

		// Bounds exist on both sides (amount >= 0, balance >= 0), so a naive
		// propagation WOULD derive upper[amount] = 100 — but the field operand
		// is never sampleable/destructureable, so the coupling is NOT planned.
		const warning = warnings.find((w) => w.field === FIELD_COUPLING_CLAUSE_ID);
		expect(warning).toBeDefined();
		expect(warning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);

		// No descriptor carries the coupling — and no descriptor's params
		// reference the field (a field can never be a sampled arbitrary).
		expect(
			descriptors.some((d) => d.traces.includes(FIELD_COUPLING_CLAUSE_ID)),
		).toBe(false);
		expect(
			descriptors.flatMap((d) => d.params.map((spec) => spec.param)),
		).not.toContain("balance");

		// The SELECTOR still records property; the PLANNER finds it unplannable.
		expect(strategies[FIELD_COUPLING_CLAUSE_ID]).toBe("property");
		expect(strategies["OrderService.purchase.pre0"]).toBe("example");
		expect(strategies["OrderService.purchase.pre1"]).toBe("example");

		// The coverage gap stays visible.
		expect(suite.clauseIds).toContain(FIELD_COUPLING_CLAUSE_ID);
	});
});

// ── W1: propagation yielding INVERTED bounds is NOT plannable ────────────────
// Center W1: `a >= 0 and b >= 200 and a + b <= 100` — the sum leaf derives
// upper[a] = 100 − 200 = −100 < lower[a] = 0 (and upper[b] = 100 < lower[b] =
// 200): the propagated joint region is EMPTY/unsatisfiable. An empty region is
// never a valid fast-check box (fc.integer({ min, max }) with min > max throws
// at runtime), so the clause is PROPERTY_UNPLANNABLE — descriptor absent,
// warning present, strategy stays "property".
const INVERTED_BOUNDS_CLAUSE_ID = "OrderService.balanceOrder.pre0";

function invertedBoundsContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					balanceOrder: {
						id: "OrderService.balanceOrder",
						params: [
							{ name: "a", type: "number" },
							{ name: "b", type: "number" },
						],
						preconditions: [
							{
								id: INVERTED_BOUNDS_CLAUSE_ID,
								expr: "a >= 0 and b >= 200 and a + b <= 100",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "inverted-bounds-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, { enabled: true, numRuns: 100 });
}

describe("planPropertyBlocks — inverted derived bounds are PROPERTY_UNPLANNABLE (Center W1)", () => {
	it("`a >= 0 and b >= 200 and a + b <= 100` (empty region) is NOT plannable — descriptor absent, warning present, no inverted bounds anywhere", () => {
		const ctx = invertedBoundsContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		const code = renderClausePredicate(
			ctx.parsedContracts[INVERTED_BOUNDS_CLAUSE_ID] as Node,
		);
		expect(code).toBe("(a, b) => a >= 0 && b >= 200 && a + b <= 100");

		const warning = warnings.find((w) => w.field === INVERTED_BOUNDS_CLAUSE_ID);
		expect(warning).toBeDefined();
		expect(warning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);

		// No descriptor is planned — and none may carry an inverted
		// (min > max) bound: a valid joint box must be non-empty.
		expect(descriptors).toHaveLength(0);
		for (const descriptor of descriptors) {
			for (const spec of descriptor.params) {
				if (spec.bounds !== undefined) {
					expect(spec.bounds.min).toBeLessThanOrEqual(spec.bounds.max);
				}
			}
		}

		expect(strategies[INVERTED_BOUNDS_CLAUSE_ID]).toBe("property");
		expect(suite.clauseIds).toContain(INVERTED_BOUNDS_CLAUSE_ID);
	});
});

// ── W3: propagation-direction pins (the under-tested corners of the
// cross-param rules the planner ships with) ──────────────────────────────────
// Difference coupling: `p1 − p2 <= C` with U2 (b ≤ 100) and L1 (a ≥ 0) →
// p1 ≤ C + U2 (a ≤ 150), p2 ≥ L1 − C (b ≥ −50).
const DIFF_CLAUSE_ID = "OrderService.planOrder.pre2";

function differenceCouplingContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					planOrder: {
						id: "OrderService.planOrder",
						params: [
							{ name: "a", type: "number" },
							{ name: "b", type: "number" },
						],
						preconditions: [
							{ id: "OrderService.planOrder.pre0", expr: "a >= 0" },
							{ id: "OrderService.planOrder.pre1", expr: "b <= 100" },
							{ id: DIFF_CLAUSE_ID, expr: "a - b <= 50" },
						],
						postconditions: [],
						effects: [],
						sourceHash: "diff-coupling-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, { enabled: true, numRuns: 100 });
}

// Lower-bound direction: `p1 + p2 >= C` with U1 (a ≤ 100), U2 (b ≤ 100) →
// p1 ≥ C − U2 (a ≥ −50), p2 ≥ C − U1 (b ≥ −50).
const LOWER_COUPLING_CLAUSE_ID = "OrderService.stockOrder.pre2";

function lowerBoundCouplingContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					stockOrder: {
						id: "OrderService.stockOrder",
						params: [
							{ name: "a", type: "number" },
							{ name: "b", type: "number" },
						],
						preconditions: [
							{
								id: "OrderService.stockOrder.pre0",
								expr: "a <= 100",
							},
							{
								id: "OrderService.stockOrder.pre1",
								expr: "b <= 100",
							},
							{ id: LOWER_COUPLING_CLAUSE_ID, expr: "a + b >= 50" },
						],
						postconditions: [],
						effects: [],
						sourceHash: "lower-coupling-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, { enabled: true, numRuns: 100 });
}

// Strict-op handling: `p1 + p2 > C` follows the numericConstraintBounds
// convention (`> C` → the exclusive boundary C+1), so `a + b > 50` propagates
// with C+1 = 51 → a ≥ 51 − 100 = −49.
const STRICT_CLAUSE_ID = "OrderService.strictOrder.pre2";

function strictCouplingContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					strictOrder: {
						id: "OrderService.strictOrder",
						params: [
							{ name: "a", type: "number" },
							{ name: "b", type: "number" },
						],
						preconditions: [
							{
								id: "OrderService.strictOrder.pre0",
								expr: "a <= 100",
							},
							{
								id: "OrderService.strictOrder.pre1",
								expr: "b <= 100",
							},
							{ id: STRICT_CLAUSE_ID, expr: "a + b > 50" },
						],
						postconditions: [],
						effects: [],
						sourceHash: "strict-coupling-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, { enabled: true, numRuns: 100 });
}

describe("planPropertyBlocks — propagation-direction pins (W3)", () => {
	it("difference coupling `a - b <= 50` with a >= 0, b <= 100 derives a {0, 150}, b {-50, 100}", () => {
		const ctx = differenceCouplingContext();
		const suite = planTestCases(ctx);
		const { descriptors, warnings } = planPropertyBlocks(suite, ctx);

		expect(warnings).toEqual([]);
		expect(descriptors).toHaveLength(1);
		expect(descriptors[0]).toEqual({
			id: "OrderService.planOrder.property-satisfies-0",
			component: "OrderService",
			operation: "planOrder",
			params: [
				{
					param: "a",
					typeRef: "number",
					kind: "number",
					bounds: { min: 0, max: 150 },
				},
				{
					param: "b",
					typeRef: "number",
					kind: "number",
					bounds: { min: -50, max: 100 },
				},
			],
			clauses: [{ clauseId: DIFF_CLAUSE_ID, code: "(a, b) => a - b <= 50" }],
			outcome: "satisfies",
			traces: [DIFF_CLAUSE_ID],
			seed: derivePropertySeed([DIFF_CLAUSE_ID], "1.0"),
		});
		expect(suite.clauseIds).toContain(DIFF_CLAUSE_ID);
	});

	it("lower-bound direction `a + b >= 50` with a <= 100, b <= 100 derives a {-50, 100}, b {-50, 100}", () => {
		const ctx = lowerBoundCouplingContext();
		const suite = planTestCases(ctx);
		const { descriptors, warnings } = planPropertyBlocks(suite, ctx);

		expect(warnings).toEqual([]);
		expect(descriptors).toHaveLength(1);
		expect(descriptors[0]).toEqual({
			id: "OrderService.stockOrder.property-satisfies-0",
			component: "OrderService",
			operation: "stockOrder",
			params: [
				{
					param: "a",
					typeRef: "number",
					kind: "number",
					bounds: { min: -50, max: 100 },
				},
				{
					param: "b",
					typeRef: "number",
					kind: "number",
					bounds: { min: -50, max: 100 },
				},
			],
			clauses: [
				{
					clauseId: LOWER_COUPLING_CLAUSE_ID,
					code: "(a, b) => a + b >= 50",
				},
			],
			outcome: "satisfies",
			traces: [LOWER_COUPLING_CLAUSE_ID],
			seed: derivePropertySeed([LOWER_COUPLING_CLAUSE_ID], "1.0"),
		});
		expect(suite.clauseIds).toContain(LOWER_COUPLING_CLAUSE_ID);
	});

	it("strict-op handling `a + b > 50` follows the C+1 convention — derives a {-49, 100}, b {-49, 100}", () => {
		const ctx = strictCouplingContext();
		const suite = planTestCases(ctx);
		const { descriptors, warnings } = planPropertyBlocks(suite, ctx);

		expect(warnings).toEqual([]);
		expect(descriptors).toHaveLength(1);
		expect(descriptors[0]).toEqual({
			id: "OrderService.strictOrder.property-satisfies-0",
			component: "OrderService",
			operation: "strictOrder",
			params: [
				{
					param: "a",
					typeRef: "number",
					kind: "number",
					bounds: { min: -49, max: 100 },
				},
				{
					param: "b",
					typeRef: "number",
					kind: "number",
					bounds: { min: -49, max: 100 },
				},
			],
			clauses: [{ clauseId: STRICT_CLAUSE_ID, code: "(a, b) => a + b > 50" }],
			outcome: "satisfies",
			traces: [STRICT_CLAUSE_ID],
			seed: derivePropertySeed([STRICT_CLAUSE_ID], "1.0"),
		});
		expect(suite.clauseIds).toContain(STRICT_CLAUSE_ID);
	});
});

// ── W4: `or`-derived bounds are EXCLUDED from propagation ───────────────────
// Center W4: `a <= 10 or a >= 100` claims bounds on a from BOTH disjuncts
// (upper 10 AND lower 100) — a union of intervals, NOT a sound single bound,
// so those bounds must never feed a sibling coupling's cross-param
// propagation. With the or-bounds excluded, the coupling `a + b <= 50` has no
// lower bound on a → unboundable → PROPERTY_UNPLANNABLE (never a descriptor
// carrying unsound/inverted bounds derived from the disjuncts).
const OR_CLAUSE_ID = "OrderService.mixOrder.pre0";
const OR_COUPLING_CLAUSE_ID = "OrderService.mixOrder.pre2";

function orDerivedBoundsContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					mixOrder: {
						id: "OrderService.mixOrder",
						params: [
							{ name: "a", type: "number" },
							{ name: "b", type: "number" },
						],
						preconditions: [
							{ id: OR_CLAUSE_ID, expr: "a <= 10 or a >= 100" },
							{ id: "OrderService.mixOrder.pre1", expr: "b >= 0" },
							{ id: OR_COUPLING_CLAUSE_ID, expr: "a + b <= 50" },
						],
						postconditions: [],
						effects: [],
						sourceHash: "or-bounds-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, { enabled: true, numRuns: 100 });
}

describe("planPropertyBlocks — `or`-derived bounds never feed propagation (Center W4)", () => {
	it("a coupling that would rely on an or-clause's bounds becomes PROPERTY_UNPLANNABLE — no descriptor with unsound/inverted bounds", () => {
		const ctx = orDerivedBoundsContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		// Fixture clause-code verification: the or-clause is a single-param
		// oracle, the coupling a 2-param oracle.
		const orCode = renderClausePredicate(
			ctx.parsedContracts[OR_CLAUSE_ID] as Node,
		);
		expect(orCode).toBe("(a) => a <= 10 || a >= 100");
		const couplingCode = renderClausePredicate(
			ctx.parsedContracts[OR_COUPLING_CLAUSE_ID] as Node,
		);
		expect(couplingCode).toBe("(a, b) => a + b <= 50");

		// The coupling is unplannable (the or-bounds on a are excluded, so no
		// lower bound exists for the sum leaf).
		const couplingWarning = warnings.find(
			(w) => w.field === OR_COUPLING_CLAUSE_ID,
		);
		expect(couplingWarning).toBeDefined();
		expect(couplingWarning?.code).toBe("PROPERTY_UNPLANNABLE");

		// No descriptor is planned — and none may carry inverted (min > max)
		// bounds derived from the or-clause's conflicting disjuncts.
		expect(descriptors).toHaveLength(0);
		for (const descriptor of descriptors) {
			for (const spec of descriptor.params) {
				if (spec.bounds !== undefined) {
					expect(spec.bounds.min).toBeLessThanOrEqual(spec.bounds.max);
				}
			}
		}

		// The SELECTOR keeps the compound clauses at property; the PLANNER
		// finds the operation's accept-side blocks unplannable.
		expect(strategies[OR_CLAUSE_ID]).toBe("property");
		expect(strategies["OrderService.mixOrder.pre1"]).toBe("example");
		expect(strategies[OR_COUPLING_CLAUSE_ID]).toBe("property");

		// The coverage gaps stay visible.
		expect(suite.clauseIds).toContain(OR_CLAUSE_ID);
		expect(suite.clauseIds).toContain(OR_COUPLING_CLAUSE_ID);
	});
});
