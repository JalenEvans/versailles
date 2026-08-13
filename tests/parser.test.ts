import { describe, expect, it } from "vitest";

import { parseExpression } from "../src/core/parser.js";

/**
 * Parser contract — pinned against build-spec §4.1–§4.4.
 *
 * The parser is the validation kernel of the contract-language bounded
 * context; these tests freeze the grammar (build-spec §4.1), the structural
 * constraints enforced by the parser (§4.2), the AST node set (§4.3), and the
 * structured error contract (§4.4). The parser NEVER throws an unstructured
 * exception on malformed input — it always returns a typed union result.
 *
 * ── Module contract ────────────────────────────────────────────────────────
 *
 * Module: src/core/parser.ts
 * Export: parseExpression(input: string, clauseKind: ClauseKind, contractId: string): ParseResult
 *
 * ```ts
 * export type ClauseKind = "preconditions" | "postconditions" | "invariants";
 *
 * export type CompOp = "==" | "!=" | ">" | ">=" | "<" | "<=" | "in";
 * export type ArithOp = "+" | "-" | "*" | "/";
 *
 * export type FieldPath = (string | number | "[]")[];
 * export type LiteralList = (string | number | boolean | null)[];
 *
 * export type Node =
 *   | { type: "or"; left: Node; right: Node }
 *   | { type: "and"; left: Node; right: Node }
 *   | { type: "not"; operand: Node }
 *   | { type: "compare"; op: CompOp; left: Node; right: Node }
 *   | { type: "arithmetic"; op: ArithOp; left: Node; right: Node }
 *   | { type: "old"; ref: { type: "fieldRef"; path: FieldPath } }
 *   | { type: "predicateCall"; name: string; args: Node[] }
 *   | { type: "fieldRef"; path: FieldPath }
 *   | { type: "literal"; value: string | number | boolean | null | LiteralList };
 *
 * export type ParseError = {
 *   contractId: string; // echoed verbatim from the parseExpression argument
 *   field: string;      // the clauseKind argument string ("preconditions" |
 *                       // "postconditions" | "invariants"). The entry index
 *                       // (e.g. "postconditions[0]") is a loader (§6) concern:
 *                       // the standalone parser does not receive an entry index.
 *   position: number;   // 0-based character offset of the offending token
 *   found: string;      // the token found at that offset ("" at end of input)
 *   expected: string[]; // nonempty expected alternatives
 *   message: string;    // human-readable, never empty
 * };
 *
 * export type ParseResult =
 *   | { ok: true; ast: Node }
 *   | { ok: false; errors: ParseError[] };
 *
 * export declare function parseExpression(
 *   input: string,
 *   clauseKind: ClauseKind,
 *   contractId: string,
 * ): ParseResult;
 * ```
 *
 * ── Ambiguities resolved by these tests ────────────────────────────────────
 *
 * 1. Precedence (tightest first): arithmetic > comparison > not > and > or.
 *    - "a or b and c"  = or(a, and(b, c))   (and binds tighter than or)
 *    - "not a == b"    = not(compare a == b) (not_expr := "not"? comparison,
 *      so `not` applies to the following comparison, which binds tighter)
 *    - "a == b or c == d" = or(compare, compare)
 * 2. Bare terms: `comparison := term (comp_op term)?` makes the comp_op
 *    optional, so a bare term is a valid expression. "available" parses to a
 *    fieldRef node directly (NOT an implicit compare == true), and
 *    "not available" = not(fieldRef available).
 * 3. Unary minus is NOT in the grammar (term starts only at literal /
 *    predicate_call / old / field_ref). "-total" is a parse error at
 *    position 0 with found "-".
 * 4. No grouping parens in the grammar: a leading "(" is a parse error at
 *    position 0, found "(".
 * 5. Numbers are unsigned literals ("-" is a binary arithmetic operator).
 * 6. List literals parse to a literal node whose value is a plain array of
 *    literal values: { type: "literal", value: ["OPEN", "SHIPPED"] }.
 * 7. Field paths: dotted segments are strings, "[N]" indexes are numbers,
 *    and "[]" is the literal string "[]" ("items[]" -> ["items", "[]"]).
 * 8. Every error carries field = clauseKind argument (see ParseError above).
 * 9. old(...) is accepted ONLY when clauseKind is "postconditions"; in
 *    "preconditions" / "invariants" it is a structured parse error with
 *    position > 0 and found matching /old/ (build-spec §4.2, rejected at
 *    parse time, before semantic validation).
 * 10. Arithmetic binds tighter than comparison and is left-associative across
 *     two precedence levels: `*` and `/` group tighter than `+` and `-`, and
 *     each level folds left. "a - b - c" = arithmetic(-, arithmetic(-, a, b),
 *     c), never arithmetic(-, a, arithmetic(-, b, c)); "a * b + c" =
 *     arithmetic(+, arithmetic(*, a, b), c), never arithmetic(*, a,
 *     arithmetic(+, b, c)).
 */

const PRE_ID = "OrderService.placeOrder.pre0";
const POST_ID = "OrderService.placeOrder.post0";
const INV_ID = "OrderService.inv0";

type ErrorShape = {
	contractId: string;
	field: string;
	position: number;
	found: string;
	expected: string[];
	message: string;
};

/**
 * Asserts the build-spec §4.4 error envelope shared by every failure path:
 * ok:false, exactly one error, and that error carries the echoed contractId,
 * the clauseKind as field, a numeric position, a nonempty expected list, and
 * a nonempty message. Callers then assert the token-specific details.
 */
function assertParseErrorShape(
	result: { ok: true; ast: unknown } | { ok: false; errors: ErrorShape[] },
	contractId: string,
	clauseKind: string,
): void {
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.errors).toHaveLength(1);
	const error = result.errors[0];
	expect(error.contractId).toBe(contractId);
	expect(error.field).toBe(clauseKind);
	expect(typeof error.position).toBe("number");
	expect(error.expected.length).toBeGreaterThan(0);
	expect(error.message.length).toBeGreaterThan(0);
}

describe("parseExpression — module contract: never throws, always structured", () => {
	it("returns ok:false (never throws) for a battery of malformed inputs", () => {
		const nastyInputs = ["=", "==", "[", "]", "not", "old(", "a =", "1 2"];

		for (const input of nastyInputs) {
			expect(() =>
				parseExpression(input, "preconditions", PRE_ID),
			).not.toThrow();
			const result = parseExpression(input, "preconditions", PRE_ID);
			expect(result.ok).toBe(false);
		}
	});
});

describe("parseExpression — pathological battery (B1: never throws, build-spec §4.4)", () => {
	const arithmeticChain = (terms: number): string =>
		`${Array.from({ length: terms }, () => "a +").join(" ")} a`;
	const nestedPredicate = (depth: number): string =>
		`${"f(".repeat(depth)}a${")".repeat(depth)}`;
	const orChain = (terms: number): string =>
		`${Array.from({ length: terms }, () => "a or").join(" ")} a`;

	/**
	 * The build-spec §4.4 "never throws" pin for the pathological battery: the
	 * call must return a structured ParseResult — either ok:true with an AST,
	 * or ok:false with a nonempty errors array (the depth guard's structured
	 * error). A thrown unstructured exception — the B1 crash class, a
	 * RangeError stack overflow on deep recursion — fails the test at the
	 * not.toThrow() guard.
	 */
	function assertNeverThrows(input: string): void {
		let result: ReturnType<typeof parseExpression> | undefined;
		expect(() => {
			result = parseExpression(input, "preconditions", PRE_ID);
		}).not.toThrow();
		expect(result).toBeDefined();
		if (result?.ok === false) {
			expect(result.errors.length).toBeGreaterThan(0);
		}
	}

	it('never throws on a 2000-term arithmetic chain "a + a + ... + a"', () => {
		assertNeverThrows(arithmeticChain(2000));
	});

	it('never throws on a 5000-term arithmetic chain "a + a + ... + a"', () => {
		assertNeverThrows(arithmeticChain(5000));
	});

	it('never throws on a 20000-term arithmetic chain "a + a + ... + a" (pre-fix crash class)', () => {
		assertNeverThrows(arithmeticChain(20000));
	});

	it('never throws on 1000-deep nested predicate calls "f(f(...(a)...))"', () => {
		assertNeverThrows(nestedPredicate(1000));
	});

	it('never throws on a 20000-deep nested predicate call chain "f(f(...(a)...))" (pre-fix crash class)', () => {
		assertNeverThrows(nestedPredicate(20000));
	});

	it('never throws on a 2000-term "a or a or ... or a" chain', () => {
		assertNeverThrows(orChain(2000));
	});
});

describe("parseExpression — comparisons (build-spec §4.1, §4.3)", () => {
	it('parses "balance >= 0" to a compare node (op >=, fieldRef left, literal right)', () => {
		expect(parseExpression("balance >= 0", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "compare",
				op: ">=",
				left: { type: "fieldRef", path: ["balance"] },
				right: { type: "literal", value: 0 },
			},
		});
	});

	it('parses "name == \\"open\\"" with a string literal operand', () => {
		expect(parseExpression('name == "open"', "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "compare",
				op: "==",
				left: { type: "fieldRef", path: ["name"] },
				right: { type: "literal", value: "open" },
			},
		});
	});

	it('parses "value != null" with a null literal operand', () => {
		expect(parseExpression("value != null", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "compare",
				op: "!=",
				left: { type: "fieldRef", path: ["value"] },
				right: { type: "literal", value: null },
			},
		});
	});

	it('parses "5 < 10" with number literals on both sides', () => {
		expect(parseExpression("5 < 10", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "compare",
				op: "<",
				left: { type: "literal", value: 5 },
				right: { type: "literal", value: 10 },
			},
		});
	});

	it('parses "isClosed == false" with a false literal operand', () => {
		expect(
			parseExpression("isClosed == false", "preconditions", PRE_ID),
		).toEqual({
			ok: true,
			ast: {
				type: "compare",
				op: "==",
				left: { type: "fieldRef", path: ["isClosed"] },
				right: { type: "literal", value: false },
			},
		});
	});

	it('parses "enabled == true" with a true literal operand', () => {
		expect(parseExpression("enabled == true", "preconditions", PRE_ID)).toEqual(
			{
				ok: true,
				ast: {
					type: "compare",
					op: "==",
					left: { type: "fieldRef", path: ["enabled"] },
					right: { type: "literal", value: true },
				},
			},
		);
	});

	it('parses "status in [\\"OPEN\\", \\"SHIPPED\\"]" with a list_literal right side', () => {
		expect(
			parseExpression('status in ["OPEN", "SHIPPED"]', "preconditions", PRE_ID),
		).toEqual({
			ok: true,
			ast: {
				type: "compare",
				op: "in",
				left: { type: "fieldRef", path: ["status"] },
				right: { type: "literal", value: ["OPEN", "SHIPPED"] },
			},
		});
	});
});

describe("parseExpression — field paths (build-spec §4.1 field_ref)", () => {
	it('parses "order.total > 0" with a nested dotted path', () => {
		expect(parseExpression("order.total > 0", "preconditions", PRE_ID)).toEqual(
			{
				ok: true,
				ast: {
					type: "compare",
					op: ">",
					left: { type: "fieldRef", path: ["order", "total"] },
					right: { type: "literal", value: 0 },
				},
			},
		);
	});

	it('parses "items[0].price >= 0" with a numeric index segment', () => {
		expect(
			parseExpression("items[0].price >= 0", "preconditions", PRE_ID),
		).toEqual({
			ok: true,
			ast: {
				type: "compare",
				op: ">=",
				left: { type: "fieldRef", path: ["items", 0, "price"] },
				right: { type: "literal", value: 0 },
			},
		});
	});

	it('parses "items[] != null" with a "[]" wildcard segment', () => {
		expect(parseExpression("items[] != null", "preconditions", PRE_ID)).toEqual(
			{
				ok: true,
				ast: {
					type: "compare",
					op: "!=",
					left: { type: "fieldRef", path: ["items", "[]"] },
					right: { type: "literal", value: null },
				},
			},
		);
	});
});

describe("parseExpression — arithmetic (build-spec §4.1 arithmetic)", () => {
	it('parses "total - discount > 0" with an arithmetic left side', () => {
		expect(
			parseExpression("total - discount > 0", "preconditions", PRE_ID),
		).toEqual({
			ok: true,
			ast: {
				type: "compare",
				op: ">",
				left: {
					type: "arithmetic",
					op: "-",
					left: { type: "fieldRef", path: ["total"] },
					right: { type: "fieldRef", path: ["discount"] },
				},
				right: { type: "literal", value: 0 },
			},
		});
	});

	it('parses "a - b - c" as left-associative: ((a - b) - c)', () => {
		expect(parseExpression("a - b - c", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "arithmetic",
				op: "-",
				left: {
					type: "arithmetic",
					op: "-",
					left: { type: "fieldRef", path: ["a"] },
					right: { type: "fieldRef", path: ["b"] },
				},
				right: { type: "fieldRef", path: ["c"] },
			},
		});
	});

	it('parses "a - b + c" as left-associative: ((a - b) + c)', () => {
		expect(parseExpression("a - b + c", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "arithmetic",
				op: "+",
				left: {
					type: "arithmetic",
					op: "-",
					left: { type: "fieldRef", path: ["a"] },
					right: { type: "fieldRef", path: ["b"] },
				},
				right: { type: "fieldRef", path: ["c"] },
			},
		});
	});

	it('parses "a + b * c" with * binding tighter than +', () => {
		expect(parseExpression("a + b * c", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "arithmetic",
				op: "+",
				left: { type: "fieldRef", path: ["a"] },
				right: {
					type: "arithmetic",
					op: "*",
					left: { type: "fieldRef", path: ["b"] },
					right: { type: "fieldRef", path: ["c"] },
				},
			},
		});
	});

	it('parses "a * b + c" with the * group folded before +', () => {
		expect(parseExpression("a * b + c", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "arithmetic",
				op: "+",
				left: {
					type: "arithmetic",
					op: "*",
					left: { type: "fieldRef", path: ["a"] },
					right: { type: "fieldRef", path: ["b"] },
				},
				right: { type: "fieldRef", path: ["c"] },
			},
		});
	});

	it('parses "a + b" to an arithmetic node with op "+"', () => {
		expect(parseExpression("a + b", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "arithmetic",
				op: "+",
				left: { type: "fieldRef", path: ["a"] },
				right: { type: "fieldRef", path: ["b"] },
			},
		});
	});

	it('parses "a * b" to an arithmetic node with op "*"', () => {
		expect(parseExpression("a * b", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "arithmetic",
				op: "*",
				left: { type: "fieldRef", path: ["a"] },
				right: { type: "fieldRef", path: ["b"] },
			},
		});
	});

	it('parses "a / b" to an arithmetic node with op "/"', () => {
		expect(parseExpression("a / b", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "arithmetic",
				op: "/",
				left: { type: "fieldRef", path: ["a"] },
				right: { type: "fieldRef", path: ["b"] },
			},
		});
	});
});

describe("parseExpression — predicate calls (build-spec §4.1, §4.2)", () => {
	it('parses "isAvailable(order)" with one argument', () => {
		expect(
			parseExpression("isAvailable(order)", "preconditions", PRE_ID),
		).toEqual({
			ok: true,
			ast: {
				type: "predicateCall",
				name: "isAvailable",
				args: [{ type: "fieldRef", path: ["order"] }],
			},
		});
	});

	it('parses "isAvailable(order, threshold)" with multiple arguments', () => {
		expect(
			parseExpression("isAvailable(order, threshold)", "preconditions", PRE_ID),
		).toEqual({
			ok: true,
			ast: {
				type: "predicateCall",
				name: "isAvailable",
				args: [
					{ type: "fieldRef", path: ["order"] },
					{ type: "fieldRef", path: ["threshold"] },
				],
			},
		});
	});
});

describe("parseExpression — boolean combinators & precedence", () => {
	it('parses "balance > 0 and balance < 1000" to an and of two compares', () => {
		expect(
			parseExpression(
				"balance > 0 and balance < 1000",
				"preconditions",
				PRE_ID,
			),
		).toEqual({
			ok: true,
			ast: {
				type: "and",
				left: {
					type: "compare",
					op: ">",
					left: { type: "fieldRef", path: ["balance"] },
					right: { type: "literal", value: 0 },
				},
				right: {
					type: "compare",
					op: "<",
					left: { type: "fieldRef", path: ["balance"] },
					right: { type: "literal", value: 1000 },
				},
			},
		});
	});

	it('parses "not available" as not over a bare comparison (fieldRef operand)', () => {
		expect(parseExpression("not available", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "not",
				operand: { type: "fieldRef", path: ["available"] },
			},
		});
	});

	it('parses a bare term "available" directly as a fieldRef node', () => {
		expect(parseExpression("available", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: { type: "fieldRef", path: ["available"] },
		});
	});

	it('parses "a or b and c" with and binding tighter than or', () => {
		expect(parseExpression("a or b and c", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "or",
				left: { type: "fieldRef", path: ["a"] },
				right: {
					type: "and",
					left: { type: "fieldRef", path: ["b"] },
					right: { type: "fieldRef", path: ["c"] },
				},
			},
		});
	});

	it('parses "not a == b" with not applying to the whole comparison', () => {
		expect(parseExpression("not a == b", "preconditions", PRE_ID)).toEqual({
			ok: true,
			ast: {
				type: "not",
				operand: {
					type: "compare",
					op: "==",
					left: { type: "fieldRef", path: ["a"] },
					right: { type: "fieldRef", path: ["b"] },
				},
			},
		});
	});

	it('parses "a == b or c == d" as an or of two compares', () => {
		expect(
			parseExpression("a == b or c == d", "preconditions", PRE_ID),
		).toEqual({
			ok: true,
			ast: {
				type: "or",
				left: {
					type: "compare",
					op: "==",
					left: { type: "fieldRef", path: ["a"] },
					right: { type: "fieldRef", path: ["b"] },
				},
				right: {
					type: "compare",
					op: "==",
					left: { type: "fieldRef", path: ["c"] },
					right: { type: "fieldRef", path: ["d"] },
				},
			},
		});
	});
});

describe("parseExpression — old() scope (build-spec §4.2)", () => {
	it('accepts "old(balance) > 0" when clauseKind is "postconditions"', () => {
		expect(
			parseExpression("old(balance) > 0", "postconditions", POST_ID),
		).toEqual({
			ok: true,
			ast: {
				type: "compare",
				op: ">",
				left: {
					type: "old",
					ref: { type: "fieldRef", path: ["balance"] },
				},
				right: { type: "literal", value: 0 },
			},
		});
	});

	it('rejects "old(balance) > 0" when clauseKind is "preconditions"', () => {
		const result = parseExpression("old(balance) > 0", "preconditions", PRE_ID);
		assertParseErrorShape(result, PRE_ID, "preconditions");
		if (result.ok) return;
		expect(result.errors[0].position).toBeGreaterThan(0);
		expect(result.errors[0].found).toMatch(/old/);
	});

	it('rejects "old(balance) > 0" when clauseKind is "invariants"', () => {
		const result = parseExpression("old(balance) > 0", "invariants", INV_ID);
		assertParseErrorShape(result, INV_ID, "invariants");
		if (result.ok) return;
		expect(result.errors[0].position).toBeGreaterThan(0);
		expect(result.errors[0].found).toMatch(/old/);
	});
});

describe("parseExpression — out-of-grammar rejection (build-spec §4.2, §4.4)", () => {
	it('rejects the assignment "balance = 0" (single "=" is not "==")', () => {
		const result = parseExpression("balance = 0", "preconditions", PRE_ID);
		assertParseErrorShape(result, PRE_ID, "preconditions");
		if (result.ok) return;
		expect(result.errors[0].found).toBe("=");
		expect(result.errors[0].expected).toEqual(expect.arrayContaining(["=="]));
	});

	it('rejects the loop "for i in items return i" at the token after the first term', () => {
		const result = parseExpression(
			"for i in items return i",
			"preconditions",
			PRE_ID,
		);
		assertParseErrorShape(result, PRE_ID, "preconditions");
		if (result.ok) return;
		expect(result.errors[0].found).toBe("i");
	});

	it('rejects a stray token "balance > 0 garbage"', () => {
		const result = parseExpression(
			"balance > 0 garbage",
			"preconditions",
			PRE_ID,
		);
		assertParseErrorShape(result, PRE_ID, "preconditions");
		if (result.ok) return;
		expect(result.errors[0].found).toBe("garbage");
	});

	it('rejects unbalanced parens "(balance > 0" (no grouping parens in the grammar)', () => {
		const result = parseExpression("(balance > 0", "preconditions", PRE_ID);
		assertParseErrorShape(result, PRE_ID, "preconditions");
		if (result.ok) return;
		expect(result.errors[0].position).toBe(0);
		expect(result.errors[0].found).toBe("(");
	});

	it('rejects an unclosed list "status in [\\"OPEN\\", \\"SHIPPED\\""', () => {
		const result = parseExpression(
			'status in ["OPEN", "SHIPPED"',
			"preconditions",
			PRE_ID,
		);
		assertParseErrorShape(result, PRE_ID, "preconditions");
	});

	it('rejects the unknown comp op "balance ~ 0"', () => {
		const result = parseExpression("balance ~ 0", "preconditions", PRE_ID);
		assertParseErrorShape(result, PRE_ID, "preconditions");
		if (result.ok) return;
		expect(result.errors[0].found).toBe("~");
	});

	it('rejects empty input ""', () => {
		const result = parseExpression("", "preconditions", PRE_ID);
		assertParseErrorShape(result, PRE_ID, "preconditions");
		if (result.ok) return;
		expect(result.errors[0].position).toBe(0);
	});

	it('rejects unary minus "-total" (no unary minus in the grammar)', () => {
		const result = parseExpression("-total", "preconditions", PRE_ID);
		assertParseErrorShape(result, PRE_ID, "preconditions");
		if (result.ok) return;
		expect(result.errors[0].position).toBe(0);
		expect(result.errors[0].found).toBe("-");
	});
});
