import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseExpression } from "../src/core/parser.js";
import type { ClauseKind, Node, ParseResult } from "../src/core/parser.js";

/**
 * Parser property tests — never-throws robustness under the ADR-0010
 * untrusted-input model (build-spec §4.4).
 *
 * The parser's central invariant, pinned by the deterministic battery in
 * tests/parser.test.ts, is that parseExpression NEVER throws an unstructured
 * exception on malformed input: every failure path returns
 * `{ ok: false, errors: [ParseError] }`, and every success returns
 * `{ ok: true, ast: Node }`. Property-based tests extend that pin from a
 * fixed battery of hand-picked inputs to generated families of inputs:
 *
 * 1. Arbitrary junk strings (any character, any length).
 * 2. Structured adversarial inputs — the pre-depth-guard crash class B1:
 *    left-folded arithmetic chains, deeply nested predicate calls, and long
 *    or/and chains. These used to overflow the call stack (RangeError) before
 *    the iterative term/factor folds and the MAX_PARSE_DEPTH guard.
 * 3. The same never-throws claim across all three clauseKinds.
 * 4. Well-formed field paths (root identifier + ".ident"/"[N]"/"[]" suffixes)
 *    always parse (ok:true). Choice: assert ok:true, not just never-throw —
 *    the grammar (build-spec §4.1 field_ref) is regular for suffixes, so a
 *    well-formed path failing to parse would be a genuine bug.
 * 5. Round-trip sanity: generated well-formed boolean expressions parse into
 *    an AST whose every node is one of the frozen §4.3 node types (the
 *    "frozen AST" invariant) and which is a finite acyclic tree.
 *
 * Every property uses the standard fast-check-in-vitest pattern:
 * `fc.assert(fc.property(arb, fn), { numRuns })`. numRuns is set to 100
 * (generous for CI, still fast — the whole file runs in well under 5s).
 */

const PROP_CONTRACT_ID = "property-test.contract.0";

/**
 * Asserts the module contract on a single parse: never threw, and the result
 * is a discriminated union — exactly one of ok:true (with ast) or ok:false
 * (with a nonempty errors array of well-shaped ParseErrors).
 */
function assertStructuredResult(result: ParseResult): void {
	if (result.ok) {
		expect(typeof result.ast).toBe("object");
		return;
	}
	expect(result.errors.length).toBeGreaterThan(0);
	for (const error of result.errors) {
		expect(error.contractId).toBe(PROP_CONTRACT_ID);
		expect(typeof error.position).toBe("number");
		expect(error.expected.length).toBeGreaterThan(0);
		expect(error.message.length).toBeGreaterThan(0);
	}
}

/**
 * Runs parseExpression under a not.toThrow guard and returns the result for
 * the caller to assert on. A thrown structured exception fails the test at
 * the guard (the B1 crash class).
 */
function parseNeverThrows(input: string, clauseKind: ClauseKind): ParseResult {
	let result: ParseResult | undefined;
	expect(() => {
		result = parseExpression(input, clauseKind, PROP_CONTRACT_ID);
	}).not.toThrow();
	expect(result).toBeDefined();
	return result as ParseResult;
}

describe("parseExpression — never throws on arbitrary junk (ADR-0010)", () => {
	it("returns a discriminated union for any generated string, never throwing", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200, size: "large" }), (input) => {
				const result = parseNeverThrows(input, "preconditions");
				expect(result.ok === true || result.ok === false).toBe(true);
				assertStructuredResult(result);
			}),
			{ numRuns: 100 },
		);
	});
});

describe("parseExpression — never throws on structured adversarial inputs (B1 class)", () => {
	it("never throws on generated arithmetic chains up to 5000 terms", () => {
		const arithmeticChain = fc
			.array(fc.constantFrom("+", "-", "*", "/"), {
				minLength: 1,
				maxLength: 5000,
				size: "xlarge",
			})
			.map((ops) => `a${ops.map((op) => ` ${op} a`).join("")}`);
		fc.assert(
			fc.property(arithmeticChain, (input) => {
				assertStructuredResult(parseNeverThrows(input, "preconditions"));
			}),
			{ numRuns: 100 },
		);
	});

	it("never throws on nested predicate calls up to 1000 deep (depth guard)", () => {
		const nestedCalls = fc
			.integer({ min: 1, max: 1000 })
			.map((depth) => `${"f(".repeat(depth)}a${")".repeat(depth)}`);
		fc.assert(
			fc.property(nestedCalls, (input) => {
				assertStructuredResult(parseNeverThrows(input, "preconditions"));
			}),
			{ numRuns: 100 },
		);
	});

	it("never throws on generated or/and chains up to 2000 terms", () => {
		const boolChain = fc
			.array(fc.constantFrom("or", "and"), {
				minLength: 1,
				maxLength: 2000,
				size: "xlarge",
			})
			.map((ops) => `a${ops.map((op) => ` ${op} a`).join("")}`);
		fc.assert(
			fc.property(boolChain, (input) => {
				assertStructuredResult(parseNeverThrows(input, "preconditions"));
			}),
			{ numRuns: 100 },
		);
	});

	it("never throws on mixed junk that passed the tokenizer (structured errors only)", () => {
		const tokenSoup = fc
			.array(
				fc.oneof(
					fc.constantFrom(
						"+",
						"-",
						"*",
						"/",
						"==",
						">=",
						"<=",
						"(",
						")",
						"[",
						"]",
						",",
						".",
					),
					fc.constantFrom("a", "b", "f", "old", "not", "in", "true"),
					fc.constantFrom("f(", "a)", '"', '["OPEN"', "1,", "[0]"),
				),
				{ minLength: 1, maxLength: 100, size: "large" },
			)
			.map((parts) => parts.join(" "));
		fc.assert(
			fc.property(tokenSoup, (input) => {
				assertStructuredResult(parseNeverThrows(input, "preconditions"));
			}),
			{ numRuns: 100 },
		);
	});
});

describe("parseExpression — never throws across all three clauseKinds", () => {
	it("runs the same generated inputs against preconditions/postconditions/invariants", () => {
		const junk = fc.string({ maxLength: 160, size: "large" });
		const clauseKind = fc.constantFrom(
			"preconditions",
			"postconditions",
			"invariants",
		);
		fc.assert(
			fc.property(junk, clauseKind, (input, kind) => {
				assertStructuredResult(parseNeverThrows(input, kind));
			}),
			{ numRuns: 100 },
		);
	});
});

describe("parseExpression — well-formed field paths always parse", () => {
	it("parses generated paths like a.b[0].c[] to ok:true", () => {
		const rootIdentifier = fc.constantFrom(
			"a",
			"b",
			"balance",
			"order",
			"customer",
			"items",
			"status",
			"total",
			"x",
		);
		const suffix = fc.oneof(
			fc.constantFrom("name", "total", "price", "tier", "customer"),
			fc.integer({ min: 0, max: 3 }),
			fc.constant("[]"),
		);
		const fieldPath = fc
			.tuple(rootIdentifier, fc.array(suffix, { minLength: 0, maxLength: 6 }))
			.map(
				([root, suffixes]) =>
					root +
					suffixes
						.map((segment) => {
							if (typeof segment === "number") {
								return `[${segment}]`;
							}
							if (segment === "[]") {
								// Wildcard segments append bare ("items[]"), never
								// after a dot — a dot requires an identifier.
								return segment;
							}
							return `.${segment}`;
						})
						.join(""),
			);
		fc.assert(
			fc.property(fieldPath, (input) => {
				const result = parseNeverThrows(input, "preconditions");
				// Choice: the grammar's field_ref suffix rules make every
				// generated path valid, so assert ok:true, not just never-throw.
				expect(result.ok).toBe(true);
			}),
			{ numRuns: 100 },
		);
	});
});

describe("parseExpression — frozen AST node types (§4.3 round-trip)", () => {
	const FROZEN_NODE_TYPES: ReadonlySet<string> = new Set([
		"or",
		"and",
		"not",
		"compare",
		"arithmetic",
		"old",
		"predicateCall",
		"fieldRef",
		"literal",
	]);

	function assertFrozenAst(node: Node): void {
		expect(FROZEN_NODE_TYPES.has(node.type)).toBe(true);
		switch (node.type) {
			case "or":
			case "and":
			case "compare":
			case "arithmetic":
				assertFrozenAst(node.left);
				assertFrozenAst(node.right);
				return;
			case "not":
				assertFrozenAst(node.operand);
				return;
			case "predicateCall":
				for (const arg of node.args) {
					assertFrozenAst(arg);
				}
				return;
			case "old":
				assertFrozenAst(node.ref);
				return;
			case "fieldRef":
			case "literal":
				return;
		}
	}

	it("parses generated well-formed boolean expressions into §4.3 nodes only", () => {
		const atomic = fc.constantFrom(
			"balance >= 0",
			'status in ["OPEN"]',
			"total > 0",
			"a == b",
			"not available",
			"a != null",
		);
		const boolExpr = (maxDepth: number): fc.Arbitrary<string> => {
			if (maxDepth <= 0) {
				return atomic;
			}
			return fc.oneof(
				atomic,
				fc
					.tuple(
						boolExpr(maxDepth - 1),
						fc.constantFrom("and", "or"),
						boolExpr(maxDepth - 1),
					)
					.map(([left, op, right]) => `${left} ${op} ${right}`),
			);
		};
		fc.assert(
			fc.property(boolExpr(3), (input) => {
				const result = parseNeverThrows(input, "preconditions");
				expect(result.ok).toBe(true);
				if (result.ok) {
					assertFrozenAst(result.ast);
				}
			}),
			{ numRuns: 100 },
		);
	});
});
