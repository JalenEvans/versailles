import { describe, expect, it } from "vitest";

import { parseExpression } from "../packages/core/src/core/parser.js";
import type { Node } from "../packages/core/src/core/parser.js";
// The strategy-selector types are the NEW type surface of ADR-0017 Phase 3,
// exported from packages/engine/src/generator/strategy.ts and re-exported
// through the generator barrel (index.ts) — the same convention every other
// generator IR type follows (see tests/generator-seed.test.ts). These are
// type-only imports: they force the types to EXIST under a type-check, while
// the runtime Red for this chunk comes from the selectStrategy import below.
import type {
	ClauseShape,
	ClauseSurface,
	PbtStrategy,
	StrategyMap,
	StrategyOptions,
	StrategyRecord,
} from "../packages/engine/src/generator/index.js";
// The per-clause strategy selector is the NEW runtime surface of ADR-0017
// Phase 3. It does NOT exist yet — this import is the Red-phase failure. The
// selector MUST live at packages/engine/src/generator/strategy.ts (module
// `strategy.js`) and be re-exported from the generator barrel (index.ts) for
// public-surface consistency with planTestCases/derivePropertySeed/emitSuite.
import { selectStrategy } from "../packages/engine/src/generator/strategy.js";

/**
 * Seeded PBT emission — per-clause strategy selector (ADR-0017 Phase 3,
 * build-spec §9.6 + deterministic-generation.contract.yaml
 * `plan_property_blocks`).
 *
 * Pinned against docs/build-spec.md §9.6, docs/contracts/
 * deterministic-generation.contract.yaml (plan_property_blocks), and
 * packages/engine/src/generator/planner.ts (`classifyClause`).
 *
 * ── What the selector decides ───────────────────────────────────────────────
 *
 * The deterministic generator already plans example-based concrete cases for
 * every clause (§9.1–§9.2): boundary values, equivalence partitions,
 * precondition-violation falsifiers, postcondition-satisfaction with real
 * assertion descriptors, invariant cases, expected-rejection sweeps. Seeded
 * PBT emission (ADR-0017) is ADDITIVE — the concrete cases always stay, so
 * the selector answers ONE question per clause:
 *
 *   does PBT add value over the existing concrete case for THIS clause shape,
 *   or is the example-based case strictly better?
 *
 * It is a pure function of a normalized clause shape + the
 * config.propertyBased.enabled flag: no randomness, no runtime execution, no
 * LLM (ADR-0002, re-scoped to generation-time by ADR-0017). Same shape →
 * same strategy, always.
 *
 * ── Module contract (what these tests require) ─────────────────────────────
 *
 * Module: packages/engine/src/generator/strategy.ts (re-exported from index.ts)
 *
 * ```ts
 * export type PbtStrategy = "example" | "property" | "property-with-falsifier";
 *
 * export type ClauseSurface =
 *   | "precondition" | "postcondition" | "invariant" | "expected-rejection";
 *
 * // Normalized clause shape — the selector input. The planner builds this
 * // from classifyClause + planning metadata (surface, computability, effect
 * // overlap, top-level compound resolution).
 * export type ClauseShape =
 *   | { surface: "precondition";
 *       kind: "numeric-bound" | "in" | "predicateCall" | "compound"
 *           | "bothSideFieldRef" | "other";
 *       hasNumericBound?: boolean }   // compound variant only — a compound
 *                                     // that CONTAINS a numeric bound (the
 *                                     // boundary-ambiguity fixture)
 *   | { surface: "postcondition"; kind: "literal" | "uncomputable" }
 *   | { surface: "invariant"; kind: "effects-overlap" | "plain" }
 *   | { surface: "expected-rejection" };
 *
 * export type StrategyOptions = { pbtEnabled: boolean };
 *
 * export function selectStrategy(
 *   shape: ClauseShape,
 *   options: StrategyOptions,
 * ): PbtStrategy;
 *
 * // The per-clause decision record — the output shape the planner will
 * // attach to the planning output (clause → strategy).
 * export type StrategyRecord = {
 *   clauseId: string;
 *   strategy: PbtStrategy;
 *   shape: ClauseShape;
 * };
 * export type StrategyMap = Record<string, PbtStrategy>;
 * ```
 *
 * ── The documented mapping (build-spec §9.6 strategy table, per clause shape)
 *
 * | Shape (surface + kind)                     | Strategy                  |
 * |--------------------------------------------|---------------------------|
 * | precondition  numeric-bound (single bound) | example                   |
 * | precondition  in (in-clause members)       | example                   |
 * | precondition  predicateCall                | property-with-falsifier   |
 * | precondition  compound (and/or)            | property                  |
 * | precondition  bothSideFieldRef             | property                  |
 * | precondition  other / uncomputable         | property                  |
 * | postcondition literal (computable)         | example                   |
 * | postcondition uncomputable                 | property                  |
 * | invariant     effects-overlap              | property                  |
 * | invariant     plain (no effect overlap)    | example                   |
 * | expected-rejection  (pbtEnabled: true)     | property                  |
 * | expected-rejection  (pbtEnabled: false)    | example (sweep fallback)  |
 *
 * ── Design decisions these tests pin (documented for the implementer) ──────
 *
 * 1. "example" = the existing concrete cases fully cover the clause; NO
 *    property block is planned for it. "property" = a property block IS
 *    planned (accept-side / invariant-side exploration). "property-with-
 *    falsifier" = predicateCall clauses ONLY: an accept-side property is
 *    planned AND the deterministic example falsifier (the concrete
 *    precondition-violation case) is retained — the reject side stays
 *    example-based, because PBT cannot cheaply generate predicate-violating
 *    inputs (§9.5 keeps SMT out of v1 scope). This is the task's
 *    "property (accept side) + example falsifier" row.
 * 2. Strategy is a pure function of the normalized shape + pbtEnabled. The
 *    planner feeds it the RESOLVED classification: a top-level compound wins
 *    over any numeric-bound sub-expression (a clause that is BOTH numeric-
 *    bounded AND compound → property — compound precedence). The selector
 *    itself never re-derives the classification from the raw Node; it is
 *    total over the ClauseShape union (never undefined).
 * 3. expected-rejection is the ONLY shape whose strategy depends on
 *    pbtEnabled: enabled → property (replaces the §9.2 bounded sweep,
 *    contract plan_property_blocks); disabled → example (the sweep is the
 *    non-PBT fallback). Every other shape ignores the flag.
 * 4. Both-side-fieldRef compares (`status == newStatus`) and uncomputable
 *    expressions share the "property" strategy — the planner's
 *    postconditionAssertions already skips them (no unique subject / no
 *    resolvable literal), so PBT is the only oracle they get.
 * 5. enum-typed operation params are an equivalence-partition source
 *    (planEnumPartitionCases) — those cases are example-based, so the enum
 *    row maps to "example" through the clause-level `in` shape; the selector
 *    has no separate enum surface.
 */

// ── Fixture grounding: the shapes correspond to real contract grammar ──────
//
// Each documented shape is paired with a representative clause expr. Parsing
// it with the REAL parser proves the fixture is valid contract language
// (build-spec §4); the shape object is the normalized classification the
// planner derives from that AST + metadata.

const DOCUMENTED_EXPRS: Record<string, string> = {
	"precondition/numeric-bound": "amount >= 10",
	"precondition/in": 'status in ["ACTIVE", "FROZEN"]',
	"precondition/predicateCall": "isPositive(amount)",
	"precondition/compound": 'amount >= 10 and sku != ""',
	"precondition/bothSideFieldRef": "status == newStatus",
	"precondition/other": "newTier != null",
	"postcondition/literal": "old(balance) - amount == balance",
	"postcondition/uncomputable": "status == newStatus",
	"invariant/effects-overlap": "balance >= 0",
	"invariant/plain": 'status != "TERMINATED"',
};

function parseClauseExpr(
	expr: string,
	kind: "preconditions" | "postconditions" | "invariants",
	id: string,
): Node {
	const result = parseExpression(expr, kind, id);
	if (!result.ok) {
		throw new Error(
			`fixture parse failed for "${expr}": ${JSON.stringify(result.errors)}`,
		);
	}
	return result.ast;
}

// ── Documented mapping (one fixture per table row) ──────────────────────────

describe("selectStrategy — documented mapping (build-spec §9.6 + plan_property_blocks)", () => {
	it.each<{
		shape: ClauseShape;
		options: StrategyOptions;
		expected: PbtStrategy;
	}>([
		// precondition rows
		{
			shape: { surface: "precondition", kind: "numeric-bound" },
			options: { pbtEnabled: true },
			expected: "example",
		},
		{
			shape: { surface: "precondition", kind: "in" },
			options: { pbtEnabled: true },
			expected: "example",
		},
		{
			shape: { surface: "precondition", kind: "predicateCall" },
			options: { pbtEnabled: true },
			expected: "property-with-falsifier",
		},
		{
			shape: { surface: "precondition", kind: "compound" },
			options: { pbtEnabled: true },
			expected: "property",
		},
		{
			shape: { surface: "precondition", kind: "bothSideFieldRef" },
			options: { pbtEnabled: true },
			expected: "property",
		},
		{
			shape: { surface: "precondition", kind: "other" },
			options: { pbtEnabled: true },
			expected: "property",
		},
		// postcondition rows
		{
			shape: { surface: "postcondition", kind: "literal" },
			options: { pbtEnabled: true },
			expected: "example",
		},
		{
			shape: { surface: "postcondition", kind: "uncomputable" },
			options: { pbtEnabled: true },
			expected: "property",
		},
		// invariant rows
		{
			shape: { surface: "invariant", kind: "effects-overlap" },
			options: { pbtEnabled: true },
			expected: "property",
		},
		{
			shape: { surface: "invariant", kind: "plain" },
			options: { pbtEnabled: true },
			expected: "example",
		},
		// expected-rejection rows — the ONLY shape that depends on the flag
		{
			shape: { surface: "expected-rejection" },
			options: { pbtEnabled: true },
			expected: "property",
		},
		{
			shape: { surface: "expected-rejection" },
			options: { pbtEnabled: false },
			expected: "example",
		},
	])(
		"$shape.surface/$shape.kind with pbtEnabled=$options.pbtEnabled → $expected",
		({ shape, options, expected }) => {
			expect(selectStrategy(shape, options)).toBe(expected);
		},
	);

	it("every documented clause expr is valid contract grammar (fixture grounding)", () => {
		// The DOCUMENTED_EXPRS keys use singular surface names
		// ("precondition", "postcondition", "invariant"); map them to the
		// parser's ClauseKind ("preconditions" | "postconditions" |
		// "invariants"). The postcondition exprs contain old(...), which the
		// parser ONLY accepts in postconditions — the wrong kind would throw.
		for (const [key, expr] of Object.entries(DOCUMENTED_EXPRS)) {
			const surface = key.split("/")[0];
			const kind =
				surface === "precondition"
					? "preconditions"
					: surface === "postcondition"
						? "postconditions"
						: "invariants";
			expect(() => parseClauseExpr(expr, kind, `fixture.${key}`)).not.toThrow();
		}
	});
});

// ── Determinism (ADR-0002, ADR-0017) ───────────────────────────────────────

describe("selectStrategy — determinism (ADR-0002, ADR-0017)", () => {
	it("same shape + same options → same strategy across repeated calls", () => {
		const shape: ClauseShape = {
			surface: "precondition",
			kind: "compound",
			hasNumericBound: true,
		};
		const options: StrategyOptions = { pbtEnabled: true };
		const first = selectStrategy(shape, options);
		for (let i = 0; i < 5; i++) {
			expect(selectStrategy(shape, options)).toBe(first);
		}
	});

	it("is a pure function of the shape — the same shape is deterministic for every documented surface", () => {
		const shapes: ClauseShape[] = [
			{ surface: "precondition", kind: "numeric-bound" },
			{ surface: "precondition", kind: "predicateCall" },
			{ surface: "postcondition", kind: "literal" },
			{ surface: "postcondition", kind: "uncomputable" },
			{ surface: "invariant", kind: "effects-overlap" },
			{ surface: "expected-rejection" },
		];
		for (const shape of shapes) {
			const a = selectStrategy(shape, { pbtEnabled: true });
			const b = selectStrategy(shape, { pbtEnabled: true });
			expect(b).toBe(a);
		}
	});
});

// ── predicateCall → property-with-falsifier (accept side + example falsifier)

describe("selectStrategy — predicateCall pins property-with-falsifier", () => {
	it("an accept-side property is planned AND the deterministic example falsifier is retained", () => {
		// `isPositive(amount)` (fixture-grounded above): the ACCEPT side is
		// explored by a property (arbitraries the predicate accepts, asserting
		// the operation accepts), while the REJECT side stays example-based —
		// the planner's deterministic falsifier (number → PREDICATE_FALSIFY_NUMBER,
		// planner.ts) remains the concrete precondition-violation case. The
		// strategy must be DISTINCT from a bare "property" so the planner
		// knows the example falsifier must be retained for this clause.
		const shape: ClauseShape = {
			surface: "precondition",
			kind: "predicateCall",
		};
		const strategy = selectStrategy(shape, { pbtEnabled: true });
		expect(strategy).toBe("property-with-falsifier");
		expect(strategy).not.toBe("property");
		expect(strategy).not.toBe("example");
	});
});

// ── expected-rejection: property when enabled, non-PBT fallback when disabled

describe("selectStrategy — expected-rejection depends on pbtEnabled", () => {
	it("property when enabled — the §9.2 bounded sweep is replaced", () => {
		expect(
			selectStrategy({ surface: "expected-rejection" }, { pbtEnabled: true }),
		).toBe("property");
	});

	it("non-PBT fallback (example) when disabled — the sweep remains", () => {
		expect(
			selectStrategy({ surface: "expected-rejection" }, { pbtEnabled: false }),
		).toBe("example");
	});

	it("pbtEnabled is an explicit input parameter of the selector — never read from a global", () => {
		// The same shape with two different flag values yields two DIFFERENT
		// deterministic results — the flag must be threaded through the call.
		const enabled = selectStrategy(
			{ surface: "expected-rejection" },
			{ pbtEnabled: true },
		);
		const disabled = selectStrategy(
			{ surface: "expected-rejection" },
			{ pbtEnabled: false },
		);
		expect(enabled).not.toBe(disabled);
	});
});

// ── Boundary ambiguity: BOTH numeric-bounded AND compound → property ────────

describe("selectStrategy — boundary ambiguity precedence (compound wins)", () => {
	it("a clause that is BOTH numeric-bounded AND compound → property, not example", () => {
		// `amount >= 10 and sku != ""`: the top-level AST is `and` (classifyClause
		// → "other" today), so the resolved shape is compound. One side IS a
		// numeric single bound — per the documented precedence the compound
		// wins: the strategy must be property (PBT explores the interaction),
		// never example (the numeric-bound row's strategy).
		const shape: ClauseShape = {
			surface: "precondition",
			kind: "compound",
			hasNumericBound: true,
		};
		expect(selectStrategy(shape, { pbtEnabled: true })).toBe("property");
	});

	it("the SAME numeric bound WITHOUT the compound top level → example (numeric-bound row)", () => {
		// `amount >= 10` alone: the numeric-bound row — example (boundary ± 1
		// cases cover it exactly). Pins the precedence contrast with the
		// compound fixture above.
		const shape: ClauseShape = {
			surface: "precondition",
			kind: "numeric-bound",
		};
		expect(selectStrategy(shape, { pbtEnabled: true })).toBe("example");
	});

	it("a compound WITHOUT a numeric bound → property (compound row, no ambiguity)", () => {
		const shape: ClauseShape = {
			surface: "precondition",
			kind: "compound",
		};
		expect(selectStrategy(shape, { pbtEnabled: true })).toBe("property");
	});
});

// ── Strategy record — the planning-output shape (clause → strategy) ────────

describe("PBT strategy record — planning output shape (ADR-0017 Phase 3)", () => {
	it("StrategyRecord round-trips { clauseId, strategy, shape } — the per-clause decision record", () => {
		const record = {
			clauseId: "AccountService.withdraw.pre0",
			strategy: "property-with-falsifier",
			shape: {
				surface: "precondition",
				kind: "predicateCall",
			},
		} satisfies StrategyRecord;

		expect(record.clauseId).toBe("AccountService.withdraw.pre0");
		expect(record.strategy).toBe("property-with-falsifier");
		expect(record.shape).toEqual({
			surface: "precondition",
			kind: "predicateCall",
		});
	});

	it("StrategyMap is the clause → strategy map recorded on the planning output", () => {
		const map = {
			"AccountService.withdraw.pre0": "property-with-falsifier",
			"AccountService.withdraw.post0": "example",
			"AccountService.inv0": "property",
		} satisfies StrategyMap;

		expect(map["AccountService.withdraw.pre0"]).toBe("property-with-falsifier");
		expect(map["AccountService.withdraw.post0"]).toBe("example");
		expect(map["AccountService.inv0"]).toBe("property");
	});

	it("every strategy value is one of the three pinned PbtStrategy literals", () => {
		const strategies: PbtStrategy[] = [
			"example",
			"property",
			"property-with-falsifier",
		];
		expect(strategies).toHaveLength(3);
		// A selector result must always be one of these — the union is total
		// over ClauseShape (never undefined, never a fourth literal).
		const result = selectStrategy(
			{ surface: "precondition", kind: "other" },
			{ pbtEnabled: true },
		);
		expect(strategies).toContain(result);
	});
});

// ── Totality over the shape union ──────────────────────────────────────────

describe("selectStrategy — totality over ClauseShape", () => {
	it("returns a defined PbtStrategy for every documented surface/kind combination", () => {
		const shapes: ClauseShape[] = [
			{ surface: "precondition", kind: "numeric-bound" },
			{ surface: "precondition", kind: "in" },
			{ surface: "precondition", kind: "predicateCall" },
			{ surface: "precondition", kind: "compound" },
			{ surface: "precondition", kind: "bothSideFieldRef" },
			{ surface: "precondition", kind: "other" },
			{ surface: "postcondition", kind: "literal" },
			{ surface: "postcondition", kind: "uncomputable" },
			{ surface: "invariant", kind: "effects-overlap" },
			{ surface: "invariant", kind: "plain" },
			{ surface: "expected-rejection" },
		];
		const strategies: PbtStrategy[] = [
			"example",
			"property",
			"property-with-falsifier",
		];
		for (const shape of shapes) {
			expect(strategies).toContain(selectStrategy(shape, { pbtEnabled: true }));
		}
	});
});

// ── ClauseSurface admission (type-level support for the record shape) ───────

describe("PBT strategy — ClauseSurface admission (ADR-0017 Phase 3)", () => {
	it("admits the four clause surfaces the planner iterates", () => {
		const surfaces: ClauseSurface[] = [
			"precondition",
			"postcondition",
			"invariant",
			"expected-rejection",
		];
		expect(surfaces).toHaveLength(4);
		expect(surfaces).toContain("precondition");
		expect(surfaces).toContain("postcondition");
		expect(surfaces).toContain("invariant");
		expect(surfaces).toContain("expected-rejection");
	});
});
