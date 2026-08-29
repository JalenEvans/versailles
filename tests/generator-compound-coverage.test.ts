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
 * `(a, b) => ...`) is PROPERTY_UNPLANNABLE (Center B1 fix): a multi-param
 * oracle cannot be turned into per-param filterable arbitraries — the
 * emitted block filters each arbitrary with the codegen'd oracle, and
 * fast-check's filter passes ONE value, so the multi-param filter would
 * evaluate the predicate against undefined and silently discard the whole
 * domain. The planner surfaces the clause non-silently via the
 * PROPERTY_UNPLANNABLE warning (same non-blocking tier as
 * PREDICATE_UNPLANNABLE — CliResult.warnings, exit 0), skips the descriptor,
 * and keeps the strategy record at "property" (the SELECTOR still chooses
 * property; the PLANNER finds it unplannable). The v1 heuristic misses the
 * same clause SILENTLY (zero cases) — PBT signals it NON-SILENTLY via the
 * warning: never a silent zero.
 *
 * Fixture style mirrors tests/generator.test.ts / generator-planner-pbt.test.ts
 * (in-memory, fully-loaded, isValid VersaillesContext built from real parsed
 * ASTs — no files, no loader).
 */

// ── Fixture helpers (mirroring generator-planner-pbt.test.ts conventions) ────

const EMPTY_MANIFESTS: ManifestsFile = { version: "1.0", manifests: {} };
const EMPTY_PREDICATES: PredicatesFile = { version: "1.0", predicates: {} };

function makeConfig(
	propertyBased?: WorkspaceConfig["propertyBased"],
): WorkspaceConfig {
	const config: WorkspaceConfig = {
		grammarVersion: "1.0",
		schemaVersion: "1.0",
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
): VersaillesContext {
	return {
		config: makeConfig(propertyBased),
		contracts,
		manifests: EMPTY_MANIFESTS,
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
		version: "1.0",
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

// ── PBT plan: the 2-param coupled compound is PROPERTY_UNPLANNABLE ──────────

describe("planPropertyBlocks — the 2-param coupled compound is PROPERTY_UNPLANNABLE (Center B1 fix)", () => {
	it("marks the clause PROPERTY_UNPLANNABLE — descriptor absent, warning present, strategy stays property (never a silent zero)", () => {
		const ctx = compoundContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		// The SELECTOR still maps the compound to "property" (the strategy is
		// the open-question coverage record); the PLANNER finds it unplannable.
		expect(strategies[COMPOUND_CLAUSE_ID]).toBe("property");

		// The codegen'd oracle (a, b) is a 2-param oracle — it cannot be turned
		// into per-param filterable arbitraries (fast-check's filter passes ONE
		// value). Same LoaderWarning channel as PREDICATE_UNPLANNABLE
		// (CliResult.warnings, non-blocking, exit 0).
		const warning = warnings.find((w) => w.field === COMPOUND_CLAUSE_ID);
		expect(warning).toBeDefined();
		expect(warning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);

		// The 2-param clause contributes NO descriptor — the v1 heuristic
		// misses it silently, PBT signals it non-silently: never a silent zero.
		expect(descriptors).toEqual([]);
		expect(descriptors.some((d) => d.traces.includes(COMPOUND_CLAUSE_ID))).toBe(
			false,
		);

		// The coverage gap stays visible: the clause id remains in the suite's
		// clause stream (coverage.json maps it to an empty array — the
		// detectable zero-coverage representation, §9.3).
		expect(suite.clauseIds).toContain(COMPOUND_CLAUSE_ID);
		expect(coverageManifest(suite).coverage[COMPOUND_CLAUSE_ID]).toEqual([]);
	});

	it("emits NO multi-param filter for the 2-param compound — the unplannable clause contributes no property block", () => {
		const ctx = compoundContext();
		const suite = planTestCases(ctx);
		const plan = planPropertyBlocks(suite, ctx);

		const files = emitSuite(suite, "vitest", {
			propertyPlan: plan,
			propertyNumRuns: 100,
		});
		const file = files.find((f) => f.path.endsWith("OrderService.test.ts"));
		expect(file).toBeDefined();

		// No descriptor ⇒ no fast-check surface, no fc.property, no multi-param
		// `.filter((a, b) => ...)` broken layout (the B1 bug shape).
		expect(file?.content).not.toContain("fast-check");
		expect(file?.content).not.toContain("fc.property");
		expect(file?.content).not.toContain("a.filter(");
		expect(file?.content).not.toContain("a + b <= 100");
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
		version: "1.0",
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
// Under the Center B1 fix the coupled inequality ALSO cannot become a PBT
// property: its codegen'd oracle `(a, b) => a + b <= 100` is a 2-param oracle
// (it references BOTH params), so the planner marks it PROPERTY_UNPLANNABLE —
// the same non-silent tier as the single-compound form, never a silent zero.
const SPLIT_CLAUDE_IDS = {
	pre0: "OrderService.placeOrder.pre0", // a >= 0
	pre1: "OrderService.placeOrder.pre1", // b >= 0
	pre2: "OrderService.placeOrder.pre2", // a + b <= 100 (the interaction)
} as const;

function splitContext(): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
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

	it("the coupled inequality's oracle is MULTI-param → PROPERTY_UNPLANNABLE: descriptor absent, warning present, strategy stays property (never a silent zero)", () => {
		const ctx = splitContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		// Fixture clause-code verification: `a + b <= 100` codegen's to a
		// TWO-param oracle `(a, b) => ...` — it references BOTH params, so the
		// B1 rule counts 2 callback params and the clause cannot be turned
		// into per-param filterable arbitraries.
		const pre2Ast = ctx.parsedContracts[SPLIT_CLAUDE_IDS.pre2];
		expect(pre2Ast).toBeDefined();
		expect(renderClausePredicate(pre2Ast)).toBe("(a, b) => a + b <= 100");

		// Strategy gating is UNCHANGED: the simple numeric-bound clauses stay
		// "example" (their v1 boundary cases fully cover them); the coupled
		// inequality — unclassifiable per-clause — still maps to "property"
		// (the SELECTOR's decision). The PLANNER then finds the 2-param oracle
		// unplannable and surfaces the warning.
		expect(strategies).toEqual({
			[SPLIT_CLAUDE_IDS.pre0]: "example",
			[SPLIT_CLAUDE_IDS.pre1]: "example",
			[SPLIT_CLAUDE_IDS.pre2]: "property",
		});

		// The multi-param clause contributes NO descriptor — same LoaderWarning
		// channel as PREDICATE_UNPLANNABLE (CliResult.warnings, non-blocking,
		// exit 0). The v1 heuristic misses the clause silently; PBT signals it
		// non-silently: never a silent zero.
		const warning = warnings.find((w) => w.field === SPLIT_CLAUDE_IDS.pre2);
		expect(warning).toBeDefined();
		expect(warning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);
		expect(descriptors).toEqual([]);
		expect(
			descriptors.some((d) => d.traces.includes(SPLIT_CLAUDE_IDS.pre2)),
		).toBe(false);

		// The coverage gap stays visible: the clause id remains in the suite's
		// clause stream (coverage.json maps it to an empty array — the
		// detectable zero-coverage representation, §9.3).
		expect(suite.clauseIds).toContain(SPLIT_CLAUDE_IDS.pre2);
		expect(coverageManifest(suite).coverage[SPLIT_CLAUDE_IDS.pre2]).toEqual([]);
	});
});
