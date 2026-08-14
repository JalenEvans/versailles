import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseExpression } from "../src/core/parser.js";
import type { Node } from "../src/core/parser.js";
import { semanticValidate } from "../src/core/validator.js";
import type {
	ValidationResult,
	ValidatorScope,
} from "../src/core/validator.js";
import type {
	ContractsFile,
	VersaillesContext,
} from "../src/loader/workspace.js";

/**
 * Semantic validator property tests — never-throws + result-shape invariants
 * under the ADR-0010 untrusted-input model (build-spec §5.2).
 *
 * The validator's central invariant is that semanticValidate NEVER throws an
 * unstructured exception: a missing component manifest, missing operation, or
 * missing predicate entry is a structured resolution failure, not a crash.
 * Property-based tests extend the deterministic battery in
 * tests/validator.test.ts across generated families:
 *
 * 1. Never-throws on randomly generated (structurally valid) AST nodes of
 *    every §4.3 union member, with random fields/ops/paths/arity; the result
 *    always carries errors[]/warnings[] arrays and a boolean valid.
 * 2. The contract's hard assert: valid === (errors.length === 0), for every
 *    generated AST.
 * 3. Resolvable-field positive invariant: expressions built from fields that
 *    ARE resolvable in the fixture context (balance, order.customer.name,
 *    items[0], params, registered predicates) always validate valid:true with
 *    no resolution errors.
 * 4. Type-compat consistency: generated number-vs-number field comparisons
 *    never produce a TYPE_MISMATCH error.
 *
 * Note on `[]` wildcard paths: the resolvable-field and type-compat pools use
 * `items[0]` but NOT `items[]`. The parser accepts `items[]` (build-spec §4.1
 * field_ref) as path segment "[]", but the current validator mis-resolves the
 * "[]" wildcard as a nested field name (it requires a component type) instead
 * of stripping list<T> to T, so `items[]` emits a spurious UNRESOLVED_NESTED_FIELD
 * error. That is a separate defect tracked for the validator; these positive
 * invariants only claim paths that ARE resolvable. The never-throws property
 * still covers `[]` segments via the random AST generator.
 *
 * Every property uses the standard fast-check-in-vitest pattern:
 * `fc.assert(fc.property(arb, fn), { numRuns })`, with numRuns 100.
 */

const OS = "OrderService";
const OP = "placeOrder";
const PROP_CONTRACT_ID = "property-test.contract.0";

const PRE_SCOPE: ValidatorScope = { component: OS, operation: OP };
const POST_SCOPE: ValidatorScope = { component: OS, operation: OP };

type ManifestField =
	| string
	| { type: string; confidence: "inferred" | "declared" };

type ManifestOverride = Record<
	string,
	{ sourceHash: string; fields: Record<string, ManifestField> }
>;

type PredicateOverride = Record<string, Record<string, unknown>>;

function contractsFixture(): unknown {
	const fixture: ContractsFile = {
		version: "1.0",
		contracts: {
			[OS]: {
				invariants: [],
				operations: {
					[OP]: {
						id: `${OS}.${OP}`,
						params: [
							{ name: "amount", type: "number" },
							{ name: "requestStatus", type: "enum<OPEN,SHIPPED>" },
						],
						preconditions: [],
						postconditions: [],
						effects: [],
						sourceHash: "op-hash",
					},
				},
			},
		},
	};
	return fixture;
}

function manifestsFixture(): ManifestOverride {
	return {
		[OS]: {
			sourceHash: "man-os",
			fields: {
				balance: "number",
				total: "number",
				status: "enum<OPEN,SHIPPED,VOID>",
				order: "Order",
				items: "list<number>",
				tags: "list<string>",
				customer: "Customer",
			},
		},
		Order: {
			sourceHash: "man-order",
			fields: {
				total: "number",
				customer: "Customer",
				sku: "string",
			},
		},
		Customer: {
			sourceHash: "man-cust",
			fields: {
				name: "string",
				tier: "enum<GOLD,SILVER>",
				allowedTags: "list<string>",
			},
		},
	};
}

function predicatesFixture(): PredicateOverride {
	return {
		isPositive: {
			params: ["n"],
			paramTypes: ["number"],
			returnType: "boolean",
			sourceRef: "Num.isPositive",
			sourceHash: "p1",
			verifiedPure: true,
		},
		isAvailable: {
			params: ["status"],
			paramTypes: ["enum<OPEN,SHIPPED>"],
			returnType: "boolean",
			sourceRef: "Order.isAvailable",
			sourceHash: "p2",
			verifiedPure: true,
		},
		noArg: {
			params: [],
			paramTypes: [],
			returnType: "boolean",
			sourceRef: "Util.noArg",
			sourceHash: "p3",
			verifiedPure: true,
		},
	};
}

/**
 * Builds a fully-loaded VersaillesContext fixture in memory (no files, no
 * loader), mirroring the fixture in tests/validator.test.ts. The manifest /
 * predicate overrides use the extended field shape, so they are cast at the
 * boundary — the loader's ManifestsFile/PredicatesFile types are aligned to
 * these shapes in the 3.3 wiring chunk.
 */
function makeTestContext(): VersaillesContext {
	return {
		config: null,
		contracts: contractsFixture() as VersaillesContext["contracts"],
		manifests: {
			version: "1.0",
			manifests: manifestsFixture(),
		} as VersaillesContext["manifests"],
		predicates: {
			version: "1.0",
			predicates: predicatesFixture(),
		} as VersaillesContext["predicates"],
		parsedContracts: {},
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

/**
 * Parse-then-validate helper mirroring the real pipeline (parser produces the
 * AST, the validator consumes it). Throws only if the FIXTURE expression fails
 * to parse — that is a test-authoring error, not a validator behavior.
 */
function validate(
	expr: string,
	clauseKind: "preconditions" | "postconditions",
	scope: ValidatorScope,
): ValidationResult {
	const parsed = parseExpression(expr, clauseKind, PROP_CONTRACT_ID);
	if (!parsed.ok) {
		throw new Error(
			`test fixture parse failed for "${expr}": ${JSON.stringify(parsed.errors)}`,
		);
	}
	return semanticValidate(
		parsed.ast,
		clauseKind,
		PROP_CONTRACT_ID,
		makeTestContext(),
		scope,
	);
}

/**
 * Generators for randomly shaped but structurally valid §4.3 AST nodes. Every
 * member keeps its required fields (walkNode reads node.left/right/operand),
 * so a crash would be a real validator bug rather than an out-of-contract
 * input — that is the honest reading of the never-throws claim.
 */
const IDENT = fc.constantFrom(
	"a",
	"b",
	"balance",
	"total",
	"status",
	"order",
	"items",
	"amount",
	"ghost",
	"x",
);

const LITERAL_VALUE = fc.oneof(
	fc.constant("OPEN"),
	fc.constant("SHIPPED"),
	fc.integer({ min: 0, max: 100 }),
	fc.boolean(),
	fc.constant(null),
	fc.array(fc.oneof(fc.constant("OPEN"), fc.integer({ min: 0, max: 9 })), {
		minLength: 1,
		maxLength: 4,
	}),
);

const FIELD_PATH = fc.array(
	fc.oneof(IDENT, fc.integer({ min: 0, max: 9 }), fc.constant("[]")),
	{ minLength: 1, maxLength: 6 },
);

const COMPARE_OPS = fc.constantFrom("==", "!=", ">", ">=", "<", "<=", "in");
const ARITH_OPS = fc.constantFrom("+", "-", "*", "/");
const CALL_NAMES = fc.constantFrom(
	"isPositive",
	"isAvailable",
	"noArg",
	"ghost",
	"f",
);

const fieldRefNode = fc.record({
	type: fc.constant("fieldRef"),
	path: FIELD_PATH,
}) as fc.Arbitrary<Node>;

const literalNode = fc.record({
	type: fc.constant("literal"),
	value: LITERAL_VALUE,
}) as fc.Arbitrary<Node>;

const oldNode = fc.record({
	type: fc.constant("old"),
	ref: fc.record({
		type: fc.constant("fieldRef"),
		path: FIELD_PATH,
	}),
}) as fc.Arbitrary<Node>;

const emptyCallNode = fc.record({
	type: fc.constant("predicateCall"),
	name: CALL_NAMES,
	args: fc.constant([]),
}) as fc.Arbitrary<Node>;

function termNode(maxDepth: number): fc.Arbitrary<Node> {
	const leaves = fc.oneof(fieldRefNode, literalNode, oldNode, emptyCallNode);
	if (maxDepth <= 0) {
		return leaves as fc.Arbitrary<Node>;
	}
	return fc.oneof(
		leaves,
		fc.record({
			type: fc.constant("not"),
			operand: termNode(maxDepth - 1),
		}) as fc.Arbitrary<Node>,
		fc.record({
			type: fc.constant("compare"),
			op: COMPARE_OPS,
			left: termNode(maxDepth - 1),
			right: termNode(maxDepth - 1),
		}) as fc.Arbitrary<Node>,
		fc.record({
			type: fc.constant("arithmetic"),
			op: ARITH_OPS,
			left: termNode(maxDepth - 1),
			right: termNode(maxDepth - 1),
		}) as fc.Arbitrary<Node>,
		fc.record({
			type: fc.constant("predicateCall"),
			name: CALL_NAMES,
			args: fc.array(termNode(maxDepth - 1), {
				minLength: 0,
				maxLength: 3,
			}),
		}) as fc.Arbitrary<Node>,
	) as fc.Arbitrary<Node>;
}

function booleanNode(maxDepth: number): fc.Arbitrary<Node> {
	if (maxDepth <= 0) {
		return termNode(0);
	}
	return fc.oneof(
		termNode(maxDepth),
		fc.record({
			type: fc.constant("and"),
			left: booleanNode(maxDepth - 1),
			right: booleanNode(maxDepth - 1),
		}) as fc.Arbitrary<Node>,
		fc.record({
			type: fc.constant("or"),
			left: booleanNode(maxDepth - 1),
			right: booleanNode(maxDepth - 1),
		}) as fc.Arbitrary<Node>,
	) as fc.Arbitrary<Node>;
}

describe("semanticValidate — never throws on randomly generated ASTs (ADR-0010)", () => {
	it("never throws and always returns a well-shaped ValidationResult", () => {
		const clauseKind = fc.constantFrom(
			"preconditions",
			"postconditions",
			"invariants",
		);
		fc.assert(
			fc.property(booleanNode(3), clauseKind, (ast, kind) => {
				let result: ValidationResult | undefined;
				expect(() => {
					result = semanticValidate(
						ast,
						kind,
						PROP_CONTRACT_ID,
						makeTestContext(),
						PRE_SCOPE,
					);
				}).not.toThrow();
				expect(result).toBeDefined();
				expect(Array.isArray(result?.errors)).toBe(true);
				expect(Array.isArray(result?.warnings)).toBe(true);
				expect(typeof result?.valid).toBe("boolean");
			}),
			{ numRuns: 100 },
		);
	});
});

describe("semanticValidate — valid/errors invariant", () => {
	it("valid === (errors.length === 0) for every generated AST", () => {
		fc.assert(
			fc.property(booleanNode(3), (ast) => {
				const result = semanticValidate(
					ast,
					"preconditions",
					PROP_CONTRACT_ID,
					makeTestContext(),
					PRE_SCOPE,
				);
				expect(result.valid).toBe(result.errors.length === 0);
			}),
			{ numRuns: 100 },
		);
	});
});

describe("semanticValidate — resolvable-field positive invariant", () => {
	const NUMBER_REF = fc.constantFrom(
		"balance",
		"total",
		"amount",
		"order.total",
		"items[0]",
	);
	const NUMBER_LITERAL = fc.integer({ min: 0, max: 1000 });
	const NUMBER_TERM = fc.oneof(NUMBER_REF, NUMBER_LITERAL);
	const COMPARE = fc.constantFrom("==", "!=", ">", ">=", "<", "<=");

	const numberComparison = fc
		.tuple(NUMBER_REF, COMPARE, NUMBER_TERM)
		.map(([left, op, right]) => `${left} ${op} ${right}`);

	const stringComparison = fc
		.tuple(
			fc.constantFrom("order.customer.name", "order.sku", "customer.name"),
			fc.constantFrom("==", "!="),
			fc.constantFrom("Ada", "SKU-1", "open", "GOLD"),
		)
		.map(([left, op, right]) => `${left} ${op} "${right}"`);

	const inExpression = fc.oneof(
		fc.constant('status in ["OPEN"]'),
		fc.constant('status in ["OPEN", "SHIPPED", "VOID"]'),
		fc.constant('requestStatus in ["OPEN", "SHIPPED"]'),
		fc.constant('order.customer.tier in ["GOLD", "SILVER"]'),
	);

	const predicateExpression = fc.oneof(
		fc.constant("isPositive(balance)"),
		fc.constant("isPositive(amount)"),
		fc.constant("isAvailable(status)"),
		fc.constant("noArg()"),
	);

	const listExpression = fc.oneof(
		fc.constant("items in [1, 2, 3]"),
		fc.constant("tags in customer.allowedTags"),
		fc.constant("total >= 0"),
	);

	const positivePreExpression = fc.oneof(
		numberComparison,
		stringComparison,
		inExpression,
		predicateExpression,
		listExpression,
	);

	it("expressions built from resolvable fields validate valid:true with no resolution errors", () => {
		fc.assert(
			fc.property(positivePreExpression, (expr) => {
				const result = validate(expr, "preconditions", PRE_SCOPE);
				expect(result.valid).toBe(true);
				expect(result.errors).toEqual([]);
				expect(
					result.errors.some(
						(error) =>
							error.code === "UNKNOWN_FIELD" ||
							error.code === "UNRESOLVED_NESTED_FIELD",
					),
				).toBe(false);
			}),
			{ numRuns: 100 },
		);
	});

	it("old() postcondition expressions built from resolvable fields validate valid:true", () => {
		const postPositive = fc.oneof(
			fc.constant("old(balance) >= 0"),
			fc.constant("old(balance) <= balance"),
			fc
				.tuple(
					fc.constantFrom("old(balance)", "old(order.total)"),
					COMPARE,
					NUMBER_TERM,
				)
				.map(([left, op, right]) => `${left} ${op} ${right}`),
		);
		fc.assert(
			fc.property(postPositive, (expr) => {
				const result = validate(expr, "postconditions", POST_SCOPE);
				expect(result.valid).toBe(true);
				expect(result.errors).toEqual([]);
			}),
			{ numRuns: 100 },
		);
	});
});

describe("semanticValidate — type-compat consistency", () => {
	it("never flags TYPE_MISMATCH for generated number-vs-number field comparisons", () => {
		const NUMBER_REF = fc.constantFrom(
			"balance",
			"total",
			"amount",
			"order.total",
			"items[0]",
		);
		const NUMBER_TERM = fc.oneof(NUMBER_REF, fc.integer({ min: 0, max: 1000 }));
		const numberComparison = fc
			.tuple(
				NUMBER_REF,
				fc.constantFrom("==", "!=", ">", ">=", "<", "<="),
				NUMBER_TERM,
			)
			.map(([left, op, right]) => `${left} ${op} ${right}`);
		fc.assert(
			fc.property(numberComparison, (expr) => {
				const result = validate(expr, "preconditions", PRE_SCOPE);
				expect(
					result.errors.some((error) => error.code === "TYPE_MISMATCH"),
				).toBe(false);
				expect(result.valid).toBe(true);
			}),
			{ numRuns: 100 },
		);
	});
});
