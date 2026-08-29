import { describe, expect, it } from "vitest";

import { parseExpression } from "../packages/core/src/core/parser.js";
import type {
	ArithOp,
	ClauseKind,
	Node,
} from "../packages/core/src/core/parser.js";
// The clause-codegen renderer is the NEW runtime surface of ADR-0017
// (build-spec §9.6 "Clause-codegen'd oracles"). It lives at
// packages/engine/src/generator/codegen.ts (module `codegen.js`) and is
// re-exported from the generator barrel (index.ts) for public-surface
// consistency with derivePropertySeed / planTestCases / emitSuite. The Center
// review ratified a strict-equality change (W1) that the implementer is
// landing in parallel — these fixtures pin the NEW strict output.
import {
	type CodegenContext,
	renderClausePredicate,
} from "../packages/engine/src/generator/codegen.js";

/**
 * Clause-codegen predicate rendering — the oracle emitter of seeded PBT
 * emission (ADR-0017, accepted 2026-08-28; build-spec §9.6; deterministic-
 * generation.contract.yaml plan_property_blocks). Pinned against
 * packages/core/src/core/parser.ts (the frozen AST node set, §4.3) and
 * packages/engine/src/generator/planner.ts (evaluate() + assertSafeIdentifier).
 *
 * The renderer converts ANY contract-clause AST into an inline JS predicate
 * function (arrow function, side-effect-free) that generated property tests
 * use as the oracle. Output is byte-pinned: the exact JS source string IS the
 * contract. Predicate calls resolve to the real registered predicate functions
 * (imported in the generated test), old(field) resolves against a captured
 * pre-state object, and identifier safety mirrors the planner's
 * assertSafeIdentifier discipline — a name that is not a safe JS identifier
 * surfaces a non-silent error, never silently emitted broken JS. Equality
 * emits the STRICT `===`/`!==` lexemes (Center W1, ratified): evaluate()
 * compares with `===`/`!==`, so the oracle mirrors those strict semantics —
 * loose `==` truth-flips on cross-typed primitives.
 *
 * ── Module contract (what these tests require) ─────────────────────────────
 *
 * Module: packages/engine/src/generator/codegen.ts (re-exported from index.ts)
 *
 * ```ts
 * export type CodegenContext = {
 *   // Clause fieldRef root name → emitted arrow-function parameter name.
 *   // Absent entries default to the root name itself (which must already be
 *   // a safe JS identifier). E.g. { amount: "a" } renders `a` in place of
 *   // every `amount` field ref. Deterministic renames only — never renames
 *   // that would collide two roots onto one param (implementer may throw).
 *   paramNames?: Record<string, string>;
 *   // Identifier for the captured pre-state object that old(field) resolves
 *   // against (default "preState"). Appended as the LAST arrow-function
 *   // parameter exactly when the AST contains an `old` node.
 *   preStateName?: string;
 *   // Registered predicate name → module import specifier (e.g.
 *   // { isPositive: "./predicates.js" }). A predicateCall emits a reference
 *   // to the predicate function by its (safe) name — the name MUST be
 *   // present here, otherwise codegen refuses (non-silent): an emitted call
 *   // to an unimportable predicate would be broken JS.
 *   predicates?: Record<string, string>;
 * };
 *
 * export function renderClausePredicate(node: Node, ctx?: CodegenContext): string;
 * ```
 *
 * Returns a FULL arrow-function JS source string `(<params>) => <expr>` —
 * exactly what fills `PropertyClause.code` in the PBT IR (the seed test's
 * example oracle is `(amount) => amount >= 10`). Parameters are emitted in
 * first-referenced (deterministic in-order traversal) order: every fieldRef
 * root referenced by the clause, mapped through `ctx.paramNames`; then
 * `ctx.preStateName` (default `"preState"`) when an `old` node is present.
 *
 * ── Design decisions these tests pin (documented for the implementer) ──────
 *
 * 1. Byte-pinned, precedence-correct output with MINIMAL parens. The grammar's
 *    precedence (arithmetic > comparison > not > and > or) matches JS's
 *    operator precedence EXCEPT for one case: grammar `not` binds LOOSER than
 *    comparison, JS `!` binds TIGHTER than comparison. Therefore a `not` node
 *    whose operand is a binary node (compare/arithmetic/and/or/not) MUST emit
 *    parenthesized `!(<operand>)`; a `not` of a primary (literal / fieldRef /
 *    predicateCall) emits bare `!operand`. All other binary nodes emit bare
 *    `left <op> right` — the AST is fully parenthesized by construction and JS
 *    evaluates the emitted string exactly as the AST says.
 * 2. Equality emits evaluate()'s STRICT lexemes (Center W1, ratified):
 *    `==` → `===`, `!=` → `!==`. evaluate() compares with `===`/`!==` (the
 *    planner.ts compare branch) — the emitted oracle MUST mirror those strict
 *    semantics exactly. Loose `==` is not byte-faithful: on cross-typed
 *    primitives it truth-flips (JS `0 == ""` → true, `0 === ""` → false;
 *    `"1" == 1` → true, `"1" === 1` → false). Relational ops emit the
 *    contract lexemes verbatim (`<`, `<=`, `>`, `>=`) — evaluate() requires
 *    both operands to be numbers for those and JS relationals on numbers
 *    behave identically.
 * 3. old(field) renders `<preStateName>.<root><suffixes>` — the ONLY
 *    pre-state reference. This mirrors evaluate()'s `old` branch, which
 *    resolves against `env.pre` ONLY (a bare fieldRef resolves params → post
 *    → pre, but `old` never looks at params or post).
 * 4. predicateCall renders `<name>(<arg0>, <arg1>, ...)`. The predicate name
 *    is asserted safe AND must be present in `ctx.predicates` (the import
 *    table) — an unregistered predicate name is a non-silent error, mirroring
 *    the planner's "never a silent zero" philosophy for predicate clauses
 *    (PREDICATE_UNPLANNABLE, deterministic-generation.contract.yaml).
 * 5. Identifier safety: every emitted parameter name, every predicate name,
 *    and `preStateName` is checked against the planner's IDENTIFIER_RE
 *    (/^[A-Za-z_$][A-Za-z0-9_$]*$/) and throws with the assertSafeIdentifier
 *    failure mode on violation — NEVER silently emits broken JS.
 * 6. `in` membership renders as a chained `||` of STRICT `===` comparisons
 *    against a literal-list right side (`tier in ["GOLD", "SILVER"]` →
 *    `tier === "GOLD" || tier === "SILVER"`) — pure operator JS, no method
 *    calls, no closures, byte-pinned (mirrors evaluate()'s
 *    `right.some(member => member === left)`). An EMPTY literal list emits
 *    the always-false identity `false`: an OR-chain of zero comparisons has
 *    no concrete JS spelling. An `in` with any non-literal-list right side is
 *    a non-silent error (the planner's classifyClause only supports
 *    literal-list `in` rights; rendering a field-ref right would need a
 *    method call the side-effect-free contract forbids).
 * 7. A fieldRef path segment `"[]"` (the "any element" wildcard, e.g.
 *    `items[]`) is a non-silent error — no concrete JS property access exists
 *    for an unknown index. Flagged as ambiguous. A `__proto__` dotted segment
 *    is likewise refused: `obj.__proto__` is a prototype-chain / pollution
 *    access surface, so the renderer throws rather than emit it.
 * 8. Side-effect-free BY CONSTRUCTION: emitted code contains no assignment,
 *    no `function` declaration, and no method/function calls other than
 *    predicate calls. Pinned both by exact-byte expectations and by a
 *    source-inspection test.
 * 9. Determinism (ADR-0002): renderClausePredicate is a pure function of
 *    (node, ctx) — two calls produce identical bytes.
 *
 * ── evaluate() / assertSafeIdentifier facts the implementer must mirror ────
 *
 * From packages/engine/src/generator/planner.ts:
 * - `const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;` and
 *   `assertSafeIdentifier` throws:
 *   `Refusing to generate tests: ${what} "${name}" is not a valid JS
 *   identifier (must match /^[A-Za-z_$][A-Za-z0-9_$]*$/)`.
 * - `evaluate()` fieldRef resolution order is params → post → pre (Center W3
 *   DbC post-state resolution); `old` resolves against `env.pre` ONLY.
 * - `evaluate()` `==` is `left === right` and `!=` is `left !== right` —
 *   STRICT, which is exactly why the codegen emits `===`/`!==` (design
 *   decision #2).
 * - `evaluate()` `in` semantics: `Array.isArray(right) && right.some(member =>
 *   member === left)` — strict membership over the literal list.
 * - `evaluate()` relational ops (`<` `<=` `>` `>=`) require BOTH operands to
 *   be numbers, else they return undefined (falsy).
 * - `evaluate()` arithmetic requires BOTH operands to be numbers; `/` with a
 *   zero right operand returns undefined (falsy).
 * - `evaluate()` and/or use JS short-circuit `&&`/`||`; `not` is `!`.
 * - predicateCall is NOT computable at planning time (evaluate returns
 *   undefined) — the oracle defers to the real registered predicate function
 *   at runtime, which is why the emitted code references the import.
 *
 * ── Flagged divergences between emitted JS and evaluate() (Center W2/W3) ───
 *
 * The emitted oracle is a JS expression and JS coercions surface in two
 * places evaluate()'s type-guarded branches do not:
 * - W2 STRING COERCION IN ARITHMETIC (`+ - * /`): evaluate() returns
 *   undefined unless BOTH operands are numbers; the emitted JS coerces —
 *   `price + 5` with a string price yields the concatenation `"<price>5"`
 *   and `"5" - 2` yields 3. A string-typed field ref in an arithmetic clause
 *   therefore diverges (truthy vs falsy). The planner only PBT-plans
 *   numeric-shape clauses, but any contract clause can be codegen'd.
 * - W3 RELATIONAL DIVISOR-ZERO TRUTH FLIP: evaluate() `/` returns undefined
 *   for a zero right operand (falsy), while the emitted JS `x / 0` yields
 *   `Infinity`. So `total / 0 > 5` is falsy under evaluate() (undefined > 5
 *   → undefined) but `Infinity > 5` → true in the emitted oracle — a truth
 *   flip. The planner never plans a divisor-zero clause for PBT, but the
 *   emitted JS is not byte-faithful to evaluate() on that input.
 */

/** The planner's identifier rule — the implementer's renderer must assert it. */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Parses a fixture expr with the real parser so fixtures are proven grammar
 * (frozen AST node set, build-spec §4.3). Throws only on a fixture-authoring
 * error — never a renderer behaviour.
 */
function parseExpr(expr: string, kind: ClauseKind = "preconditions"): Node {
	const result = parseExpression(expr, kind, "codegen.fixture");
	// Narrow on the `errors` property rather than `!result.ok`: under the
	// non-strict tsc flags (no --strictNullChecks) TS inverts the `ok`
	// discriminant narrowing, so `result.errors` after `!result.ok` fails to
	// type-check — the same quirk behind the pre-existing TS2339s at
	// parser.ts:827 and workspace.ts:665. Property-presence narrowing is
	// discriminant-independent and holds in both modes.
	if ("errors" in result) {
		throw new Error(
			`fixture parse failed for ${expr}: ${JSON.stringify(result.errors)}`,
		);
	}
	return result.ast;
}

/** A happy-path fixture: expr → byte-pinned arrow-function output. */
type Fixture = {
	name: string;
	expr: string;
	expected: string;
	kind?: ClauseKind;
	ctx?: CodegenContext;
};

/** Byte-pinned fixtures — one per AST node type, plus compound cases. */
const FIXTURES: Fixture[] = [
	// ── literal nodes ────────────────────────────────────────────────────────
	{
		name: "literal number",
		expr: "42",
		expected: "() => 42",
	},
	{
		name: "literal string",
		expr: '"initial"',
		expected: '() => "initial"',
	},
	{
		name: "literal boolean true",
		expr: "true",
		expected: "() => true",
	},
	{
		name: "literal null",
		expr: "null",
		expected: "() => null",
	},
	{
		name: "literal list",
		expr: '["GOLD", "SILVER"]',
		expected: '() => ["GOLD", "SILVER"]',
	},
	// ── fieldRef nodes ───────────────────────────────────────────────────────
	{
		name: "fieldRef single segment",
		expr: "active",
		expected: "(active) => active",
	},
	{
		name: "fieldRef dotted suffix",
		expr: "user.age",
		expected: "(user) => user.age",
	},
	{
		name: "fieldRef numeric index suffix",
		expr: "items[0]",
		expected: "(items) => items[0]",
	},
	// ── arithmetic nodes ─────────────────────────────────────────────────────
	{
		name: "arithmetic +",
		expr: "price + 5",
		expected: "(price) => price + 5",
	},
	{
		name: "arithmetic -",
		expr: "balance - amount",
		expected: "(balance, amount) => balance - amount",
	},
	{
		name: "arithmetic *",
		expr: "price * 2",
		expected: "(price) => price * 2",
	},
	{
		name: "arithmetic /",
		expr: "total / 2",
		expected: "(total) => total / 2",
	},
	// ── comparison nodes ─────────────────────────────────────────────────────
	{
		name: "compare == (strict, Center W1)",
		expr: 'status == "ok"',
		expected: '(status) => status === "ok"',
	},
	{
		name: "compare != (strict, Center W1)",
		expr: 'status != "ok"',
		expected: '(status) => status !== "ok"',
	},
	{
		name: "compare <",
		expr: "amount < 100",
		expected: "(amount) => amount < 100",
	},
	{
		name: "compare <=",
		expr: "amount <= 100",
		expected: "(amount) => amount <= 100",
	},
	{
		name: "compare >",
		expr: "amount > 0",
		expected: "(amount) => amount > 0",
	},
	{
		name: "compare >=",
		expr: "amount >= 10",
		expected: "(amount) => amount >= 10",
	},
	{
		name: "compare in (literal list → strict OR chain)",
		expr: 'tier in ["GOLD", "SILVER"]',
		expected: '(tier) => tier === "GOLD" || tier === "SILVER"',
	},
	{
		name: "compare in (empty literal list → always-false identity)",
		expr: "tier in []",
		expected: "(tier) => false",
	},
	// ── logical nodes ────────────────────────────────────────────────────────
	{
		name: "and",
		expr: "a > 0 and b > 0",
		expected: "(a, b) => a > 0 && b > 0",
	},
	{
		name: "or",
		expr: "a > 0 or b > 0",
		expected: "(a, b) => a > 0 || b > 0",
	},
	{
		name: "not of comparison (parens required, strict operand)",
		expr: "not amount == 0",
		expected: "(amount) => !(amount === 0)",
	},
	{
		name: "not of arithmetic comparison (parens required, parser-reachable)",
		expr: "not a + 1 == 2",
		expected: "(a) => !(a + 1 === 2)",
	},
	{
		name: "not of fieldRef primary (no parens)",
		expr: "not active",
		expected: "(active) => !active",
	},
	// ── old(field) — postconditions only, resolves against captured pre-state ─
	{
		name: "old(field) inside arithmetic postcondition",
		expr: "balance == old(balance) - amount",
		expected:
			"(balance, amount, preState) => balance === preState.balance - amount",
		kind: "postconditions",
	},
	{
		name: "old(field) with custom preStateName",
		expr: "balance == old(balance)",
		expected: "(balance, before) => balance === before.balance",
		kind: "postconditions",
		ctx: { preStateName: "before" },
	},
	{
		name: "old(field) with numeric index suffix",
		expr: "old(items[0])",
		expected: "(preState) => preState.items[0]",
		kind: "postconditions",
	},
	// ── predicateCall — resolves to the imported registered predicate ───────
	{
		name: "predicateCall single arg",
		expr: "isPositive(amount)",
		expected: "(amount) => isPositive(amount)",
		ctx: { predicates: { isPositive: "./predicates.js" } },
	},
	{
		name: "predicateCall multi arg",
		expr: "between(amount, 0, 1000)",
		expected: "(amount) => between(amount, 0, 1000)",
		ctx: { predicates: { between: "./predicates.js" } },
	},
	// ── the flagship compound case ───────────────────────────────────────────
	{
		name: "compound precondition (flagship)",
		expr: "amount >= 0 and amount <= 1000",
		expected: "(amount) => amount >= 0 && amount <= 1000",
	},
	// ── identifier renames ───────────────────────────────────────────────────
	{
		name: "param rename via ctx.paramNames",
		expr: "amount >= 10",
		expected: "(a) => a >= 10",
		ctx: { paramNames: { amount: "a" } },
	},
];

describe("renderClausePredicate — byte-pinned per-node fixtures (build-spec §9.6)", () => {
	for (const fixture of FIXTURES) {
		it(`${fixture.name}: "${fixture.expr}" → ${fixture.expected}`, () => {
			const ast = parseExpr(fixture.expr, fixture.kind ?? "preconditions");
			expect(renderClausePredicate(ast, fixture.ctx)).toBe(fixture.expected);
		});
	}
});

describe("renderClausePredicate — compound / structural correctness", () => {
	it("the flagship compound precondition pins the exact bytes the PBT oracle needs", () => {
		const ast = parseExpr("amount >= 0 and amount <= 1000");
		expect(renderClausePredicate(ast)).toBe(
			"(amount) => amount >= 0 && amount <= 1000",
		);
	});

	it("a `not` of a compound and operand parenthesizes the whole operand (JS ! binds tighter than &&)", () => {
		// The grammar cannot produce `not (a and b)` (not applies to a
		// comparison), so this AST is hand-built. `!a > 0 && b > 0` would
		// parse as `(!a) > 0 && b > 0` in JS — the emitted bytes MUST be
		// `!(...)` to preserve the AST's semantics.
		const ast: Node = {
			type: "not",
			operand: {
				type: "and",
				left: {
					type: "compare",
					op: ">",
					left: { type: "fieldRef", path: ["a"] },
					right: { type: "literal", value: 0 },
				},
				right: {
					type: "compare",
					op: ">",
					left: { type: "fieldRef", path: ["b"] },
					right: { type: "literal", value: 0 },
				},
			},
		};
		expect(renderClausePredicate(ast)).toBe("(a, b) => !(a > 0 && b > 0)");
	});

	it("`%` (modulo) is handled defensively even though the parser's ArithOp set is + - * / only", () => {
		// Flagged ambiguity: the task brief lists % but packages/core/src/core/parser.ts
		// ArithOp = "+" | "-" | "*" | "/" — % is unreachable via parseExpression.
		// The renderer is total over Node and must still emit it deterministically.
		// The `as ArithOp` is deliberate: this hand-built AST exercises a value the
		// parser's type can never produce (defensive totalness, not a parser lie).
		const ast: Node = {
			type: "arithmetic",
			op: "%" as ArithOp,
			left: { type: "fieldRef", path: ["a"] },
			right: { type: "literal", value: 2 },
		};
		expect(renderClausePredicate(ast)).toBe("(a) => a % 2");
	});

	it("emits predicate calls referencing the imported predicate function name", () => {
		const ast = parseExpr("isPositive(amount)");
		const code = renderClausePredicate(ast, {
			predicates: { isPositive: "./predicates.js" },
		});
		// The emitted call references the predicate by its name — the generated
		// test imports `{ isPositive }` from the ctx.predicates specifier.
		expect(code).toBe("(amount) => isPositive(amount)");
		expect(code).toContain("isPositive(");
		// Resolvability: the referenced name is present in the import table.
		expect(IDENTIFIER_RE.test("isPositive")).toBe(true);
	});

	it("the emitted code for a compound predicate-call clause is side-effect-free by source inspection", () => {
		const ast = parseExpr(
			"amount >= 0 and amount <= 1000 and amount == 10 and isPositive(amount)",
		);
		const code = renderClausePredicate(ast, {
			predicates: { isPositive: "./predicates.js" },
		});
		expect(code).toBe(
			"(amount) => amount >= 0 && amount <= 1000 && amount === 10 && isPositive(amount)",
		);
		// No function declarations.
		expect(code).not.toMatch(/\bfunction\b/);
		// No assignment `=` — the no-assignment regex must allow the strict
		// lexemes `===`/`!==` (which contain `==`) plus `>=`, `<=`, and `=>`,
		// while still rejecting a standalone `=` assignment. The emitted
		// compound above contains `===`, `>=`, `<=`, and `=>` — proving the
		// regex tolerates every legal `=` occurrence.
		expect(code).not.toMatch(/(?<![=!<>])=(?!=|>)/);
		// Negative control: the same regex still FIRES on a real assignment.
		expect("(x) => x = 1").toMatch(/(?<![=!<>])=(?!=|>)/);
		// No method calls (no `.name(` pattern) and no built-in collection
		// helpers — the only call is the predicate call itself.
		expect(code).not.toMatch(/\.\w+\s*\(/);
		expect(code).not.toMatch(
			/(?:includes|some|map|filter|reduce|forEach)\s*\(/,
		);
		// The single predicate call is present and resolves.
		expect(code).toMatch(/isPositive\(amount\)/);
	});
});

describe("renderClausePredicate — identifier safety (mirrors planner assertSafeIdentifier)", () => {
	it("refuses a fieldRef root that is not a safe JS identifier — non-silent, never broken JS", () => {
		// The parser can never produce this root (identifiers are lexed as
		// /^[A-Za-z_][A-Za-z0-9_]*$/), but the renderer is a function of a Node
		// and a hostile/hand-built AST must be refused, not emitted verbatim.
		const ast: Node = { type: "fieldRef", path: ["bad-name"] };
		expect(() => renderClausePredicate(ast)).toThrow(
			/not a valid JS identifier/,
		);
	});

	it("refuses an unsafe predicate name with the assertSafeIdentifier failure mode", () => {
		const ast: Node = { type: "predicateCall", name: "bad name", args: [] };
		expect(() => renderClausePredicate(ast)).toThrow(
			/not a valid JS identifier/,
		);
	});

	it("refuses a predicate call whose name is not in the import table — the emitted reference would be unresolvable", () => {
		const ast = parseExpr("isPositive(amount)");
		// No ctx.predicates entry: the generated test could not import
		// isPositive, so the emitted call would be broken JS.
		expect(() => renderClausePredicate(ast)).toThrow(/isPositive/);
	});

	it("refuses an unsafe preStateName", () => {
		const ast = parseExpr("balance == old(balance)", "postconditions");
		expect(() =>
			renderClausePredicate(ast, { preStateName: "pre state" }),
		).toThrow(/not a valid JS identifier/);
	});

	it("refuses a paramNames rename that collides two roots onto one parameter", () => {
		// Deterministic renames only: mapping both `a` and `b` to `x` would
		// emit `(x, x) => ...` — a duplicate parameter name, broken JS. The
		// renderer must refuse, never silently emit.
		const ast = parseExpr("a > 0 and b > 0");
		expect(() =>
			renderClausePredicate(ast, { paramNames: { a: "x", b: "x" } }),
		).toThrow(/already used by another fieldRef root/);
	});

	it("refuses a preStateName that collides with a fieldRef parameter", () => {
		// `balance == old(balance)` registers `balance` as a parameter; naming
		// the pre-state object `balance` too would emit `(balance, balance)`.
		const ast = parseExpr("balance == old(balance)", "postconditions");
		expect(() =>
			renderClausePredicate(ast, { preStateName: "balance" }),
		).toThrow(/collides with a fieldRef parameter/);
	});
});

describe("renderClausePredicate — flagged ambiguities are non-silent", () => {
	it("refuses the `[]` wildcard path segment — no concrete JS access exists for 'any element'", () => {
		// `items[]` is parser-producible (FieldPath ["items", "[]"]) but no
		// property access string can mean "every element" — silently emitting
		// one would be broken JS.
		const ast = parseExpr("items[]");
		expect(() => renderClausePredicate(ast)).toThrow(/\[\]/);
	});

	it("refuses `in` with a non-literal-list right side — rendering it would require a method call", () => {
		// The grammar allows `x in y` (right side a fieldRef); the planner's
		// classifyClause only supports literal-list rights. A method call
		// (e.g. y.includes(x)) would violate the side-effect-free contract.
		const ast = parseExpr("x in y");
		expect(() => renderClausePredicate(ast)).toThrow(/literal/);
	});

	it("refuses a hostile hand-built AST with an unknown node type — never silently emits broken JS", () => {
		// renderNode is total over the frozen Node union; a type outside it
		// must surface a non-silent error, not fall through to garbage output.
		const ast = { type: "mystery", payload: 1 } as unknown as Node;
		expect(() => renderClausePredicate(ast)).toThrow(
			/unknown clause node type/,
		);
	});

	it("refuses a literal with a non-null object value — the literal grammar has no object values", () => {
		// typeof null === "object" is the only object-shaped literal value; a
		// hostile hand-built AST with a real object cannot render to a JS
		// literal, so codegen refuses rather than emit garbage.
		const ast = { type: "literal", value: { nested: true } } as unknown as Node;
		expect(() => renderClausePredicate(ast)).toThrow(
			/unsupported literal value of type object/,
		);
	});

	it("refuses a fieldRef path segment that is `__proto__` — prototype-chain / pollution access surface", () => {
		// `__proto__` passes IDENTIFIER_RE but a dotted `.__proto__` access in
		// emitted JS is a prototype-chain / pollution surface (e.g.
		// `preState.__proto__.x`). The renderer must refuse it non-silently,
		// like the `[]` wildcard. Parser-reachable: `user.__proto__` lexes as
		// two identifiers.
		const ast = parseExpr("user.__proto__");
		expect(() => renderClausePredicate(ast)).toThrow(/__proto__/);
	});
});

describe("renderClausePredicate — determinism (ADR-0002)", () => {
	it("two calls over the same AST + ctx produce identical bytes", () => {
		const ast = parseExpr("amount >= 0 and amount <= 1000");
		const ctx: CodegenContext = {
			predicates: { isPositive: "./predicates.js" },
		};
		expect(renderClausePredicate(ast, ctx)).toBe(
			renderClausePredicate(ast, ctx),
		);
	});
});

describe("renderClausePredicate — generator barrel re-export (index.ts)", () => {
	it("is re-exported from the generator barrel for public-surface consistency", async () => {
		// The direct import (top of this file) is the primary contract; this
		// pins the barrel wiring so the planner/emitter can reach the renderer
		// through the same public surface as derivePropertySeed.
		const barrel = await import("../packages/engine/src/generator/index.js");
		expect(typeof barrel.renderClausePredicate).toBe("function");
		const ast = parseExpr("amount >= 10");
		expect(barrel.renderClausePredicate(ast)).toBe("(amount) => amount >= 10");
	});
});
