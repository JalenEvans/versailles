import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseExpression } from "../packages/core/src/core/parser.js";
import type { ClauseKind, Node } from "../packages/core/src/core/parser.js";
import { renderClausePredicate } from "../packages/engine/src/generator/codegen.js";
import { derivePropertySeed } from "../packages/engine/src/generator/seed.js";
import { selectStrategy } from "../packages/engine/src/generator/strategy.js";
import type {
	ClauseShape,
	PbtStrategy,
	StrategyOptions,
} from "../packages/engine/src/generator/strategy.js";

/**
 * Seeded PBT emission — machinery property tests (ADR-0017, build-spec §9.6).
 *
 * The Chunk 2–6 machinery — the clause-codegen renderer (codegen.ts:
 * renderClausePredicate), the per-clause strategy selector (strategy.ts:
 * selectStrategy), and the seed derivation helper (seed.ts:
 * derivePropertySeed) — is implemented. These tests extend the deterministic
 * battery (generator-codegen.test.ts / generator-selector.test.ts /
 * generator-seed.test.ts) with the PROPERTY dimension fast-check is for:
 *
 * 1. Codegen-vs-evaluator parity — the codegen'd oracle must produce the SAME
 *    truth value as the planner's evaluate() (planner.ts, private) across a
 *    fast-check-generated sample of values, for representative clause shapes
 *    (numeric compare, compound and/or, in-list, not, old-resolution in
 *    postconditions).
 *
 *    DESIGN: planner.ts does NOT export evaluate (it is a planning-internal
 *    helper), so this file carries a faithful reference evaluator
 *    (`refEvaluate`) that mirrors planner.ts's evaluate() semantics line for
 *    line — the module docs in codegen.ts pin those semantics precisely (strict
 *    === / !== equality, numeric type guards on relationals and arithmetic,
 *    `in` as strict membership over the literal list, and/or short-circuit,
 *    not = !, fieldRef resolution params → post → pre, old(field) → pre ONLY).
 *    The parity claim under test is therefore: the EMITTED JS (compiled and
 *    executed) agrees with those documented evaluate() semantics on
 *    same-typed primitive domains. This is exactly the guarantee the feature
 *    promises — the emitted oracle is the runtime truth of the generated
 *    property tests, so a byte-level divergence from evaluate() would be a
 *    wrong-oracle bug (the W2/W3 divergences codegen.ts documents are
 *    cross-typed coercions that same-typed numeric sampling deliberately
 *    stays away from).
 *
 *    The codegen'd arrow-function source is compiled with `new Function`
 *    (side-effect-free and identifier-safe BY CONSTRUCTION — codegen.ts's
 *    contract), and its parameter names are read back from the byte-pinned
 *    `(<params>) => <expr>` prefix. Each parameter is bound to the value
 *    evaluate()'s fieldRef resolution would yield (params → post → pre), with
 *    the appended `preState` parameter bound to the pre-state object — so the
 *    compiled predicate sees exactly the environment the reference evaluator
 *    resolves.
 *
 * 2. Selector determinism — selectStrategy(shape, { pbtEnabled }) is a pure
 *    table lookup: the same shape returns the same strategy across repeated
 *    calls, across generated shapes, and across shuffled call orders (the
 *    §9.6 strategy table is pinned exactly, including the expected-rejection
 *    AND postcondition-literal pbtEnabled gates — VERSAILLES-191: a
 *    literal-computable postcondition is a region property, property when PBT
 *    is enabled, example only on the disabled/absent path).
 *
 * 3. Seed stability — derivePropertySeed(clauseIds, grammarVersion) is stable
 *    across repeated calls for ANY generated clause-id set (always an int32),
 *    distinct sets derive distinct seeds, clause ORDER reshuffles the seed
 *    (ADR-0017: reordering is a real contract edit), and the grammar version
 *    is part of the hash input. The distinctness/order claims are
 *    collision-prone, so every fc.assert here carries an explicit fixed
 *    `seed` — fast-check's default seed is time-based, and a probabilistic
 *    claim must be reproducible run-to-run to never flake CI.
 */

// ── Part 1 — codegen-vs-evaluator parity ─────────────────────────────────────

/** The planner's evaluation environment (planner.ts EvalEnv, mirrored). */
type RefEnv = {
	params: Record<string, unknown>;
	pre: Record<string, unknown>;
	post: Record<string, unknown>;
};

/**
 * Faithful mirror of planner.ts evaluate() (planner.ts:1431). The planner does
 * not export evaluate, so this reference interpreter pins its documented
 * semantics: strict equality, numeric type guards on relationals/arithmetic,
 * `in` as strict membership, and/or short-circuit, not = !, fieldRef
 * resolution params → post → pre (Center W3), old(field) → pre ONLY.
 */
function refEvaluate(node: Node, env: RefEnv): unknown {
	switch (node.type) {
		case "literal":
			return node.value;
		case "fieldRef": {
			const root = node.path[0];
			if (typeof root === "string") {
				if (root in env.params) {
					return env.params[root];
				}
				if (root in env.post) {
					return env.post[root];
				}
				if (root in env.pre) {
					return env.pre[root];
				}
			}
			return undefined;
		}
		case "old": {
			const root = node.ref.path[0];
			if (typeof root === "string" && root in env.pre) {
				return env.pre[root];
			}
			return undefined;
		}
		case "arithmetic": {
			const left = refEvaluate(node.left, env);
			const right = refEvaluate(node.right, env);
			if (typeof left !== "number" || typeof right !== "number") {
				return undefined;
			}
			switch (node.op) {
				case "+":
					return left + right;
				case "-":
					return left - right;
				case "*":
					return left * right;
				case "/":
					return right === 0 ? undefined : left / right;
			}
			return undefined;
		}
		case "compare": {
			const left = refEvaluate(node.left, env);
			const right = refEvaluate(node.right, env);
			switch (node.op) {
				case "==":
					return left === right;
				case "!=":
					return left !== right;
				case ">":
					return (
						typeof left === "number" &&
						typeof right === "number" &&
						left > right
					);
				case ">=":
					return (
						typeof left === "number" &&
						typeof right === "number" &&
						left >= right
					);
				case "<":
					return (
						typeof left === "number" &&
						typeof right === "number" &&
						left < right
					);
				case "<=":
					return (
						typeof left === "number" &&
						typeof right === "number" &&
						left <= right
					);
				case "in":
					return (
						Array.isArray(right) && right.some((member) => member === left)
					);
			}
			return undefined;
		}
		case "and":
			return (
				Boolean(refEvaluate(node.left, env)) &&
				Boolean(refEvaluate(node.right, env))
			);
		case "or":
			return (
				Boolean(refEvaluate(node.left, env)) ||
				Boolean(refEvaluate(node.right, env))
			);
		case "not":
			return !refEvaluate(node.operand, env);
		case "predicateCall":
			return undefined;
	}
	return undefined;
}

/**
 * Parses a fixture expr with the real parser (the generator-codegen test
 * helper pattern). Throws only on a fixture-authoring error — never a
 * machinery behaviour.
 */
function parseExpr(expr: string, kind: ClauseKind): Node {
	const result = parseExpression(expr, kind, "pbt-machinery.fixture");
	// Narrow on the `errors` property rather than `!result.ok`: under the
	// non-strict tsc flags TS inverts the `ok` discriminant narrowing (the
	// same quirk behind the pre-existing TS2339s at parser.ts:827 and
	// workspace.ts:665). Property-presence narrowing is discriminant-
	// independent and holds in both modes.
	if ("errors" in result) {
		throw new Error(
			`fixture parse failed for ${expr}: ${JSON.stringify(result.errors)}`,
		);
	}
	return result.ast;
}

/** The byte-pinned `(<params>) => <expr>` prefix of every codegen'd oracle. */
const ARROW_PARAMS_RE = /^\(([^)]*)\) => /;

/** The default pre-state parameter name codegen.ts appends for old() nodes. */
const PRE_STATE_PARAM = "preState";

/** Reads the arrow-function parameter names back from the codegen'd source. */
function predicateParams(code: string): string[] {
	const match = ARROW_PARAMS_RE.exec(code);
	if (match === null) {
		throw new Error(`unexpected codegen output (no arrow prefix): ${code}`);
	}
	return match[1] === ""
		? []
		: match[1].split(",").map((param) => param.trim());
}

/**
 * Binds the codegen'd arrow-function parameters to the reference environment
 * exactly as evaluate()'s fieldRef resolution would (params → post → pre);
 * the appended preState parameter binds the pre-state object itself.
 */
function bindArgs(code: string, env: RefEnv): unknown[] {
	return predicateParams(code).map((name) => {
		if (name === PRE_STATE_PARAM) {
			return env.pre;
		}
		if (name in env.params) {
			return env.params[name];
		}
		if (name in env.post) {
			return env.post[name];
		}
		if (name in env.pre) {
			return env.pre[name];
		}
		return undefined;
	});
}

/**
 * Compiles a codegen'd arrow-function source into a callable predicate. The
 * emitted code is side-effect-free and identifier-safe BY CONSTRUCTION
 * (codegen.ts's contract: no assignment, no method calls other than predicate
 * calls, no `function` declarations) — compiling the renderer's own trusted
 * output is the only way to exercise the EXACT bytes that fill
 * PropertyClause.code in the PBT IR.
 */
function compilePredicate(code: string): (...args: unknown[]) => unknown {
	// Compiling the renderer's own trusted, side-effect-free output (codegen.ts
	// guarantees no assignment, no method calls other than predicate calls, no
	// `function` declarations) — the parity oracle under test, never user input.
	return new Function(`return (${code})`)() as (...args: unknown[]) => unknown;
}

/** One parity spec: a clause expr + a generated sample of runtime values. */
type ParitySpec = {
	name: string;
	expr: string;
	kind: ClauseKind;
	arb: fc.Arbitrary<Record<string, unknown>>;
	buildEnv: (values: Record<string, unknown>) => RefEnv;
};

/** A single-fieldRef clause whose param is generated from `arb`. */
function singleParamSpec(
	name: string,
	expr: string,
	param: string,
	arb: fc.Arbitrary<unknown>,
): ParitySpec {
	return {
		name,
		expr,
		kind: "preconditions",
		arb: arb.map((value) => ({ [param]: value })),
		buildEnv: (values) => ({ params: values, pre: {}, post: {} }),
	};
}

/** old-resolution in a postcondition: bare fieldRef = post-state, old = pre. */
const POST_STATE_SPEC: ParitySpec = {
	name: "old-resolution in a postcondition",
	expr: "balance == old(balance) - amount",
	kind: "postconditions",
	arb: fc
		.tuple(fc.integer(), fc.integer(), fc.integer())
		.map(([amount, preBalance, postBalance]) => ({
			amount,
			preBalance,
			postBalance,
		})),
	buildEnv: (values) => ({
		params: { amount: values.amount as number },
		pre: { balance: values.preBalance as number },
		post: { balance: values.postBalance as number },
	}),
};

/**
 * Representative clause shapes where parity holds — same-typed primitive
 * domains only. The documented W2/W3 divergences (codegen.ts) are
 * cross-typed coercions (string arithmetic, divisor-zero Infinity) that this
 * sampling deliberately stays away from: numeric clauses sample integers,
 * in-list samples the membership pool + outsiders, `not` samples the boolean
 * domain for the fieldRef-primary form.
 */
const PARITY_SPECS: ParitySpec[] = [
	singleParamSpec("numeric compare >=", "x >= 0", "x", fc.integer()),
	singleParamSpec("numeric compare >", "x > 10", "x", fc.integer()),
	singleParamSpec("numeric compare <=", "x <= 100", "x", fc.integer()),
	singleParamSpec("numeric compare <", "x < 50", "x", fc.integer()),
	singleParamSpec("numeric equality (strict ===)", "x == 5", "x", fc.integer()),
	singleParamSpec(
		"numeric inequality (strict !==)",
		"x != 5",
		"x",
		fc.integer(),
	),
	singleParamSpec(
		"compound and (flagship)",
		"x >= 0 and x <= 100",
		"x",
		fc.integer(),
	),
	singleParamSpec("compound or", "x < 0 or x > 100", "x", fc.integer()),
	singleParamSpec(
		"in-list string membership",
		'tier in ["GOLD", "SILVER"]',
		"tier",
		fc.constantFrom("GOLD", "SILVER", "BRONZE", "PLATINUM"),
	),
	singleParamSpec(
		"in-list number membership",
		"x in [1, 2, 3]",
		"x",
		fc.constantFrom(1, 2, 3, 4, 5, -1),
	),
	singleParamSpec(
		"not of a comparison (parenthesized)",
		"not x == 0",
		"x",
		fc.integer(),
	),
	singleParamSpec(
		"not of a fieldRef primary",
		"not active",
		"active",
		fc.boolean(),
	),
	POST_STATE_SPEC,
];

/** Runs the parity property for one spec: codegen truth === evaluate truth. */
function assertCodegenParity(spec: ParitySpec): void {
	const ast = parseExpr(spec.expr, spec.kind);
	const code = renderClausePredicate(ast);
	const predicate = compilePredicate(code);
	fc.assert(
		fc.property(spec.arb, (values) => {
			const env = spec.buildEnv(values);
			const expected = Boolean(refEvaluate(ast, env));
			const actual = Boolean(predicate(...bindArgs(code, env)));
			expect(actual).toBe(expected);
		}),
		{ numRuns: 100 },
	);
}

describe("renderClausePredicate vs planner evaluate — truth-value parity (ADR-0017 §9.6)", () => {
	for (const spec of PARITY_SPECS) {
		it(`${spec.name}: "${spec.expr}" — the codegen'd oracle and evaluate() agree on every generated value`, () => {
			assertCodegenParity(spec);
		});
	}
});

// ── Part 2 — selectStrategy determinism ──────────────────────────────────────

/** Every shape in the §9.6 strategy table (the compound hasNumericBound variant included). */
const PRE_SHAPES: ClauseShape[] = [
	{ surface: "precondition", kind: "numeric-bound" },
	{ surface: "precondition", kind: "in" },
	{ surface: "precondition", kind: "predicateCall" },
	{ surface: "precondition", kind: "compound" },
	{ surface: "precondition", kind: "compound", hasNumericBound: true },
	{ surface: "precondition", kind: "bothSideFieldRef" },
	{ surface: "precondition", kind: "other" },
];

const POST_SHAPES: ClauseShape[] = [
	{ surface: "postcondition", kind: "literal" },
	{ surface: "postcondition", kind: "uncomputable" },
];

const INVARIANT_SHAPES: ClauseShape[] = [
	{ surface: "invariant", kind: "effects-overlap" },
	{ surface: "invariant", kind: "plain" },
];

const REJECTION_SHAPE: ClauseShape = { surface: "expected-rejection" };

const ALL_SHAPES: ClauseShape[] = [
	...PRE_SHAPES,
	...POST_SHAPES,
	...INVARIANT_SHAPES,
	REJECTION_SHAPE,
];

const VALID_STRATEGIES: readonly PbtStrategy[] = [
	"example",
	"property",
	"property-with-falsifier",
];

/**
 * The exact §9.6 strategy table (strategy.ts module doc) — expected-rejection
 * is the ONLY shape gated on pbtEnabled.
 */
const STRATEGY_TABLE: Array<{
	shape: ClauseShape;
	options: StrategyOptions;
	expected: PbtStrategy;
}> = [
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
		shape: { surface: "precondition", kind: "compound", hasNumericBound: true },
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
	{
		shape: { surface: "postcondition", kind: "literal" },
		options: { pbtEnabled: true },
		expected: "property",
	},
	{
		shape: { surface: "postcondition", kind: "literal" },
		options: { pbtEnabled: false },
		expected: "example",
	},
	{
		shape: { surface: "postcondition", kind: "uncomputable" },
		options: { pbtEnabled: true },
		expected: "property",
	},
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
];

describe("selectStrategy — determinism and the §9.6 strategy table (ADR-0017)", () => {
	it("pins the strategy table exactly: every shape → its strategy, both pbtEnabled gates", () => {
		for (const row of STRATEGY_TABLE) {
			const first = selectStrategy(row.shape, row.options);
			// Repeated calls over the SAME shape object agree (pure lookup).
			expect(selectStrategy(row.shape, row.options)).toBe(first);
			expect(selectStrategy(row.shape, row.options)).toBe(first);
			expect(first).toBe(row.expected);
		}
	});

	it("returns the same strategy across a fast-check-generated sample of shapes and pbtEnabled flags", () => {
		const shapeArb: fc.Arbitrary<ClauseShape> = fc.constantFrom(...ALL_SHAPES);
		const enabledArb = fc.constantFrom(true, false);
		fc.assert(
			fc.property(shapeArb, enabledArb, (shape, enabled) => {
				const options: StrategyOptions = { pbtEnabled: enabled };
				const first = selectStrategy(shape, options);
				expect(selectStrategy(shape, options)).toBe(first);
				expect(selectStrategy(shape, options)).toBe(first);
				expect(VALID_STRATEGIES).toContain(first);
			}),
			{ numRuns: 100 },
		);
	});

	it("shuffled call order never changes a shape's strategy — position-independent pure lookup", () => {
		// The pre-computed map keys on the SAME object references
		// shuffledSubarray draws from, so identity lookup is sound.
		const expected = new Map<ClauseShape, PbtStrategy>(
			ALL_SHAPES.map((shape) => [
				shape,
				selectStrategy(shape, { pbtEnabled: true }),
			]),
		);
		fc.assert(
			fc.property(
				fc.shuffledSubarray(ALL_SHAPES, {
					minLength: 1,
					maxLength: ALL_SHAPES.length,
				}),
				(shuffled) => {
					for (const shape of shuffled) {
						expect(selectStrategy(shape, { pbtEnabled: true })).toBe(
							expected.get(shape),
						);
					}
				},
			),
			{ numRuns: 100 },
		);
	});
});

// ── Part 3 — derivePropertySeed stability ────────────────────────────────────

/**
 * A deterministic pool of realistic clause ids. The seed-distinctness and
 * order-matters claims are collision-prone (FNV-1a 32-bit), so every
 * fc.assert in this section passes an explicit fixed `seed`: fast-check's
 * default seed is time-based, and a probabilistic claim must be reproducible
 * run-to-run to never flake CI.
 */
const CLAUSE_ID_POOL = [
	"OrderService.placeOrder.pre0",
	"OrderService.placeOrder.pre1",
	"OrderService.placeOrder.post0",
	"OrderService.placeOrder.post1",
	"AccountService.withdraw.pre0",
	"AccountService.withdraw.pre1",
	"AccountService.withdraw.post0",
	"AccountService.inv0",
] as const;

/** Generated clause-id sets: unique ids, any size (including the empty set). */
const clauseSetArb: fc.Arbitrary<string[]> = fc.uniqueArray(
	fc.constantFrom(...CLAUSE_ID_POOL),
	{ minLength: 0, maxLength: CLAUSE_ID_POOL.length },
);

/** Unambiguous per-set serialization for equality comparison (ids have no commas). */
const setKey = (ids: readonly string[]): string => ids.join(",");

describe("derivePropertySeed — stability over generated clause-id sets (ADR-0017)", () => {
	it("any generated clause-id set derives a STABLE seed across repeated calls, always an int32", () => {
		fc.assert(
			fc.property(clauseSetArb, (ids) => {
				const first = derivePropertySeed(ids, "1.0");
				for (let i = 0; i < 3; i++) {
					expect(derivePropertySeed(ids, "1.0")).toBe(first);
				}
				// fast-check's `seed | 0` round-trip: an int32 seed reproduces.
				expect(Number.isInteger(first)).toBe(true);
				expect(first).toBeGreaterThanOrEqual(-2147483648);
				expect(first).toBeLessThanOrEqual(2147483647);
			}),
			{ numRuns: 100, seed: 10101 },
		);
	});

	it("different generated clause sets derive different seeds (distinctness)", () => {
		fc.assert(
			fc.property(clauseSetArb, clauseSetArb, (a, b) => {
				// Determinism within the run is the precondition of the claim.
				expect(derivePropertySeed(a, "1.0")).toBe(derivePropertySeed(a, "1.0"));
				expect(derivePropertySeed(b, "1.0")).toBe(derivePropertySeed(b, "1.0"));
				// Distinctness only when the sets actually differ — two equal
				// generated sets trivially share a seed.
				if (setKey(a) !== setKey(b)) {
					expect(derivePropertySeed(a, "1.0")).not.toBe(
						derivePropertySeed(b, "1.0"),
					);
				}
			}),
			{ numRuns: 100, seed: 20202 },
		);
	});

	it("clause ORDER reshuffles the seed — a reordered generated set derives a different seed (ADR-0017)", () => {
		fc.assert(
			fc.property(clauseSetArb, (ids) => {
				const reversed = [...ids].reverse();
				// Guard the palindrome/empty cases where reversal is identity.
				if (setKey(reversed) !== setKey(ids)) {
					expect(derivePropertySeed(ids, "1.0")).not.toBe(
						derivePropertySeed(reversed, "1.0"),
					);
				}
			}),
			{ numRuns: 100, seed: 30303 },
		);
	});

	it("the grammar version is part of the hash input — same generated set, different version, different seed", () => {
		fc.assert(
			fc.property(clauseSetArb, (ids) => {
				expect(derivePropertySeed(ids, "2.0")).not.toBe(
					derivePropertySeed(ids, "1.0"),
				);
			}),
			{ numRuns: 100, seed: 40404 },
		);
	});

	it("deterministic battery: a fixed set of clause-id sets is stable AND pairwise-distinct", () => {
		// The fully deterministic complement to the seeded fast-check
		// properties: every pair of fixed sets derives a different seed.
		const fixedSets: readonly string[][] = [
			[],
			["OrderService.placeOrder.pre0"],
			["OrderService.placeOrder.pre0", "OrderService.placeOrder.pre1"],
			["OrderService.placeOrder.pre1", "OrderService.placeOrder.pre0"],
			[
				"AccountService.inv0",
				"AccountService.withdraw.pre0",
				"AccountService.withdraw.post0",
			],
			[
				"OrderService.placeOrder.pre0",
				"AccountService.inv0",
				"CustomerService.upgrade.pre0",
				"CustomerService.upgrade.post0",
			],
		];
		for (const set of fixedSets) {
			const first = derivePropertySeed(set, "1.0");
			expect(derivePropertySeed(set, "1.0")).toBe(first);
		}
		for (let i = 0; i < fixedSets.length; i++) {
			for (let j = i + 1; j < fixedSets.length; j++) {
				const a = fixedSets[i];
				const b = fixedSets[j];
				if (setKey(a) !== setKey(b)) {
					expect(derivePropertySeed(a, "1.0")).not.toBe(
						derivePropertySeed(b, "1.0"),
					);
				}
			}
		}
	});
});
