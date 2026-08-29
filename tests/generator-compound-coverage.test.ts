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
 * interaction space: the compound clause maps to strategy "property" and
 * plans an accept-side satisfies descriptor whose codegen'd oracle IS the full
 * compound predicate `(a, b) => a >= 0 && b >= 0 && a + b <= 100` — the
 * emitted property filters its arbitraries with that oracle, so the valid
 * region is precisely the interaction space the per-clause heuristic cannot
 * see.
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

// ── PBT plan: the property DOES cover the interaction space ─────────────────

describe("planPropertyBlocks — the PBT property covers the interaction space the v1 heuristic misses", () => {
	it("plans a satisfies descriptor for the compound clause whose oracle carries the interaction", () => {
		const ctx = compoundContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		expect(warnings).toEqual([]);
		expect(strategies[COMPOUND_CLAUSE_ID]).toBe("property");

		expect(descriptors).toHaveLength(1);
		const descriptor = descriptors[0];
		expect(descriptor).toEqual({
			id: "OrderService.placeOrder.property-satisfies-0",
			component: "OrderService",
			operation: "placeOrder",
			// Both params get full-range number arbitraries: the compound-aware
			// extractor can only resolve the per-param lower bounds (a >= 0,
			// b >= 0) — the COUPLED constraint `a + b <= 100` is not a
			// per-param bound, so no bounds object is derived and the oracle
			// carries the coupling.
			params: [
				{ param: "a", typeRef: "number", kind: "number" },
				{ param: "b", typeRef: "number", kind: "number" },
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
	});

	it("the emitted property block filters the arbitraries with the compound oracle — the interaction region becomes the valid region", () => {
		const ctx = compoundContext();
		const suite = planTestCases(ctx);
		const plan = planPropertyBlocks(suite, ctx);

		const files = emitSuite(suite, "vitest", {
			propertyPlan: plan,
			propertyNumRuns: 100,
		});
		const file = files.find((f) => f.path.endsWith("OrderService.test.ts"));
		expect(file).toBeDefined();

		// The compound oracle is embedded verbatim as the filter/assert const.
		expect(file?.content).toContain(
			"\t\tconst OrderService_placeOrder_pre0 = (a, b) => a >= 0 && b >= 0 && a + b <= 100;",
		);
		// Both full-range arbitraries filter through the oracle — the property
		// samples the interaction space (a=60,b=60 is filtered out, never
		// reaching the call).
		expect(file?.content).toContain(
			"fc.property(a.filter(OrderService_placeOrder_pre0), b.filter(OrderService_placeOrder_pre0), (a, b) => {",
		);
		// The interaction expression appears in the emitted source.
		expect(file?.content).toContain("a + b <= 100");
		// The assertion re-checks the compound oracle on the sampled inputs.
		expect(file?.content).toContain(
			"expect(OrderService_placeOrder_pre0(a, b)).toBe(true);",
		);
		// The seeded run is pinned on the descriptor's derived seed.
		expect(file?.content).toContain(
			`fc.assert(prop, { seed: ${derivePropertySeed([COMPOUND_CLAUSE_ID], "1.0")}, numRuns: 100 });`,
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

	it("the PBT plan covers the coupled inequality: a satisfies descriptor for pre2 with the interaction oracle", () => {
		const ctx = splitContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		expect(warnings).toEqual([]);

		// Strategy gating: the simple numeric-bound clauses stay "example"
		// (their v1 boundary cases fully cover them); the coupled inequality —
		// unclassifiable per-clause — becomes the property.
		expect(strategies).toEqual({
			[SPLIT_CLAUDE_IDS.pre0]: "example",
			[SPLIT_CLAUDE_IDS.pre1]: "example",
			[SPLIT_CLAUDE_IDS.pre2]: "property",
		});

		expect(descriptors).toHaveLength(1);
		const descriptor = descriptors[0];
		expect(descriptor.id).toBe("OrderService.placeOrder.property-satisfies-0");
		expect(descriptor.outcome).toBe("satisfies");
		expect(descriptor.traces).toEqual([SPLIT_CLAUDE_IDS.pre2]);
		expect(descriptor.clauses).toEqual([
			{
				clauseId: SPLIT_CLAUDE_IDS.pre2,
				// The interaction oracle: the property's valid-region filter
				// IS the coupled constraint the v1 boundary sweep cannot see.
				code: "(a, b) => a + b <= 100",
			},
		]);
		expect(descriptor.seed).toBe(
			derivePropertySeed([SPLIT_CLAUDE_IDS.pre2], "1.0"),
		);
	});
});
