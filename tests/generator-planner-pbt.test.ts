import { describe, expect, it } from "vitest";

import { parseExpression } from "../packages/core/src/core/parser.js";
import type { ClauseKind, Node } from "../packages/core/src/core/parser.js";
import type { LoaderWarning } from "../packages/core/src/loader/workspace.js";
import type {
	ContractClause,
	ContractsFile,
	ManifestsFile,
	PredicatesFile,
	VersaillesContext,
	WorkspaceConfig,
} from "../packages/core/src/loader/workspace.js";
// The generator core (src/generator/) is implemented; these value imports
// resolve at runtime. The assertions below pin the generator contract the
// implementation must satisfy.
import { renderClausePredicate } from "../packages/engine/src/generator/codegen.js";
import { planTestCases } from "../packages/engine/src/generator/index.js";
import type {
	ArbitrarySpec,
	PlannedSuite,
	PropertyDescriptor,
	PropertyOutcome,
	PropertyPlan,
	StrategyMap,
} from "../packages/engine/src/generator/index.js";
// The PBT planner is the NEW runtime surface of ADR-0017 Phase 4. It does
// NOT exist yet — this import is the Red-phase failure. The planner MUST live
// at packages/engine/src/generator/planner.ts (module `planner.js`, the same
// module as planTestCases) and be re-exported from the generator barrel
// (index.ts) for public-surface consistency.
import { planPropertyBlocks } from "../packages/engine/src/generator/planner.js";
import { derivePropertySeed } from "../packages/engine/src/generator/seed.js";

/**
 * Seeded PBT emission — the property-block planner (ADR-0017 Phase 4,
 * build-spec §9.6 + deterministic-generation.contract.yaml
 * `plan_property_blocks`). Pinned against the IR shipped in Chunk 3
 * (packages/engine/src/generator/ir.ts: PropertyOutcome / ArbitrarySpec /
 * PropertyClause / PropertyDescriptor), the seed helper shipped in Chunk 3
 * (seed.ts: derivePropertySeed), the per-clause strategy selector shipped in
 * Chunk 4 (strategy.ts: selectStrategy / ClauseShape / StrategyMap), and the
 * clause-codegen renderer shipped in Chunk 4 (codegen.ts:
 * renderClausePredicate).
 *
 * The planner operation does NOT exist yet — every test in this file is Red
 * until the implementer lands `planPropertyBlocks`.
 *
 * ── Module contract (what these tests require from src/generator/) ─────────
 *
 * Module: packages/engine/src/generator/planner.ts (re-exported from index.ts)
 *
 * ```ts
 * export function planPropertyBlocks(
 *   suite: PlannedSuite,
 *   context: VersaillesContext,
 * ): PropertyPlan;
 *
 * // packages/engine/src/generator/ir.ts (re-exported from index.ts):
 * export type PropertyPlan = {
 *   descriptors: PropertyDescriptor[]; // planned property blocks, additive to
 *                                       // the concrete cases (never planned
 *                                       // when propertyBased.enabled is false)
 *   strategies: StrategyMap;            // EVERY source clause id → PbtStrategy
 *                                       // (the open-question coverage record)
 *   warnings: LoaderWarning[];          // non-silent unplannable-clause warnings
 *                                       // (same tier as PREDICATE_UNPLANNABLE)
 * };
 *
 * // PropertyDescriptor gains the seed literal the emitter needs:
 * //   seed: number;  // config.propertyBased.seed ?? derivePropertySeed(traces, grammarVersion)
 * // ArbitrarySpec gains the deterministic default for list/optional params:
 * //   default?: unknown;  // [] for list<X>, the inner type's default for optional<X>
 * ```
 *
 * The planner is a pure function of (suite, context): same inputs, identical
 * descriptors/strategies/warnings (ADR-0002, re-scoped to generation-time by
 * ADR-0017). It consumes the ALREADY-PLANNED concrete suite (for the full
 * source clause-id stream and the operations the blocks attach to) plus the
 * loaded context (for param typeRefs, effects, enum members, parsed clause
 * ASTs, the predicates registry, and config.propertyBased).
 *
 * ── Design decisions these tests pin (documented for the implementer) ──────
 *
 * 1. Strategy gating (Chunk 4 selector): every source clause maps to a
 *    strategy via selectStrategy on its RESOLVED shape. "example" → NO
 *    property block (the concrete §9.1/§9.2 cases fully cover it).
 *    "property" → a property block IS planned. "property-with-falsifier"
 *    (predicateCall preconditions ONLY) → an ACCEPT-side property block is
 *    planned while the deterministic example falsifier (the concrete
 *    precondition-violation case) is retained.
 * 2. Property kinds per case kind (build-spec §9.6 table): compound /
 *    bothSideFieldRef / other preconditions and uncomputable postconditions
 *    → outcome "satisfies" (accept-side exploration: the codegen'd clause
 *    predicate filters the generated inputs, the block asserts the operation
 *    accepts). effects-overlap invariants → outcome "invariant-preserving"
 *    (oracle = the invariant predicates). expected-rejection (enabled) →
 *    outcome "rejects" with the configured rejection idiom (ADR-0007) and
 *    clauses = the codegen'd oracles of the traced postconditions +
 *    violated invariants. Literal-computable postconditions (the ones
 *    postconditionAssertions can turn into assertion descriptors) and plain
 *    invariants map to "example" — no property.
 * 3. Descriptor ids: "<component>.<operation>.property-<outcome>-<n>"
 *    (ir.ts + the seed-test example), <n> a per-(operation,outcome) counter
 *    from 0. Deterministic source order: component → operation → clauses
 *    (the planTestCases traversal), expected-rejection emitted per-operation
 *    after its clauses.
 * 4. Seed wiring: EVERY descriptor carries `seed` =
 *    config.propertyBased.seed ?? derivePropertySeed(descriptor.traces,
 *    context.config.grammarVersion). Per-block, over the block's OWN covered
 *    clause ids — the contract's "distinct property blocks carry distinct
 *    seed literals (derived per-block from the covered clause IDs + grammar
 *    version, or the explicit config override)". The override wins; the
 *    derived seed stays an int32 (fast-check's `seed | 0` round-trip).
 * 5. Per-param arbitraries (ArbitrarySpec): number → kind "number" with
 *    bounds from numericConstraintBounds — and for COMPOUND clauses the
 *    planner must extract the numeric sub-expression bounds too (the flagship
 *    `x >= 0 and x <= 1000` → bounds { min: 0, max: 1000 }; the existing
 *    numericConstraintBounds only sees top-level numeric clauses, so a
 *    compound-aware extractor is required). string → kind "string". boolean
 *    → kind "boolean". enum-typed params → kind "enum" with members from the
 *    typeRef. list<X> / optional<X> → kind = the INNER type's kind plus the
 *    deterministic default ([] for list, the inner default for optional) —
 *    the emitter renders a constant/default arbitrary.
 * 6. Unplannable clauses (contract plan_property_blocks must + must_not): a
 *    clause whose valid region cannot be turned into filterable arbitraries
 *    (e.g. a compound precondition referencing a component-typed param — no
 *    ArbitrarySpec kind exists for component types) surfaces a non-silent
 *    LoaderWarning { code: "PROPERTY_UNPLANNABLE", field: <clause id>,
 *    detail: non-empty } — the SAME non-blocking tier as PREDICATE_UNPLANNABLE
 *    (CliResult.warnings, exit 0, ADR-0004) — its descriptor is SKIPPED, and
 *    the clause's coverage gap stays visible (the clause id stays in
 *    suite.clauseIds, so coverage.json maps it to an empty array — never a
 *    silent zero). Center W5: the planner must ALSO catch renderClausePredicate
 *    throw errors PER CLAUSE and map them to this same tier; only the
 *    identifier-safety class stays hard — and planTestCases' up-front
 *    assertSafeIdentifiers already refuses those names, so a validated
 *    context cannot reach codegen with an unsafe name.
 * 10. MULTI-PARAM ORACLES (the Center B1 fix, ratified): a clause predicate
 *    with MORE THAN ONE callback parameter cannot be turned into per-param
 *    filterable arbitraries — the emitted block filters each arbitrary with
 *    the codegen'd oracle (`<arb>.filter(<oracle>)`), and fast-check's filter
 *    invokes its callback with ONE value, so a 2+-param oracle (e.g.
 *    `(status, newStatus) => status === newStatus`, or
 *    `(quantity, sku) => quantity >= 1 && ...`) makes the filter callback
 *    reference an unbound sibling parameter at runtime — broken, vacuous
 *    filters (the B1 bug). The planner therefore treats an ACCEPT-side
 *    (satisfies / invariant-preserving) clause whose codegen'd oracle has >1
 *    arrow-function parameter as PROPERTY_UNPLANNABLE: it pushes the same
 *    non-silent LoaderWarning { code: "PROPERTY_UNPLANNABLE", field: <clause
 *    id>, detail: non-empty }, SKIPS the descriptor, and keeps the strategy
 *    record at "property" (the SELECTOR still chooses property for the
 *    resolved shape; the PLANNER finds it unplannable). Single-param oracles
 *    stay runnable properties. The oracle's parameter count is read from the
 *    byte-pinned `(<params>) => <expr>` codegen output (split at the first
 *    `) => `, params on ", " — the same parsing the vitest emitter's
 *    oracleParamsOf uses).
 *    SCOPE — the rejects (expected-rejection) descriptor is NOT subject to
 *    the multi-param rule: its clauses are never embedded as filters (the
 *    emitter renders NO oracle consts and NO filter for a rejects block), so
 *    a preState-carrying multi-param oracle there is harmless and the
 *    property stays runnable. The rule applies ONLY to the accept-side
 *    filterable blocks (satisfies + invariant-preserving).
 * 7. Expected-rejection sweep replacement (contract must): when
 *    propertyBased.enabled is true the planner emits an expected-rejection
 *    PROPERTY and planTestCases must NOT emit the §9.2 bounded sweep case
 *    (EXPECTED_REJECTION_SWEEP_MAX fallback); when disabled there is no
 *    rejection property and the sweep remains. The rejection property traces
 *    the sweep's deterministic first-hit set (violated invariants + satisfied
 *    postconditions).
 * 8. Enabled gate: property blocks are NEVER planned when
 *    config.propertyBased.enabled is false or absent — planPropertyBlocks
 *    returns an empty descriptors array (the strategies map is still
 *    recorded with pbtEnabled: false). The v1 default output stays
 *    byte-identical (backward-compat pin, ADR-0017).
 * 9. Generation gate (contract invariant 1): like planTestCases,
 *    planPropertyBlocks throws when context.isValid is false.
 *
 * ── Facts the implementer needs (from the shipped planner) ─────────────────
 *
 * - numericConstraintBounds(preconditions, context) (planner.ts) returns
 *   { lower, upper } per variable from TOP-LEVEL numeric clauses only
 *   (classifyClause → "numeric"); it does NOT recurse into compound
 *   (`and`/`or`) nodes, so compound properties need a compound-aware
 *   extractor. Bounds semantics: `>=` → lower[b], `>` → lower[b+1], `<=` →
 *   upper[b], `<` → upper[b-1].
 * - EXPECTED_REJECTION_SWEEP_MAX = 300 (planner.ts): the §9.2 bounded sweep's
 *   candidate range, first-hit-wins over the operation's first numeric param.
 *   The sweep produces `expected-rejection` cases in suite.invariantCases with
 *   traces [...violatedInvariants, ...satisfiedPostconditions].
 * - PREDICATE_UNPLANNABLE (planner.ts): a LoaderWarning
 *   { code: "PREDICATE_UNPLANNABLE", field: <clause id>, detail } pushed to
 *   suite.warnings — the generate handler merges suite.warnings into
 *   CliResult.warnings; non-blocking, exit 0. PROPERTY_UNPLANNABLE mirrors
 *   exactly that channel.
 * - Clause metadata at planning time: component invariants +
 *   operation.preconditions/postconditions carry { id, expr } and are parsed
 *   into context.parsedContracts[clause.id] ASTs; param typeRefs live on
 *   operation.params[].type; effects on operation.effects[].field; enum
 *   members via enumMembers(typeRef) (planner.ts, /^enum<(.+)>$/);
 *   manifest fields via context.manifests.manifests[component].fields.
 * - renderClausePredicate(node, ctx) (codegen.ts) renders the oracle arrow
 *   function; ctx.predicates must map every predicateCall name to an import
 *   specifier or the renderer THROWS (unregistered predicate). The planner
 *   must pass a predicates map derived from the registry and catch per-clause
 *   renderer throws as PROPERTY_UNPLANNABLE (Center W5).
 *
 * ── Resolved design ambiguities ────────────────────────────────────────────
 *
 * - The seed literal lives ON the PropertyDescriptor (`seed: number`): the
 *   emitter (Chunk 6) receives the suite, not the config, so the descriptor
 *   must carry what fc.assert(prop, { seed, numRuns }) needs.
 * - Warnings are returned on the PropertyPlan output as LoaderWarning[] (the
 *   PREDICATE_UNPLANNABLE shape) — not thrown, not merged into
 *   suite.warnings (the concrete suite is an input, not an output).
 * - The StrategyMap covers exactly the source clause ids (suite.clauseIds);
 *   the synthetic expected-rejection surface has no source clause id and is
 *   recorded only by the presence/absence of the rejects descriptor.
 * - numRuns is NOT carried on the descriptor — the emitter reads
 *   config.propertyBased.numRuns (default 100) via the Chunk 6 seam.
 * - The multi-param oracle rule (Center B1 fix) counts the codegen'd arrow
 *   function's TOTAL parameters — a manifest-field reference like
 *   `(status, newStatus) => status === newStatus` is still 2 params and
 *   unplannable, because the oracle is embedded as a filter callback that
 *   fast-check invokes with ONE value. `preState` (old(field) resolution)
 *   counts too — but only on accept-side blocks: a rejects descriptor never
 *   embeds its clauses as filters, so its preState-carrying multi-param
 *   oracles are NOT unplannable.
 */

// ── Fixture helpers (mirroring tests/generator.test.ts conventions) ────────

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

/**
 * Parses every fixture expr with the real parser so the context carries real
 * ASTs in parsedContracts (the shape the loader produces, build-spec §6).
 * Throws only on a fixture-authoring error — never a generator behaviour.
 */
function parseAll(contracts: ContractsFile): Record<string, Node> {
	const parsed: Record<string, Node> = {};
	const walk = (clauses: ContractClause[], kind: ClauseKind): void => {
		for (const clause of clauses) {
			const result = parseExpression(clause.expr, kind, clause.id);
			if (!result.ok) {
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

/**
 * Builds a fully-loaded, isValid VersaillesContext in memory (no files, no
 * loader), mirroring the fixture approach in tests/generator.test.ts. All
 * fixture exprs are proven valid contract language by the semantic validator
 * (see the tests/generator-selector.test.ts fixture-grounding convention).
 */
function makeContext(
	contracts: ContractsFile,
	manifests: ManifestsFile = EMPTY_MANIFESTS,
	predicates: PredicatesFile = EMPTY_PREDICATES,
	propertyBased?: WorkspaceConfig["propertyBased"],
): VersaillesContext {
	return {
		config: makeConfig(propertyBased),
		contracts,
		manifests,
		predicates,
		parsedContracts: parseAll(contracts),
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

function planPropertyBlocksFor(
	ctx: VersaillesContext,
): ReturnType<typeof planPropertyBlocks> {
	const suite = planTestCases(ctx);
	return planPropertyBlocks(suite, ctx);
}

function suiteWarnings(suite: PlannedSuite): LoaderWarning[] {
	return (
		(suite as PlannedSuite & { warnings?: LoaderWarning[] }).warnings ?? []
	);
}

/**
 * Asserts the coverage record is total: every source clause id in the
 * concrete suite maps to a strategy on the plan output.
 */
function expectStrategyCoverage(
	ctx: VersaillesContext,
	strategies: StrategyMap,
): void {
	const suite = planTestCases(ctx);
	expect(Object.keys(strategies).sort()).toEqual([...suite.clauseIds].sort());
}

/**
 * Parses a codegen'd clause predicate's callback-parameter list from its
 * byte-pinned `(<params>) => <expr>` form — the SAME parsing the vitest
 * emitter's oracleParamsOf and the planner's B1 gate apply. The B1 fix keys
 * on this count: an oracle with >1 callback params can never be an arbitrary
 * `.filter(...)` (fast-check's filter passes ONE value), so every fixture
 * below verifies its clause's code AND its callback-param count.
 */
function oracleParamsOf(code: string): string[] {
	const arrow = code.indexOf(") => ");
	if (arrow === -1) {
		return [];
	}
	const head = code.slice(1, arrow);
	if (head.trim() === "") {
		return [];
	}
	return head.split(", ").map((param) => param.trim());
}

/** Renders a fixture clause's oracle through the REAL codegen (codegen.ts). */
function renderOracle(ctx: VersaillesContext, clauseId: string): string {
	const ast = ctx.parsedContracts[clauseId];
	if (ast === undefined) {
		throw new Error(`fixture has no parsed AST for ${clauseId}`);
	}
	return renderClausePredicate(ast);
}

// ── Fixture: the flagship compound precondition ─────────────────────────────
// OrderService.placeOrder(x: number) with ONE compound precondition clause.
// The compound classifies as "property" (compound precedence over the
// numeric-bound sub-expressions) and is the flagship accept-side property.
function compoundPbtContext(): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					placeOrder: {
						id: "OrderService.placeOrder",
						params: [{ name: "x", type: "number" }],
						preconditions: [
							{
								id: "OrderService.placeOrder.pre0",
								expr: "x >= 0 and x <= 1000",
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
	return makeContext(contracts, EMPTY_MANIFESTS, EMPTY_PREDICATES, {
		enabled: true,
		numRuns: 100,
	});
}

describe("planPropertyBlocks — flagship compound precondition → property descriptor", () => {
	it("plans ONE satisfies property block whose oracle is the codegen'd compound predicate and whose arbitrary carries the compound's numeric bounds", () => {
		const ctx = compoundPbtContext();
		const { descriptors, strategies, warnings } = planPropertyBlocksFor(ctx);

		expect(warnings).toEqual([]);
		expect(descriptors).toHaveLength(1);
		expect(descriptors[0]).toEqual({
			id: "OrderService.placeOrder.property-satisfies-0",
			component: "OrderService",
			operation: "placeOrder",
			// Integer range from the compound's numeric constraint bounds —
			// the planner must extract bounds from the compound's numeric
			// sub-expressions, not just top-level numeric clauses.
			params: [
				{
					param: "x",
					typeRef: "number",
					kind: "number",
					bounds: { min: 0, max: 1000 },
				},
			],
			// Clause predicates codegen'd into the descriptor (the oracle).
			clauses: [
				{
					clauseId: "OrderService.placeOrder.pre0",
					code: "(x) => x >= 0 && x <= 1000",
				},
			],
			outcome: "satisfies",
			traces: ["OrderService.placeOrder.pre0"],
			// Seed wiring: derived per-block from the covered clause ids +
			// grammar version (no config override).
			seed: derivePropertySeed(["OrderService.placeOrder.pre0"], "1.0"),
		});

		expect(strategies["OrderService.placeOrder.pre0"]).toBe("property");
		expectStrategyCoverage(ctx, strategies);

		// Fixture clause-code verification (Center B1): the flagship oracle is
		// SINGLE-param — `(x) => x >= 0 && x <= 1000` — the planable form. A
		// multi-param oracle would be PROPERTY_UNPLANNABLE; this one stays a
		// runnable property.
		expect(renderOracle(ctx, "OrderService.placeOrder.pre0")).toBe(
			"(x) => x >= 0 && x <= 1000",
		);
		expect(
			oracleParamsOf(renderOracle(ctx, "OrderService.placeOrder.pre0")),
		).toEqual(["x"]);
	});
});

// ── Fixture: top-level `in` clause → example (no property) ──────────────────
function inClauseContext(): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					setStatus: {
						id: "OrderService.setStatus",
						params: [{ name: "newStatus", type: "string" }],
						preconditions: [
							{
								id: "OrderService.setStatus.pre0",
								expr: 'newStatus in ["ACTIVE", "FROZEN"]',
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "setstatus-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, EMPTY_MANIFESTS, EMPTY_PREDICATES, {
		enabled: true,
		numRuns: 100,
	});
}

// ── Fixture: numeric single-bound precondition → example (no property) ──────
function numericSingleBoundContext(): VersaillesContext {
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
							{ id: "OrderService.withdraw.pre0", expr: "amount >= 10" },
						],
						postconditions: [],
						effects: [],
						sourceHash: "withdraw-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, EMPTY_MANIFESTS, EMPTY_PREDICATES, {
		enabled: true,
		numRuns: 100,
	});
}

describe("planPropertyBlocks — strategy gating: example-shaped clauses yield NO property", () => {
	it("a top-level `in` clause plans NO property descriptor — the example (partition) cases stay", () => {
		const ctx = inClauseContext();
		const { descriptors, strategies, warnings } = planPropertyBlocksFor(ctx);

		expect(descriptors).toEqual([]);
		expect(strategies["OrderService.setStatus.pre0"]).toBe("example");
		expect(warnings).toEqual([]);
		expectStrategyCoverage(ctx, strategies);
	});

	it("a numeric single-bound precondition plans NO property descriptor — the example (boundary) cases stay", () => {
		const ctx = numericSingleBoundContext();
		const { descriptors, strategies, warnings } = planPropertyBlocksFor(ctx);

		expect(descriptors).toEqual([]);
		expect(strategies["OrderService.withdraw.pre0"]).toBe("example");
		expect(warnings).toEqual([]);
		expectStrategyCoverage(ctx, strategies);
	});
});

// ── Fixture: predicateCall precondition → property-with-falsifier ───────────
// isPositive is a REGISTERED predicate (verifiedPure), so the codegen'd
// oracle resolves; the strategy keeps the deterministic example falsifier
// (the concrete precondition-violation case) while planning an accept-side
// property.
function predicateCallContext(): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					addItem: {
						id: "OrderService.addItem",
						params: [{ name: "amount", type: "number" }],
						preconditions: [
							{ id: "OrderService.addItem.pre0", expr: "isPositive(amount)" },
						],
						postconditions: [],
						effects: [],
						sourceHash: "additem-hash",
					},
				},
			},
		},
	};
	const predicates: PredicatesFile = {
		version: "1.0",
		predicates: {
			isPositive: {
				params: ["amount"],
				paramTypes: ["number"],
				returnType: "boolean",
				sourceRef: "src/predicates.ts",
				sourceHash: "",
				verifiedPure: true,
			},
		},
	};
	return makeContext(contracts, EMPTY_MANIFESTS, predicates, {
		enabled: true,
		numRuns: 100,
	});
}

describe("planPropertyBlocks — predicateCall precondition → property-with-falsifier (accept side)", () => {
	it("plans an accept-side satisfies property; the strategy stays property-with-falsifier (the example falsifier is retained)", () => {
		const ctx = predicateCallContext();
		const { descriptors, strategies, warnings } = planPropertyBlocksFor(ctx);

		expect(warnings).toEqual([]);
		expect(descriptors).toHaveLength(1);
		expect(descriptors[0]).toEqual({
			id: "OrderService.addItem.property-satisfies-0",
			component: "OrderService",
			operation: "addItem",
			// No numeric bounds for a predicateCall clause — the number
			// arbitrary is unbounded (the oracle filters to positive amounts).
			params: [{ param: "amount", typeRef: "number", kind: "number" }],
			clauses: [
				{
					clauseId: "OrderService.addItem.pre0",
					code: "(amount) => isPositive(amount)",
				},
			],
			outcome: "satisfies",
			traces: ["OrderService.addItem.pre0"],
			seed: derivePropertySeed(["OrderService.addItem.pre0"], "1.0"),
		});

		expect(strategies["OrderService.addItem.pre0"]).toBe(
			"property-with-falsifier",
		);
		expectStrategyCoverage(ctx, strategies);
	});
});

// ── Fixture: every per-param arbitrary kind in one property ─────────────────
// The compound precondition drives the property; the six operation params
// exercise the full ArbitrarySpec mapping (number bounds, string, boolean,
// enum members, list/optional defaults).
function multiParamPbtContext(): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					purchase: {
						id: "OrderService.purchase",
						params: [
							{ name: "sku", type: "string" },
							{ name: "quantity", type: "number" },
							{ name: "vip", type: "boolean" },
							{ name: "tier", type: "enum<GOLD,SILVER>" },
							{ name: "tags", type: "list<string>" },
							{ name: "note", type: "optional<string>" },
						],
						preconditions: [
							{
								id: "OrderService.purchase.pre0",
								expr: 'quantity >= 1 and quantity <= 100 and sku != ""',
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "purchase-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, EMPTY_MANIFESTS, EMPTY_PREDICATES, {
		enabled: true,
		numRuns: 100,
	});
}

// ── Fixture: the SAME six arbitrary kinds under a SINGLE-param compound ─────
// The multi-param variant above is PROPERTY_UNPLANNABLE (2-param oracle), so
// the per-param ArbitrarySpec mapping is pinned here against a single-param
// compound (`quantity >= 1 and quantity <= 100` → `(quantity) => ...`) — the
// planned descriptor still carries ALL SIX operation params, so the mapping
// coverage (number bounds, string, boolean, enum members, list/optional
// defaults) is preserved.
function allKindsSingleParamContext(): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					purchase: {
						id: "OrderService.purchase",
						params: [
							{ name: "sku", type: "string" },
							{ name: "quantity", type: "number" },
							{ name: "vip", type: "boolean" },
							{ name: "tier", type: "enum<GOLD,SILVER>" },
							{ name: "tags", type: "list<string>" },
							{ name: "note", type: "optional<string>" },
						],
						preconditions: [
							{
								id: "OrderService.purchase.pre0",
								expr: "quantity >= 1 and quantity <= 100",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "purchase-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, EMPTY_MANIFESTS, EMPTY_PREDICATES, {
		enabled: true,
		numRuns: 100,
	});
}

describe("planPropertyBlocks — per-param arbitraries from typeRefs + bounds", () => {
	it("maps every operation param to its ArbitrarySpec: integer bounds, string, boolean, enum members, list/optional defaults", () => {
		const ctx = allKindsSingleParamContext();
		const { descriptors, strategies } = planPropertyBlocksFor(ctx);

		expect(descriptors).toHaveLength(1);
		const descriptor = descriptors[0];
		expect(descriptor.params).toEqual([
			{ param: "sku", typeRef: "string", kind: "string" },
			{
				param: "quantity",
				typeRef: "number",
				kind: "number",
				bounds: { min: 1, max: 100 },
			},
			{ param: "vip", typeRef: "boolean", kind: "boolean" },
			{
				param: "tier",
				typeRef: "enum<GOLD,SILVER>",
				kind: "enum",
				members: ["GOLD", "SILVER"],
			},
			{ param: "tags", typeRef: "list<string>", kind: "string", default: [] },
			{
				param: "note",
				typeRef: "optional<string>",
				kind: "string",
				default: "initial",
			},
		]);

		// The oracle only references the clause's own field — codegen'd in
		// first-referenced in-order param order, byte-pinned. The SINGLE-param
		// compound stays planable (multi-param oracles are unplannable).
		expect(descriptor.clauses).toEqual([
			{
				clauseId: "OrderService.purchase.pre0",
				code: "(quantity) => quantity >= 1 && quantity <= 100",
			},
		]);

		// Fixture clause-code verification: this compound omits `sku != ""`, so
		// its oracle is SINGLE-param — the planable form (B1 fix).
		expect(renderOracle(ctx, "OrderService.purchase.pre0")).toBe(
			"(quantity) => quantity >= 1 && quantity <= 100",
		);
		expect(
			oracleParamsOf(renderOracle(ctx, "OrderService.purchase.pre0")),
		).toEqual(["quantity"]);

		expect(strategies["OrderService.purchase.pre0"]).toBe("property");
		expectStrategyCoverage(ctx, strategies);
	});
});

describe("planPropertyBlocks — a multi-param oracle is PROPERTY_UNPLANNABLE (Center B1 fix)", () => {
	it("skips the descriptor whose codegen'd oracle has >1 callback param (quantity, sku) — non-silent warning, strategy stays property", () => {
		const ctx = multiParamPbtContext();
		const { descriptors, strategies, warnings } = planPropertyBlocksFor(ctx);

		// The compound's codegen'd oracle is (quantity, sku) => ... — 2
		// callback params. It cannot be turned into per-param filterable
		// arbitraries (a filter callback receives ONE value), so the planner
		// marks it PROPERTY_UNPLANNABLE: same LoaderWarning channel as
		// PREDICATE_UNPLANNABLE (CliResult.warnings, non-blocking, exit 0).
		// Fixture clause-code verification: the oracle has TWO callback params
		// even though the OPERATION has six params — the B1 rule counts the
		// codegen'd arrow's parameters, not the operation's param count.
		const code = renderOracle(ctx, "OrderService.purchase.pre0");
		expect(code).toBe(
			'(quantity, sku) => quantity >= 1 && quantity <= 100 && sku !== ""',
		);
		expect(oracleParamsOf(code)).toEqual(["quantity", "sku"]);
		const warning = warnings.find(
			(w) => w.field === "OrderService.purchase.pre0",
		);
		expect(warning).toBeDefined();
		expect(warning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);

		// The multi-param clause contributes NO descriptor — never a silent
		// zero, never a broken filter layout.
		expect(descriptors).toEqual([]);
		expect(
			descriptors.some((d) => d.traces.includes("OrderService.purchase.pre0")),
		).toBe(false);

		// The strategy record still documents the compound decision — the
		// SELECTOR chose property; the PLANNER found it unplannable.
		expect(strategies["OrderService.purchase.pre0"]).toBe("property");

		// Coverage gap stays visible: the clause id remains in the suite's
		// clause stream (coverage.json maps it to an empty array — the
		// detectable zero-coverage representation, §9.3).
		const suite = planTestCases(ctx);
		expect(suite.clauseIds).toContain("OrderService.purchase.pre0");
		expectStrategyCoverage(ctx, strategies);
	});
});

// ── Fixture: the full AccountService (invariant + postconditions + sweep) ───
// The concrete fixture from tests/generator.test.ts: withdraw (invariant
// balance >= 0, postconditions post0/post1, effects balance) and setStatus
// (in-clause pre0, bothSideFieldRef post0). Exercises invariant-preservation,
// postcondition strategy mapping, and the expected-rejection sweep
// replacement.
function accountPbtContext(
	propertyBased?: WorkspaceConfig["propertyBased"],
): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
		contracts: {
			AccountService: {
				invariants: [{ id: "AccountService.inv0", expr: "balance >= 0" }],
				operations: {
					withdraw: {
						id: "AccountService.withdraw",
						params: [{ name: "amount", type: "number" }],
						preconditions: [
							{ id: "AccountService.withdraw.pre0", expr: "amount >= 10" },
							{ id: "AccountService.withdraw.pre1", expr: "amount <= 100" },
						],
						postconditions: [
							{
								id: "AccountService.withdraw.post0",
								expr: "old(balance) - amount == balance",
							},
							{
								id: "AccountService.withdraw.post1",
								expr: "old(balance) >= balance",
							},
						],
						effects: [{ field: "balance", kind: "mutate" }],
						sourceHash: "withdraw-hash",
					},
					setStatus: {
						id: "AccountService.setStatus",
						params: [{ name: "newStatus", type: "string" }],
						preconditions: [
							{
								id: "AccountService.setStatus.pre0",
								expr: 'newStatus in ["ACTIVE", "FROZEN"]',
							},
						],
						postconditions: [
							{
								id: "AccountService.setStatus.post0",
								expr: "status == newStatus",
							},
						],
						effects: [{ field: "status", kind: "mutate" }],
						sourceHash: "setstatus-hash",
					},
				},
			},
		},
	};
	const manifests: ManifestsFile = {
		version: "1.0",
		manifests: {
			AccountService: {
				sourceHash: "man-account",
				fields: { balance: "number", status: "string" },
			},
		},
	};
	return makeContext(contracts, manifests, EMPTY_PREDICATES, propertyBased);
}

describe("planPropertyBlocks — invariant-preservation + postcondition strategy mapping", () => {
	it("plans an invariant-preserving property for the effects-overlap invariant; literal postconditions stay example; the bothSideFieldRef postcondition is PROPERTY_UNPLANNABLE (2-param oracle)", () => {
		const ctx = accountPbtContext({ enabled: true, numRuns: 100 });
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		// Effects-overlap invariant (balance is mutated by withdraw) →
		// invariant-preserving property, oracle = the codegen'd invariant.
		// Its oracle (balance) => balance >= 0 is SINGLE-param → planable.
		const invariant = descriptors.find(
			(d) => d.id === "AccountService.withdraw.property-invariant-preserving-0",
		);
		expect(invariant).toBeDefined();
		expect(invariant).toMatchObject({
			component: "AccountService",
			operation: "withdraw",
			outcome: "invariant-preserving",
			params: [
				{
					param: "amount",
					typeRef: "number",
					kind: "number",
					bounds: { min: 10, max: 100 },
				},
			],
			clauses: [
				{ clauseId: "AccountService.inv0", code: "(balance) => balance >= 0" },
			],
			traces: ["AccountService.inv0"],
		});
		expect(invariant?.seed).toBe(
			derivePropertySeed(["AccountService.inv0"], "1.0"),
		);

		// bothSideFieldRef postcondition (status == newStatus) codegen's to a
		// TWO-param oracle (status, newStatus) — a multi-param oracle cannot be
		// turned into per-param filterable arbitraries, so the clause is
		// PROPERTY_UNPLANNABLE (Center B1 fix): the satisfies descriptor is
		// SKIPPED and the warning is non-silent — never a broken filter.
		// Fixture clause-code verification: the manifest-field reference is
		// STILL a 2-param oracle — the B1 rule counts the codegen'd arrow's
		// TOTAL parameters, manifest-field references included.
		const postCode = renderOracle(ctx, "AccountService.setStatus.post0");
		expect(postCode).toBe("(status, newStatus) => status === newStatus");
		expect(oracleParamsOf(postCode)).toEqual(["status", "newStatus"]);

		const post = descriptors.find(
			(d) => d.id === "AccountService.setStatus.property-satisfies-0",
		);
		expect(post).toBeUndefined();

		const warning = warnings.find(
			(w) => w.field === "AccountService.setStatus.post0",
		);
		expect(warning).toBeDefined();
		expect(warning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);

		// The coverage gap stays visible: the unplannable clause id remains in
		// the suite's clause stream (coverage.json maps it to an empty array —
		// the detectable zero-coverage representation, never a silent zero).
		expect(suite.clauseIds).toContain("AccountService.setStatus.post0");

		// Per-clause strategy record — the SELECTOR still maps the
		// bothSideFieldRef shape to "property" (the strategy is a selector
		// decision; the PLANNER finds the clause unplannable). Literal-
		// computable postconditions stay example.
		expect(strategies).toEqual({
			"AccountService.inv0": "property",
			"AccountService.withdraw.pre0": "example",
			"AccountService.withdraw.pre1": "example",
			"AccountService.withdraw.post0": "example",
			"AccountService.withdraw.post1": "example",
			"AccountService.setStatus.pre0": "example",
			"AccountService.setStatus.post0": "property",
		});
		expectStrategyCoverage(ctx, strategies);
	});
});

describe("planPropertyBlocks — expected-rejection sweep replacement (ADR-0017)", () => {
	it("enabled → plans an expected-rejection property and the §9.2 bounded sweep is NOT planned", () => {
		const ctx = accountPbtContext({ enabled: true, numRuns: 100 });
		const { descriptors } = planPropertyBlocksFor(ctx);

		// The rejection property traces the sweep's deterministic first-hit
		// set (violated invariant + satisfied postconditions), carries the
		// configured rejection idiom, and its clauses are the codegen'd
		// oracles of the traced conditions. NOTE the multi-param rule does NOT
		// apply here: a rejects block never embeds its clauses as per-param
		// filters (the emitter renders NO oracle consts and NO filter for a
		// rejects block), so the preState-carrying multi-param oracles below
		// are harmless and the property stays runnable.
		const rejection = descriptors.find(
			(d) => d.id === "AccountService.withdraw.property-rejects-0",
		);
		expect(rejection).toBeDefined();
		expect(rejection).toMatchObject({
			component: "AccountService",
			operation: "withdraw",
			outcome: "rejects",
			rejectionIdiom: "throws",
			traces: [
				"AccountService.inv0",
				"AccountService.withdraw.post0",
				"AccountService.withdraw.post1",
			],
		});
		expect(rejection?.params).toEqual([
			{
				param: "amount",
				typeRef: "number",
				kind: "number",
				bounds: { min: 10, max: 100 },
			},
		]);
		expect(rejection?.clauses).toEqual([
			{ clauseId: "AccountService.inv0", code: "(balance) => balance >= 0" },
			{
				clauseId: "AccountService.withdraw.post0",
				code: "(amount, balance, preState) => preState.balance - amount === balance",
			},
			{
				clauseId: "AccountService.withdraw.post1",
				code: "(balance, preState) => preState.balance >= balance",
			},
		]);
		expect(rejection?.seed).toBe(
			derivePropertySeed(
				[
					"AccountService.inv0",
					"AccountService.withdraw.post0",
					"AccountService.withdraw.post1",
				],
				"1.0",
			),
		);

		// The bounded sweep is REPLACED: the concrete suite must not carry an
		// expected-rejection sweep case when PBT is enabled.
		const suite = planTestCases(ctx);
		expect(
			suite.invariantCases.filter(
				(case_) => case_.kind === "expected-rejection",
			),
		).toEqual([]);
	});

	it("disabled → no rejection property and the §9.2 bounded sweep remains (non-PBT fallback)", () => {
		const ctx = accountPbtContext();
		const { descriptors } = planPropertyBlocksFor(ctx);

		// PBT is off: NO property blocks at all — the v1 concrete output is
		// the whole suite (backward-compat pin, ADR-0017).
		expect(descriptors).toEqual([]);

		// The sweep is the fallback: the concrete suite still carries the
		// expected-rejection case.
		const suite = planTestCases(ctx);
		const sweep = suite.invariantCases.filter(
			(case_) => case_.kind === "expected-rejection",
		);
		expect(sweep.length).toBeGreaterThan(0);
		expect(sweep[0].id).toMatch(
			/^AccountService\.withdraw\.expected-rejection-\d+$/,
		);
	});
});

// ── Fixture: explicit seed override ─────────────────────────────────────────
function seedOverrideContext(): VersaillesContext {
	const ctx = compoundPbtContext();
	const config = ctx.config;
	if (config === null) {
		throw new Error("test precondition: config fixture must be present");
	}
	config.propertyBased = { enabled: true, numRuns: 100, seed: 12345 };
	return ctx;
}

describe("planPropertyBlocks — seed wiring (ADR-0017)", () => {
	it("derives the seed per-block from the covered clause ids + grammar version when no override is set", () => {
		const ctx = compoundPbtContext();
		const { descriptors } = planPropertyBlocksFor(ctx);

		const descriptor = descriptors[0];
		const derived = derivePropertySeed(descriptor.traces, "1.0");
		expect(descriptor.seed).toBe(derived);
		// The seed is a SIGNED 32-bit int (fast-check's `seed | 0` round-trip).
		expect(Number.isInteger(descriptor.seed)).toBe(true);
		expect(descriptor.seed).toBeGreaterThanOrEqual(-2147483648);
		expect(descriptor.seed).toBeLessThanOrEqual(2147483647);
	});

	it("an explicit config.propertyBased.seed override WINS over the derived seed", () => {
		const ctx = seedOverrideContext();
		const { descriptors } = planPropertyBlocksFor(ctx);

		const descriptor = descriptors[0];
		expect(descriptor.seed).toBe(12345);
		expect(descriptor.seed).not.toBe(
			derivePropertySeed(descriptor.traces, "1.0"),
		);
	});

	it("distinct property blocks in a suite carry distinct derived seed literals", () => {
		const ctx = accountPbtContext({ enabled: true, numRuns: 100 });
		const { descriptors } = planPropertyBlocksFor(ctx);

		const seeds = new Set(descriptors.map((descriptor) => descriptor.seed));
		expect(seeds.size).toBe(descriptors.length);
	});
});

// ── Fixture: unplannable compound (component-typed param + multi-param) ─────
// `amount >= 0 and account != null` is a valid compound precondition, but
// `account` is component-typed — no ArbitrarySpec kind exists for component
// types, so the clause's valid region cannot be turned into filterable
// arbitraries. (The codegen'd oracle `(amount, account) => ...` is ALSO a
// multi-param oracle — either failure is PROPERTY_UNPLANNABLE; this fixture
// pins the component-typed-param channel.) Semantically valid (see the
// selector-test fixture grounding: both exprs validate cleanly), yet
// unplannable for PBT.
function unplannableCompoundContext(): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
		contracts: {
			OrderService: {
				invariants: [],
				operations: {
					placeOrder: {
						id: "OrderService.placeOrder",
						params: [
							{ name: "amount", type: "number" },
							{ name: "account", type: "component<Account>" },
						],
						preconditions: [
							{
								id: "OrderService.placeOrder.pre0",
								expr: "amount >= 0 and account != null",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "placeorder-unplannable-hash",
					},
				},
			},
		},
	};
	return makeContext(contracts, EMPTY_MANIFESTS, EMPTY_PREDICATES, {
		enabled: true,
		numRuns: 100,
	});
}

describe("planPropertyBlocks — unplannable clause: non-silent warning, skipped descriptor, visible coverage gap", () => {
	it("surfaces a PROPERTY_UNPLANNABLE warning (the PREDICATE_UNPLANNABLE tier), skips the descriptor, and keeps the clause in the coverage stream — never silent", () => {
		const ctx = unplannableCompoundContext();
		const { descriptors, strategies, warnings } = planPropertyBlocksFor(ctx);

		// Same LoaderWarning channel as PREDICATE_UNPLANNABLE — the generate
		// handler merges these into CliResult.warnings (non-blocking, exit 0).
		const warning = warnings.find(
			(w) => w.field === "OrderService.placeOrder.pre0",
		);
		expect(warning).toBeDefined();
		expect(warning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);

		// The unplannable clause contributes NO descriptor — a silent zero is
		// forbidden.
		expect(descriptors).toEqual([]);
		expect(
			descriptors.some((d) =>
				d.traces.includes("OrderService.placeOrder.pre0"),
			),
		).toBe(false);

		// The strategy record still documents the compound decision — the
		// warning sits on top of a recorded strategy, never a hidden gap.
		expect(strategies["OrderService.placeOrder.pre0"]).toBe("property");

		// Coverage gap stays visible: the clause id remains in the suite's
		// clause stream (coverage.json maps it to an empty array — the
		// detectable zero-coverage representation, §9.3).
		const suite = planTestCases(ctx);
		expect(suite.clauseIds).toContain("OrderService.placeOrder.pre0");
		expectStrategyCoverage(ctx, strategies);
	});
});

// ── Determinism (ADR-0002 / ADR-0017) ───────────────────────────────────────

describe("planPropertyBlocks — determinism (ADR-0002, re-scoped by ADR-0017)", () => {
	it("same suite + context → identical descriptors, strategies, and warnings across repeated calls", () => {
		const ctx = accountPbtContext({ enabled: true, numRuns: 100 });
		const suite = planTestCases(ctx);

		const first = planPropertyBlocks(suite, ctx);
		const second = planPropertyBlocks(suite, ctx);
		expect(second).toEqual(first);
		expect(second.descriptors).toEqual(first.descriptors);
		expect(second.strategies).toEqual(first.strategies);
		expect(second.warnings).toEqual(first.warnings);
	});

	it("re-planned suites (fresh planTestCases) produce identical plans — generation stays a pure function of the context", () => {
		const ctx = compoundPbtContext();
		const a = planPropertyBlocks(planTestCases(ctx), ctx);
		const b = planPropertyBlocks(planTestCases(ctx), ctx);
		expect(b.descriptors).toEqual(a.descriptors);
		expect(b.strategies).toEqual(a.strategies);
	});
});

// ── Generation gate (contract invariant 1) ──────────────────────────────────

describe("planPropertyBlocks — generation gate (contract invariant 1)", () => {
	it("throws (never plans) when context.isValid is false — mirroring planTestCases", () => {
		const ctx = compoundPbtContext();
		const invalid: VersaillesContext = {
			...ctx,
			parseErrors: [
				{
					contractId: "OrderService.placeOrder.pre0",
					field: "preconditions[0]",
					position: 0,
					found: "",
					expected: ["term"],
					message: "broken",
				} as never,
			],
			isValid: false,
		};
		const suite = planTestCases(compoundPbtContext());
		expect(() => planPropertyBlocks(suite, invalid)).toThrow();
	});
});

// ── Enabled gate (ADR-0017 backward-compat pin) ─────────────────────────────

describe("planPropertyBlocks — enabled gate: property blocks are never planned when disabled", () => {
	it("returns an empty descriptors array when config.propertyBased is absent (v1 default)", () => {
		const ctx = accountPbtContext();
		const { descriptors, warnings } = planPropertyBlocksFor(ctx);
		expect(descriptors).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("returns an empty descriptors array when config.propertyBased.enabled is false", () => {
		const ctx = accountPbtContext({ enabled: false, numRuns: 100 });
		const { descriptors } = planPropertyBlocksFor(ctx);
		expect(descriptors).toEqual([]);
	});

	it("still records the per-clause strategy coverage map when disabled (pbtEnabled: false semantics)", () => {
		const ctx = accountPbtContext();
		const { strategies } = planPropertyBlocksFor(ctx);
		expect(strategies["AccountService.withdraw.pre0"]).toBe("example");
		expectStrategyCoverage(ctx, strategies);
	});
});

// ── PBT IR type-shape pins (ADR-0017) ───────────────────────────────────────
// These force the extended IR types to EXIST under a type-check and pin the
// fields the planner produces. PropertyPlan is the new planning-output shape;
// seed is the new PropertyDescriptor field; default is the new ArbitrarySpec
// field for list/optional params.

describe("PBT IR — type-shape pins added by the planner chunk", () => {
	it("PropertyPlan is the planning output: { descriptors, strategies, warnings }", () => {
		const plan = {
			descriptors: [],
			strategies: {},
			warnings: [],
		} satisfies PropertyPlan;
		expect(plan.descriptors).toEqual([]);
		expect(plan.strategies).toEqual({});
		expect(plan.warnings).toEqual([]);
	});

	it("PropertyDescriptor carries the seed literal the emitter needs (seed: number)", () => {
		const descriptor = {
			id: "OrderService.placeOrder.property-satisfies-0",
			component: "OrderService",
			operation: "placeOrder",
			params: [{ param: "x", typeRef: "number", kind: "number" }],
			clauses: [
				{ clauseId: "OrderService.placeOrder.pre0", code: "(x) => x >= 0" },
			],
			outcome: "satisfies",
			traces: ["OrderService.placeOrder.pre0"],
			seed: 225963075,
		} satisfies PropertyDescriptor;
		expect(descriptor.seed).toBe(225963075);
		expect(Number.isInteger(descriptor.seed)).toBe(true);
	});

	it("PropertyOutcome admits the three planned outcomes", () => {
		const outcomes: PropertyOutcome[] = [
			"satisfies",
			"rejects",
			"invariant-preserving",
		];
		expect(outcomes).toHaveLength(3);
	});

	it("ArbitrarySpec carries the deterministic default for list/optional params", () => {
		const list: ArbitrarySpec = {
			param: "tags",
			typeRef: "list<string>",
			kind: "string",
			default: [],
		};
		const optional: ArbitrarySpec = {
			param: "note",
			typeRef: "optional<string>",
			kind: "string",
			default: "initial",
		};
		expect(list.default).toEqual([]);
		expect(optional.default).toBe("initial");
	});
});

// ── Empty strategy gap guard ────────────────────────────────────────────────

describe("planPropertyBlocks — strategy coverage is total over the source clauses", () => {
	it("every source clause id maps to a strategy for the flagship fixture — no empty gap", () => {
		const ctx = compoundPbtContext();
		const suite = planTestCases(ctx);
		const { strategies } = planPropertyBlocks(suite, ctx);

		for (const clauseId of suite.clauseIds) {
			const strategy = strategies[clauseId];
			expect(strategy).toBeDefined();
			expect(["example", "property", "property-with-falsifier"]).toContain(
				strategy,
			);
		}
		expect(Object.keys(strategies).length).toBe(suite.clauseIds.length);
	});

	it("every source clause id maps to a strategy for the full AccountService fixture", () => {
		const ctx = accountPbtContext({ enabled: true, numRuns: 100 });
		const suite = planTestCases(ctx);
		const { strategies } = planPropertyBlocks(suite, ctx);

		expect(Object.keys(strategies).sort()).toEqual([...suite.clauseIds].sort());
		for (const clauseId of suite.clauseIds) {
			expect(strategies[clauseId]).toBeDefined();
		}
	});
});
