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
 *    "1.0"). ADR-0018 removed context.config.grammarVersion from
 *    WorkspaceConfig; the planner pins the constant `"1.0"` (planner.ts:
 *    "ADR-0018: the config grammarVersion field is removed; pin \"1.0\" so
 *    the PBT seed derivation input stays byte-identical (ADR-0002)") so the
 *    derivation input stays byte-identical. Per-block, over the block's OWN
 *    covered clause ids — the contract's "distinct property blocks carry
 *    distinct seed literals (derived per-block from the covered clause IDs +
 *    grammar version, or the explicit config override)". The override wins;
 *    the derived seed stays an int32 (fast-check's `seed | 0` round-trip).
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
 * 10. MULTI-PARAM ORACLES route to JOINT SAMPLING (VERSAILLES-165,
 *    superseding the Center B1 oracle-arity gate): a guard oracle with more
 *    than one callback parameter is NEVER emitted as a per-param `.filter`
 *    (fast-check's filter invokes its callback with ONE value, so a per-param
 *    filter over a multi-param oracle would reference an unbound sibling
 *    parameter at runtime — broken, vacuous filters, the B1 bug). Instead the
 *    planner CLASSIFIES the guard oracle's AST and routes it to a
 *    joint-sampling strategy:
 *    - Equality-mirror — a bothSideFieldRef equality `p1 == p2` / `p1 === p2`
 *      with BOTH operands operation params (e.g. `a == b` → `(a, b) => a ===
 *      b`): the planner generates the SOURCE (p1, the left operand) from its
 *      arbitrary and mirrors the value to the TARGET (p2, the right operand) —
 *      the emitted callback contains `const p2 = p1;`. No filter is needed
 *      (the mirror guarantees the oracle), so filter sparsity is zero. The
 *      TARGET's ArbitrarySpec carries `mirrorOf: "<source param>"` and has NO
 *      independent arbitrary; the SOURCE's spec has no mirrorOf and precedes
 *      the target's in descriptor.params. Center B1: the mirror is ONLY for
 *      the param-param subset — a manifest-FIELD operand is never mirrored
 *      (the field is instance state, never a sampled arbitrary).
 *    - FIELD-BOUND equality — a bothSideFieldRef equality `p1 == p2` where at
 *      least ONE operand is a manifest FIELD (e.g. `status == newStatus` with
 *      `status` a component field): PLANNED (never PROPERTY_UNPLANNABLE) with
 *      OP-PARAMS ONLY in descriptor.params — no field source spec, no mirrorOf
 *      (Center B1). The emitter renders the field-bound layout: sample only
 *      the op-param arbitraries, bind the component instance, call with the
 *      params only, and assert the oracle with the field mapped to
 *      `instance.<field>` after the call — a genuine post-state check.
 *    - Record + bounded filter — a conjunction of numeric comparisons and
 *      sum/difference couplings over multiple params (e.g. `a >= 0 and b >= 0
 *      and a + b <= 100` → `(a, b) => a >= 0 && b >= 0 && a + b <= 100`): the
 *      planner derives per-param bounds INCLUDING cross-param propagation from
 *      sum/difference leaves BEFORE any filter (`p1 + p2 <= C` with lower
 *      bounds L1, L2 → `p1 <= C - L2`, `p2 <= C - L1`; mirrored for `>=`/`>`
 *      with upper bounds; `p1 - p2 <= C` with U2, L1 → `p1 <= C + U2`,
 *      `p2 >= L1 - C`) so the sampled joint region is bounded first and the
 *      valid region stays healthy (~>=50%) — never filter-sparse, never a
 *      hang. The descriptor's ArbitrarySpecs carry the derived bounds. Strict
 *      ops follow the numericConstraintBounds convention (`< C` → C−1,
 *      `> C` → C+1). Center W4: an `or`-clause's bounds are NEVER collected
 *      (a disjunct does not imply either side holds), so a sibling coupling
 *      can only rely on sound `and`-chain bounds.
 *    A multi-param oracle that matches NONE of the joint strategies —
 *    non-mirrorable equality (`!=`/`!==`), equality-of-sums (`a + b == C`), an
 *    unboundable coupling (no derivable cross-param bounds), a coupling whose
 *    propagation yields INVERTED bounds (min > max — an unsatisfiable region,
 *    Center W1), a coupling referencing a manifest-FIELD operand (Center B2),
 *    an unrenderable oracle, or a component-typed param — stays
 *    PROPERTY_UNPLANNABLE: the same non-silent LoaderWarning { code:
 *    "PROPERTY_UNPLANNABLE", field: <clause id>, detail: non-empty }, the
 *    descriptor is SKIPPED, and the strategy record keeps "property" (the
 *    SELECTOR still chooses property for the resolved shape; the PLANNER finds
 *    it unplannable). Single-param oracles stay runnable per-param-filter
 *    properties. The oracle's parameter count is read from the byte-pinned
 *    `(<params>) => <expr>` codegen output (split at the first `) => `, params
 *    on ", " — the same parsing the vitest emitter's oracleParamsOf uses).
 *    SCOPE — the rejects (expected-rejection) descriptor is NOT subject to
 *    the joint-sampling routing: its clauses are never embedded as filters
 *    (the emitter renders NO oracle consts and NO filter for a rejects
 *    block), so a preState-carrying multi-param oracle there is harmless and
 *    the property stays runnable. The routing applies ONLY to the accept-side
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
 * - Multi-param oracles are ROUTED (VERSAILLES-165), not blanket-unplannable:
 *   the planner classifies the guard oracle's AST — a bothSideFieldRef
 *   equality (`==`/`===`) routes to the equality-mirror strategy when BOTH
 *   operands are operation params (the mirror TARGET's spec carries
 *   `mirrorOf: "<source>"`; the source's spec has no mirrorOf and precedes
 *   it), a bothSideFieldRef equality with a manifest-FIELD operand routes to
 *   the FIELD-BOUND layout (Center B1 — op-params only in descriptor.params,
 *   no mirrorOf, no field source spec; the emitter maps the field to
 *   `instance.<field>`), a conjunction of numeric comparisons + sum/difference
 *   couplings routes to record + bounded filter (cross-param bounds derived
 *   BEFORE any filter), and anything else — `!=`/`!==`, equality-of-sums,
 *   unboundable couplings, couplings that reference a manifest-FIELD operand
 *   (Center B2), couplings whose propagation yields inverted bounds (Center
 *   W1), unrenderable oracles, component-typed params — stays
 *   PROPERTY_UNPLANNABLE. `preState` (old(field) resolution) is never
 *   mirror-able or record-samplable — but only accept-side blocks route at
 *   all: a rejects descriptor never embeds its clauses as filters, so its
 *   preState-carrying multi-param oracles are NOT unplannable.
 */

// ── Fixture helpers (mirroring tests/generator.test.ts conventions) ────────

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
		predicates: {
			isPositive: {
				params: ["amount"],
				paramTypes: ["number"],
				returnType: "boolean",
				sourceRef: "src/predicates.ts",
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
// The per-param ArbitrarySpec mapping is pinned here against a single-param
// compound (`quantity >= 1 and quantity <= 100` → `(quantity) => ...`) — the
// planned descriptor still carries ALL SIX operation params, so the mapping
// coverage (number bounds, string, boolean, enum members, list/optional
// defaults) is preserved. (The multi-param sibling `multiParamPbtContext`
// — `quantity >= 1 and quantity <= 100 and sku != ""` → `(quantity, sku) =>
// ...` — is itself PLANNED under VERSAILLES-165 via record + bounded filter;
// this fixture pins the SINGLE-param per-arbitrary mapping in isolation.)
function allKindsSingleParamContext(): VersaillesContext {
	const contracts: ContractsFile = {
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
		// compound stays planable (per-param filter form).
		expect(descriptor.clauses).toEqual([
			{
				clauseId: "OrderService.purchase.pre0",
				code: "(quantity) => quantity >= 1 && quantity <= 100",
			},
		]);

		// Fixture clause-code verification: this compound omits `sku != ""`, so
		// its oracle is SINGLE-param — the per-param-filter form.
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

describe("planPropertyBlocks — the 2-param compound routes to record + bounded filter (VERSAILLES-165)", () => {
	it("plans the 2-param compound as a satisfies descriptor — quantity bounded { min: 1, max: 100 }, sku an unbounded string, no warning, no mirrorOf", () => {
		const ctx = multiParamPbtContext();
		const { descriptors, strategies, warnings } = planPropertyBlocksFor(ctx);

		// Fixture clause-code verification: the compound's codegen'd oracle is
		// `(quantity, sku) => ...` — 2 callback params even though the
		// OPERATION has six params — the routing counts the codegen'd arrow's
		// parameters, not the operation's param count.
		const code = renderOracle(ctx, "OrderService.purchase.pre0");
		expect(code).toBe(
			'(quantity, sku) => quantity >= 1 && quantity <= 100 && sku !== ""',
		);
		expect(oracleParamsOf(code)).toEqual(["quantity", "sku"]);

		// The 2-param oracle is NOT blanket-unplannable (VERSAILLES-165): it
		// routes to record + bounded filter — the conjunction of numeric
		// comparisons (`quantity >= 1` / `quantity <= 100`, bounds derivable)
		// and a string inequality (`sku != ""`, unbounded string, filterable).
		// NO PROPERTY_UNPLANNABLE warning, the descriptor IS planned.
		expect(warnings).toEqual([]);
		expect(descriptors).toHaveLength(1);
		expect(descriptors[0]).toEqual({
			id: "OrderService.purchase.property-satisfies-0",
			component: "OrderService",
			operation: "purchase",
			params: [
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
			],
			clauses: [
				{
					clauseId: "OrderService.purchase.pre0",
					code: '(quantity, sku) => quantity >= 1 && quantity <= 100 && sku !== ""',
				},
			],
			outcome: "satisfies",
			traces: ["OrderService.purchase.pre0"],
			seed: derivePropertySeed(["OrderService.purchase.pre0"], "1.0"),
		});

		// The strategy record still documents the compound decision — the
		// SELECTOR chose property; the PLANNER now plans it.
		expect(strategies["OrderService.purchase.pre0"]).toBe("property");

		// No mirrorOf on any spec — this is the record + bounded filter
		// strategy, NOT the equality-mirror.
		expect(
			descriptors[0].params.some((spec) => spec.mirrorOf !== undefined),
		).toBe(false);

		// The clause id stays in the suite's clause stream — mapped to the
		// planned descriptor, never a silent zero.
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
	it("plans an invariant-preserving property for the effects-overlap invariant; literal postconditions stay example; the bothSideFieldRef equality postcondition with a manifest-FIELD operand is PLANNED via the FIELD-BOUND layout (Center B1, VERSAILLES-165)", () => {
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

		// bothSideFieldRef equality postcondition (status == newStatus)
		// codegen's to a TWO-param oracle (status, newStatus). Center B1: the
		// left operand `status` is a MANIFEST FIELD (the manifest declares
		// fields { balance, status } — it is NOT an operation param; the only
		// setStatus param is newStatus). A field operand has no arbitrary to
		// sample from, so this equality is NOT mirror-able — it routes to the
		// FIELD-BOUND layout instead: descriptor.params carries OP-PARAMS ONLY
		// ([newStatus], NO field source spec, NO mirrorOf) and the emitter maps
		// the field to `instance.status` after the call (a genuine post-state
		// check). The mirror strategy is reserved for param-param equalities.
		// Fixture clause-code verification: the manifest-field reference is
		// STILL a 2-param oracle — the oracle params count both callback
		// params, manifest-field references included.
		const postCode = renderOracle(ctx, "AccountService.setStatus.post0");
		expect(postCode).toBe("(status, newStatus) => status === newStatus");
		expect(oracleParamsOf(postCode)).toEqual(["status", "newStatus"]);

		const post = descriptors.find(
			(d) => d.id === "AccountService.setStatus.property-satisfies-0",
		);
		expect(post).toBeDefined();
		expect(post).toEqual({
			id: "AccountService.setStatus.property-satisfies-0",
			component: "AccountService",
			operation: "setStatus",
			params: [
				// OP-PARAMS ONLY — the manifest-field operand `status` is never
				// a sampled spec, and no mirrorOf is wired (Center B1).
				{ param: "newStatus", typeRef: "string", kind: "string" },
			],
			clauses: [
				{
					clauseId: "AccountService.setStatus.post0",
					code: "(status, newStatus) => status === newStatus",
				},
			],
			outcome: "satisfies",
			traces: ["AccountService.setStatus.post0"],
			seed: derivePropertySeed(["AccountService.setStatus.post0"], "1.0"),
		});

		// The field-bound clause carries NO PROPERTY_UNPLANNABLE warning.
		const warning = warnings.find(
			(w) => w.field === "AccountService.setStatus.post0",
		);
		expect(warning).toBeUndefined();

		// The clause id stays in the suite's clause stream — mapped to the
		// planned field-bound descriptor, not a zero-coverage gap.
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

// ── Fixture: param-param equality — the mirror strategy's ONLY domain ────────
// Center B1 keeps the equality-mirror for the param-param subset: a
// bothSideFieldRef equality where BOTH operands are operation params (the
// accountPbtContext setStatus fixture above has `status` as a MANIFEST FIELD,
// so it routes to the FIELD-BOUND layout). This fixture pins the mirror with
// both operands as op params: `oldName == newName` on rename(oldName, newName).
function paramParamEqualityContext(
	propertyBased?: WorkspaceConfig["propertyBased"],
): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			AccountService: {
				invariants: [],
				operations: {
					rename: {
						id: "AccountService.rename",
						params: [
							{ name: "oldName", type: "string" },
							{ name: "newName", type: "string" },
						],
						preconditions: [],
						postconditions: [
							{
								id: "AccountService.rename.post0",
								expr: "oldName == newName",
							},
						],
						effects: [],
						sourceHash: "rename-hash",
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

describe("planPropertyBlocks — param-param equality stays a true mirror (Center B1, VERSAILLES-165)", () => {
	it("a bothSideFieldRef equality with BOTH operands op params is PLANNED via the equality-mirror — source spec first, target carries mirrorOf, no warning", () => {
		const ctx = paramParamEqualityContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		// Fixture clause-code verification: `oldName == newName` codegen's to a
		// TWO-param oracle — both params are operation params here.
		const code = renderOracle(ctx, "AccountService.rename.post0");
		expect(code).toBe("(oldName, newName) => oldName === newName");
		expect(oracleParamsOf(code)).toEqual(["oldName", "newName"]);

		// The mirror IS planned: the SOURCE (oldName, the left operand) is
		// sampled from its own arbitrary; the TARGET (newName, the right
		// operand) mirrors it (`const newName = oldName;`). The target's
		// ArbitrarySpec carries mirrorOf: "oldName" and NO independent
		// arbitrary; the source's spec has no mirrorOf and precedes it.
		const post = descriptors.find(
			(d) => d.id === "AccountService.rename.property-satisfies-0",
		);
		expect(post).toBeDefined();
		expect(post).toEqual({
			id: "AccountService.rename.property-satisfies-0",
			component: "AccountService",
			operation: "rename",
			params: [
				{ param: "oldName", typeRef: "string", kind: "string" },
				{
					param: "newName",
					typeRef: "string",
					kind: "string",
					mirrorOf: "oldName",
				},
			],
			clauses: [
				{
					clauseId: "AccountService.rename.post0",
					code: "(oldName, newName) => oldName === newName",
				},
			],
			outcome: "satisfies",
			traces: ["AccountService.rename.post0"],
			seed: derivePropertySeed(["AccountService.rename.post0"], "1.0"),
		});

		// The mirror-planned clause carries NO PROPERTY_UNPLANNABLE warning.
		const warning = warnings.find(
			(w) => w.field === "AccountService.rename.post0",
		);
		expect(warning).toBeUndefined();

		// The SELECTOR maps the bothSideFieldRef shape to property.
		expect(strategies["AccountService.rename.post0"]).toBe("property");
		expect(suite.clauseIds).toContain("AccountService.rename.post0");
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

// ── Fixture: retained unplannable — component-typed param ───────────────────
// `amount >= 0 and account != null` is a valid compound precondition, but
// `account` is component-typed — no ArbitrarySpec kind exists for component
// types, so the clause's valid region cannot be turned into filterable
// arbitraries. Under VERSAILLES-165 a component-typed param remains
// PROPERTY_UNPLANNABLE (the first gate — param representability — fails
// before any joint-sampling routing). Semantically valid (see the
// selector-test fixture grounding: both exprs validate cleanly), yet
// unplannable for PBT.
function unplannableCompoundContext(): VersaillesContext {
	const contracts: ContractsFile = {
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

// ── Fixture: retained unplannable — non-mirrorable inequality (`!=`) ────────
// `status != newStatus` is a bothSideFieldRef equality-FAMILY clause whose op
// is `!=`. The equality-mirror strategy only holds for `==`/`===` (mirroring
// the value would make the equality hold, which is the OPPOSITE of what `!=`
// asserts); `!=`/`!==` is NOT mirror-able, and it is not a numeric coupling —
// so the clause stays PROPERTY_UNPLANNABLE (VERSAILLES-165).
function nonMirrorableInequalityContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			AccountService: {
				invariants: [],
				operations: {
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
								expr: "status != newStatus",
							},
						],
						effects: [{ field: "status", kind: "mutate" }],
						sourceHash: "setstatus-ne-hash",
					},
				},
			},
		},
	};
	const manifests: ManifestsFile = {
		manifests: {
			AccountService: {
				sourceHash: "man-account-ne",
				fields: { status: "string" },
			},
		},
	};
	return makeContext(contracts, manifests, EMPTY_PREDICATES, {
		enabled: true,
		numRuns: 100,
	});
}

// ── Fixture: retained unplannable — equality-of-sums (`a + b == C`) ─────────
// `a + b == 100` is a compare whose left side is an arithmetic SUM and whose
// op is `==`. It is NOT a fieldRef-vs-fieldRef equality (so no mirror), and an
// equality is a thin hyperslice of the joint space, not a bounded region a
// record + filter can keep healthy — so the clause stays PROPERTY_UNPLANNABLE
// (VERSAILLES-165).
function equalityOfSumsContext(): VersaillesContext {
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
								id: "OrderService.placeOrder.pre0",
								expr: "a + b == 100",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "equality-of-sums-hash",
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

// ── Fixture: retained unplannable — unboundable coupling ────────────────────
// `a + b <= 100` with NO lower bounds on a/b anywhere in the operation's
// preconditions: the sum-leaf propagation `p1 <= C - L2` / `p2 <= C - L1`
// needs L1/L2, and with unbounded lower bounds it cannot derive them — the
// coupling is unboundable, so the clause stays PROPERTY_UNPLANNABLE
// (VERSAILLES-165). Contrast the split fixture in
// generator-compound-coverage.test.ts, where sibling clauses (`a >= 0`,
// `b >= 0`) DO provide the lower bounds and the same leaf is planned.
function unboundableCouplingContext(): VersaillesContext {
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
								id: "OrderService.placeOrder.pre0",
								expr: "a + b <= 100",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "unboundable-coupling-hash",
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

describe("planPropertyBlocks — retained unplannable shapes (VERSAILLES-165)", () => {
	it("a non-mirrorable bothSideFieldRef inequality (status != newStatus) stays PROPERTY_UNPLANNABLE — descriptor absent, warning present, strategy stays property", () => {
		const ctx = nonMirrorableInequalityContext();
		const { descriptors, strategies, warnings } = planPropertyBlocksFor(ctx);

		// Fixture clause-code verification: `status != newStatus` codegen's to
		// a TWO-param oracle — but `!=` is not mirror-able (mirroring would
		// assert the opposite), so it stays unplannable.
		const code = renderOracle(ctx, "AccountService.setStatus.post0");
		expect(code).toBe("(status, newStatus) => status !== newStatus");
		expect(oracleParamsOf(code)).toEqual(["status", "newStatus"]);

		const warning = warnings.find(
			(w) => w.field === "AccountService.setStatus.post0",
		);
		expect(warning).toBeDefined();
		expect(warning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);

		expect(
			descriptors.some((d) =>
				d.traces.includes("AccountService.setStatus.post0"),
			),
		).toBe(false);

		// The SELECTOR still records property (bothSideFieldRef shape); the
		// PLANNER finds the non-mirrorable inequality unplannable.
		expect(strategies["AccountService.setStatus.post0"]).toBe("property");

		// Coverage gap stays visible.
		const suite = planTestCases(ctx);
		expect(suite.clauseIds).toContain("AccountService.setStatus.post0");
		expectStrategyCoverage(ctx, strategies);
	});

	it("an equality-of-sums clause (a + b == 100) stays PROPERTY_UNPLANNABLE — descriptor absent, warning present, strategy stays property", () => {
		const ctx = equalityOfSumsContext();
		const { descriptors, strategies, warnings } = planPropertyBlocksFor(ctx);

		// Fixture clause-code verification: `a + b == 100` codegen's to a
		// TWO-param oracle `(a, b) => a + b === 100` — a sum compared by
		// equality, not a fieldRef-vs-fieldRef equality and not a boundable
		// coupling.
		const code = renderOracle(ctx, "OrderService.placeOrder.pre0");
		expect(code).toBe("(a, b) => a + b === 100");
		expect(oracleParamsOf(code)).toEqual(["a", "b"]);

		const warning = warnings.find(
			(w) => w.field === "OrderService.placeOrder.pre0",
		);
		expect(warning).toBeDefined();
		expect(warning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);

		expect(
			descriptors.some((d) =>
				d.traces.includes("OrderService.placeOrder.pre0"),
			),
		).toBe(false);

		expect(strategies["OrderService.placeOrder.pre0"]).toBe("property");

		const suite = planTestCases(ctx);
		expect(suite.clauseIds).toContain("OrderService.placeOrder.pre0");
		expectStrategyCoverage(ctx, strategies);
	});

	it("an unboundable coupling (a + b <= 100 with no lower bounds on a/b) stays PROPERTY_UNPLANNABLE — descriptor absent, warning present, strategy stays property", () => {
		const ctx = unboundableCouplingContext();
		const { descriptors, strategies, warnings } = planPropertyBlocksFor(ctx);

		// Fixture clause-code verification: `a + b <= 100` codegen's to a
		// TWO-param oracle — the sum leaf CANNOT propagate upper bounds
		// (a <= 100 - L_b needs L_b, which is unbounded), so the coupling is
		// unboundable and the clause stays unplannable.
		const code = renderOracle(ctx, "OrderService.placeOrder.pre0");
		expect(code).toBe("(a, b) => a + b <= 100");
		expect(oracleParamsOf(code)).toEqual(["a", "b"]);

		const warning = warnings.find(
			(w) => w.field === "OrderService.placeOrder.pre0",
		);
		expect(warning).toBeDefined();
		expect(warning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);

		expect(
			descriptors.some((d) =>
				d.traces.includes("OrderService.placeOrder.pre0"),
			),
		).toBe(false);

		expect(strategies["OrderService.placeOrder.pre0"]).toBe("property");

		const suite = planTestCases(ctx);
		expect(suite.clauseIds).toContain("OrderService.placeOrder.pre0");
		expectStrategyCoverage(ctx, strategies);
	});
});

// ── Center re-review: MIXED guard sets — field-bound equality + sibling ──────
// The reachable crash the Center re-review found: an operation whose guard set
// carries a field-referencing multi-param equality (`f == a`, f a manifest
// field) AND another multi-param oracle (`a == b`). The field-bound equality
// itself is PLANNED (field-bound layout, Center B1). But ANY OTHER
// satisfies/invariant-preserving descriptor of that operation — a param-param
// mirror, a coupled compound — would need to filter with the field-referencing
// sibling, and a manifest field can never be destructured from the record: the
// record filter comes out EMPTY and the emitter throws ("Refusing to emit:
// record-layout property ... has an empty record filter"). The ratified fix:
// non-field-bound descriptors of a field-bound-guard operation are
// PROPERTY_UNPLANNABLE — warning present, descriptor absent, strategy stays
// property, the field-bound descriptor stays planned.

function mixedGuardSetContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			MergeService: {
				invariants: [],
				operations: {
					merge: {
						id: "MergeService.merge",
						params: [
							{ name: "a", type: "string" },
							{ name: "b", type: "string" },
						],
						preconditions: [
							{ id: "MergeService.merge.pre0", expr: "f == a" },
							{ id: "MergeService.merge.pre1", expr: "a == b" },
						],
						postconditions: [],
						effects: [],
						sourceHash: "merge-hash",
					},
				},
			},
		},
	};
	const manifests: ManifestsFile = {
		manifests: {
			MergeService: {
				sourceHash: "man-merge",
				fields: { f: "string" },
			},
		},
	};
	return makeContext(contracts, manifests, EMPTY_PREDICATES, {
		enabled: true,
		numRuns: 100,
	});
}

describe("planPropertyBlocks — MIXED guard set: field-bound equality + mirror sibling (Center re-review)", () => {
	it("the field-bound equality's OWN descriptor stays PLANNED when its guard set carries a mirror sibling — no warning for the field-bound clause", () => {
		const ctx = mixedGuardSetContext();
		const suite = planTestCases(ctx);
		const { descriptors, warnings } = planPropertyBlocks(suite, ctx);

		// Fixture clause-code verification: pre0 `f == a` codegen's to a
		// TWO-param oracle referencing the manifest field f.
		const code = renderOracle(ctx, "MergeService.merge.pre0");
		expect(code).toBe("(f, a) => f === a");
		expect(oracleParamsOf(code)).toEqual(["f", "a"]);

		// The field-bound clause is NOT warned.
		expect(warnings.some((w) => w.field === "MergeService.merge.pre0")).toBe(
			false,
		);

		// The field-bound descriptor IS planned — OP-PARAMS ONLY ([a, b], no
		// mirrorOf); the manifest field is never a sampled spec.
		const fieldBound = descriptors.find(
			(d) => d.id === "MergeService.merge.property-satisfies-0",
		);
		expect(fieldBound).toBeDefined();
		expect(fieldBound?.params.map((spec) => spec.param)).toEqual(["a", "b"]);
		expect(fieldBound?.params.some((spec) => spec.mirrorOf !== undefined)).toBe(
			false,
		);
		expect(
			descriptors.flatMap((d) => d.params.map((spec) => spec.param)),
		).not.toContain("f");
		expect(fieldBound?.clauses[0].code).toBe("(f, a) => f === a");
		expect(fieldBound?.clauses[0].clauseId).toBe("MergeService.merge.pre0");
	});

	it("any OTHER satisfies descriptor of a field-bound-guard operation is PROPERTY_UNPLANNABLE — the param-param mirror a == b is a warning, descriptor absent, strategy stays property", () => {
		const ctx = mixedGuardSetContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		// Fixture clause-code verification: pre1 `a == b` codegen's to a
		// TWO-param mirror oracle.
		const code = renderOracle(ctx, "MergeService.merge.pre1");
		expect(code).toBe("(a, b) => a === b");
		expect(oracleParamsOf(code)).toEqual(["a", "b"]);

		// The mirror sibling is a warning — its block would need to filter
		// with the field-referencing sibling `f == a`, which can never be
		// destructured from the record (the reachable empty-record-filter
		// crash). Never a silent zero.
		const warning = warnings.find((w) => w.field === "MergeService.merge.pre1");
		expect(warning).toBeDefined();
		expect(warning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);

		// No descriptor carries the mirror clause.
		expect(
			descriptors.some((d) => d.traces.includes("MergeService.merge.pre1")),
		).toBe(false);

		// The SELECTOR still records property for both clauses (bothSideFieldRef
		// shape); the PLANNER finds the mirror's mixed layout unplannable.
		expect(strategies["MergeService.merge.pre1"]).toBe("property");
		expect(strategies["MergeService.merge.pre0"]).toBe("property");

		// The coverage gap stays visible for the warned clause.
		expect(suite.clauseIds).toContain("MergeService.merge.pre1");
		expect(suite.clauseIds).toContain("MergeService.merge.pre0");
		expectStrategyCoverage(ctx, strategies);
	});
});

// ── Center re-review: zero-param field-field equality ────────────────────────
// `f1 == f2` with BOTH operands manifest fields and NO operation params: the
// field-bound layout has nothing to sample — the emitter would render
// `fc.property(, () => {` (syntax garbage). The ratified fix: the clause is
// PROPERTY_UNPLANNABLE — warning present, descriptor absent, strategy stays
// property, coverage gap visible.

function zeroParamFieldEqualityContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			RegistryService: {
				invariants: [],
				operations: {
					validate: {
						id: "RegistryService.validate",
						params: [],
						preconditions: [
							{
								id: "RegistryService.validate.pre0",
								expr: "f1 == f2",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "validate-hash",
					},
				},
			},
		},
	};
	const manifests: ManifestsFile = {
		manifests: {
			RegistryService: {
				sourceHash: "man-registry",
				fields: { f1: "string", f2: "string" },
			},
		},
	};
	return makeContext(contracts, manifests, EMPTY_PREDICATES, {
		enabled: true,
		numRuns: 100,
	});
}

describe("planPropertyBlocks — zero-param field-field equality is PROPERTY_UNPLANNABLE (Center re-review)", () => {
	it("f1 == f2 with no operation params cannot be sampled — warning present, descriptor absent, strategy stays property, coverage gap visible", () => {
		const ctx = zeroParamFieldEqualityContext();
		const suite = planTestCases(ctx);
		const { descriptors, strategies, warnings } = planPropertyBlocks(
			suite,
			ctx,
		);

		// Fixture clause-code verification: `f1 == f2` codegen's to a TWO-param
		// oracle with BOTH operands manifest fields — the operation has ZERO
		// params, so the field-bound layout has nothing to sample.
		const code = renderOracle(ctx, "RegistryService.validate.pre0");
		expect(code).toBe("(f1, f2) => f1 === f2");
		expect(oracleParamsOf(code)).toEqual(["f1", "f2"]);

		// Same LoaderWarning channel as the retained-unplannable shapes.
		const warning = warnings.find(
			(w) => w.field === "RegistryService.validate.pre0",
		);
		expect(warning).toBeDefined();
		expect(warning?.code).toBe("PROPERTY_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);

		// The clause contributes NO descriptor — never a silent zero, never an
		// empty-param `fc.property(, () =>` block.
		expect(
			descriptors.some((d) =>
				d.traces.includes("RegistryService.validate.pre0"),
			),
		).toBe(false);

		// The SELECTOR still records property; the PLANNER finds the zero-param
		// field-field equality unplannable.
		expect(strategies["RegistryService.validate.pre0"]).toBe("property");

		// The coverage gap stays visible.
		expect(suite.clauseIds).toContain("RegistryService.validate.pre0");
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

	it("ArbitrarySpec carries mirrorOf on the equality-mirror TARGET — no independent arbitrary for it (VERSAILLES-165)", () => {
		// The mirror TARGET (the right operand of `p1 == p2`) carries
		// mirrorOf pointing at the SOURCE param; the SOURCE has no mirrorOf.
		const mirrored: ArbitrarySpec = {
			param: "newStatus",
			typeRef: "string",
			kind: "string",
			mirrorOf: "status",
		};
		const source: ArbitrarySpec = {
			param: "status",
			typeRef: "string",
			kind: "string",
		};
		expect(mirrored.mirrorOf).toBe("status");
		expect(source.mirrorOf).toBeUndefined();
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
