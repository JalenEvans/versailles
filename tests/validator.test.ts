import { describe, expect, it } from "vitest";

import { parseExpression } from "../packages/core/src/core/parser.js";
import type { ClauseKind, Node } from "../packages/core/src/core/parser.js";
import { semanticValidate } from "../packages/core/src/core/validator.js";
import type {
	ValidationResult,
	ValidatorScope,
} from "../packages/core/src/core/validator.js";
import type {
	ContractsFile,
	VersaillesContext,
} from "../packages/core/src/loader/workspace.js";

/**
 * Semantic validator — pinned against build-spec §5.1–§5.2, the
 * contract-language spec (Behavior: semantic hard errors, unverified
 * predicates, low-confidence warnings), the contract-language.contract.yaml
 * operations (semantic_validate, resolve_predicate), and ADR-0004 / ADR-0006.
 *
 * The validator is the second half of the validation kernel (chunk 3.2): it
 * runs AFTER a successful parse, against the FULL workspace context
 * (contracts + manifests + predicates — the loader's VersaillesContext), and
 * implements every §5.1 check row. The loader (3.3 wiring chunk) will call
 * this module and populate validationErrors/validationWarnings; this module
 * does NOT load the workspace itself.
 *
 * ── Module contract ────────────────────────────────────────────────────────
 *
 * Module: src/core/validator.ts
 * Export: semanticValidate(ast, clauseKind, clauseId, context, scope)
 *
 * ```ts
 * export type ClauseKind = "preconditions" | "postconditions" | "invariants";
 * export type Node = ...; // build-spec §4.3, from src/core/parser.ts
 *
 * export type ValidationErrorCode =
 *   | "UNKNOWN_FIELD"          // §5.1 row: field ref resolves — root identifier
 *   | "UNRESOLVED_NESTED_FIELD" // §5.1 row: nested field ref resolves
 *   | "TYPE_MISMATCH"          // §5.1 row: type compatibility (also `in` member mismatch)
 *   | "INVALID_IN_OPERAND"     // §5.1 row: `in` operand shape
 *   | "OLD_SCOPE"              // §5.1 row: old() scope — defense-in-depth
 *   | "UNKNOWN_PREDICATE"      // §5.1 row: predicate exists
 *   | "PREDICATE_ARITY"        // §5.1 row: predicate arity
 *   | "PREDICATE_ARG_TYPE";    // §5.1 row: predicate arg types
 *                             // (ADR-0019: no UNVERIFIED_PREDICATE gate — any
 *                             //  declared predicate is referenceable)
 *
 * export type ValidationWarningCode = "LOW_CONFIDENCE_FIELD"; // §5.1 warning row (ADR-0004)
 *
 * export type ValidationError = {
 *   contractId: string; // echoed verbatim from the clauseId argument
 *   code: ValidationErrorCode;
 *   field: string;      // construct descriptor inside the clause: dotted field path
 *                       // (e.g. "order.customer.name"), "predicateCall(<name>)",
 *                       // or "old" — NOT the clause entry index; the loader (3.3)
 *                       // may decorate field with "preconditions[0]" like parse errors.
 *   detail: string;     // human-readable, never empty
 * };
 *
 * export type ValidationWarning = { code: ValidationWarningCode; field: string; detail: string };
 * export type ValidationResult = {
 *   valid: boolean; // === errors.length === 0; warnings never flip valid
 *   errors: ValidationError[];
 *   warnings: ValidationWarning[];
 * };
 *
 * export type ValidatorScope = { component: string; operation?: string };
 *
 * export declare function semanticValidate(
 *   ast: Node,
 *   clauseKind: ClauseKind,
 *   clauseId: string,
 *   context: VersaillesContext, // fully-loaded workspace context (build-spec §6)
 *   scope: ValidatorScope,
 * ): ValidationResult;
 * ```
 *
 * The validator never throws an unstructured exception: a missing component
 * manifest, missing operation, or missing predicate entry is a structured
 * resolution failure, not a crash (build-spec §5.2, ADR-0010).
 *
 * ── How resolution walks the context ───────────────────────────────────────
 *
 * - Component fields: context.manifests.manifests[scope.component].fields.
 * - Operation params (pre/post only): context.contracts.contracts[scope.component]
 *   .operations[scope.operation].params — each { name, type }.
 * - Nested types: context.manifests.manifests[<TypeName>] — the flat manifest
 *   map (build-spec §3.3) also holds value/nested types referenced by other
 *   components, so order.customer.name walks OrderService → Order → Customer.
 * - Predicates: context.predicates.predicates[name].
 *
 * ── Resolved-type representation & compatibility ───────────────────────────
 *
 * typeRef grammar (build-spec §3.3): string | number | boolean | <ComponentName>
 * | list<typeRef> | optional<typeRef> | enum<v1,v2,...>.
 *
 * ```ts
 * export type ResolvedType =
 *   | { kind: "scalar"; name: "string" | "number" | "boolean" }
 *   | { kind: "component"; name: string }   // <ComponentName> → manifest entry
 *   | { kind: "list"; element: ResolvedType }
 *   | { kind: "optional"; inner: ResolvedType }
 *   | { kind: "enum"; members: (string | number | boolean)[] };
 * ```
 *
 * Literal terms resolve to: number literal → scalar number; string literal →
 * scalar string; boolean literal → scalar boolean; null literal → the
 * permissive null type (compatible with ANY declared type — the "x != null"
 * guard idiom); list literal → a list whose elements are the member literals.
 *
 * compatible(declared, actual):
 * - scalar == scalar with the same name → true
 * - optional<T> unwraps to T (also accepts null)
 * - component X vs component X (same name) → true (structural equality by name,
 *   no recursive deep-type comparison in v1)
 * - list<T> vs list_literal whose members are all compatible with T → true
 * - enum<members> vs scalar literal that is a member → true (a non-member
 *   literal → TYPE_MISMATCH; the union is the full allowed set)
 * - enum<members> vs list_literal whose members are all in the set → true
 * - null literal → true
 * - otherwise false
 *
 * ── Ambiguities resolved by these tests ────────────────────────────────────
 *
 * 1. Scope precedence: for pre/postconditions the operation params SHADOW
 *    component manifest fields (params-first) when a name exists in both.
 *    Invariants resolve against component manifest fields ONLY — operation
 *    params are never available to invariants.
 * 2. `in` operand violations split into two codes: a shape violation (RHS is
 *    not a list_literal and not a field of list<T>/enum<...> type — e.g.
 *    "status in 5" or "status in amount" where amount is number) →
 *    INVALID_IN_OPERAND; a list_literal whose MEMBER types don't match the
 *    left-hand type (e.g. "status in [1,2]" with an enum<string> field) →
 *    TYPE_MISMATCH (the RHS is list-shaped; the failure is member
 *    incompatibility).
 * 3. error.field is the construct descriptor inside the clause (dotted path
 *    for field refs, "predicateCall(<name>)" for predicate calls, "old" for
 *    old-scope), NOT the clause entry index — the §5.2 example's
 *    "postconditions[0]" decoration is a loader (3.3) concern, mirroring how
 *    the loader decorates parse errors.
 * 4. Low-confidence is represented on the manifest entry as
 *    { type: <typeRef>, confidence: "inferred" | "declared" }; a plain string
 *    typeRef means declared (the §3.3 shape, implicitly full confidence).
 *    confidence: "inferred" → LOW_CONFIDENCE_FIELD warning, valid stays true
 *    (ADR-0004). NOTE for the GM: §3.3 / the loader's ManifestsFile.fields
 *    type (Record<string, string>) must be aligned to accept the optional
 *    object form in the 3.3 wiring chunk; the validator reads either form.
 *    This test file's fixtures use the object form and cast at the makeContext
 *    boundary.
 * 5. ADR-0019: the verifiedPure purity gate is DROPPED. Any declared predicate
 *    is referenceable; `verifiedPure` (true/false/missing) is silently ignored.
 * 6. arithmetic nodes resolve to scalar "number"; operand type checks of
 *    arithmetic are out of scope for the §5.1 table (which lists no arithmetic
 *    row), so "total + 1 >= 0" is valid without checking operand types.
 * 7. Index segments ("[0]", "[]") are valid only when the current type is
 *    list<T> and strip the type to T; an index on a non-list type is
 *    UNRESOLVED_NESTED_FIELD.
 * 8. A predicateCall used as a comparison or predicate-arg term resolves to
 *    its registered returnType. When a term fails to resolve (unknown field /
 *    unknown predicate), downstream type checks on THAT term are suppressed to
 *    avoid cascade noise — the resolution error has already fired; independent
 *    checks elsewhere still run.
 * 9. warnings dedupe by (code, field) across the whole result, so repeated
 *    refs to the same low-confidence field emit one warning.
 * 10. valid === errors.length === 0 (build-spec §5.2 / contract assert: valid
 *     is false iff errors is non-empty); warnings never affect valid.
 * 11. UNKNOWN_PREDICATE fuzzy suggestions (VERSAILLES-172): when the referenced
 *     predicate is undeclared, the detail appends at most 2 declared keys
 *     within Levenshtein distance ≤ 2 as " — did you mean "a" or "b"?"
 *     (two suggestions join with " or "). Ordering is distance-then-
 *     alphabetical: closest match first, ties alphabetical. No suggestion when
 *     there are no declared predicates at all (empty map or null file) or no
 *     declared key is within range. Suggestions live ONLY in the detail
 *     string — code/field/contractId are unchanged, and the other predicate
 *     error codes (PREDICATE_ARITY / PREDICATE_ARG_TYPE) are untouched. The
 *     UNVERIFIED_PREDICATE code is removed (ADR-0019).
 */

const OS = "OrderService";
const OP = "placeOrder";
const PRE0 = "OrderService.placeOrder.pre0";
const POST0 = "OrderService.placeOrder.post0";
const INV0 = "OrderService.inv0";

const PRE_SCOPE: ValidatorScope = { component: OS, operation: OP };
const POST_SCOPE: ValidatorScope = { component: OS, operation: OP };
const INV_SCOPE: ValidatorScope = { component: OS };

/**
 * A manifest field entry: either the §3.3 plain typeRef string (declared,
 * full confidence) or the ADR-0004 extension object carrying an explicit
 * confidence tier. This is the shape the validator reads; the loader's
 * ManifestsFile.fields type is aligned to it in the 3.3 wiring chunk.
 */
type ManifestField =
	| string
	| { type: string; confidence: "inferred" | "declared" };

type ManifestOverride = Record<
	string,
	{ sourceHash: string; fields: Record<string, ManifestField> }
>;

type PredicateOverride = Record<string, Record<string, unknown>>;

type MakeContextOverrides = {
	contracts?: unknown;
	manifests?: ManifestOverride;
	predicates?: PredicateOverride;
};

function contractsFixture(): unknown {
	const fixture: ContractsFile = {
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
				inferredField: { type: "number", confidence: "inferred" },
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
		},
		isAvailable: {
			params: ["status"],
			paramTypes: ["enum<OPEN,SHIPPED>"],
			returnType: "boolean",
			sourceRef: "Order.isAvailable",
		},
		noArg: {
			params: [],
			paramTypes: [],
			returnType: "boolean",
			sourceRef: "Util.noArg",
		},
		sideEffectful: {
			params: ["n"],
			paramTypes: ["number"],
			returnType: "boolean",
			sourceRef: "Util.sideEffectful",
		},
		missingPurity: {
			params: ["n"],
			paramTypes: ["number"],
			returnType: "boolean",
			sourceRef: "Util.missingPurity",
		},
	};
}

/**
 * Builds a fully-loaded VersaillesContext fixture in memory (no files, no
 * loader). The manifest/predicate overrides use the extended field shape, so
 * they are cast at the boundary — the loader's ManifestsFile/PredicatesFile
 * types are aligned to these shapes in the 3.3 wiring chunk.
 */
function makeContext(overrides: MakeContextOverrides = {}): VersaillesContext {
	const context: VersaillesContext = {
		config: null,
		contracts: contractsFixture() as VersaillesContext["contracts"],
		manifests: {
			manifests: manifestsFixture(),
		} as VersaillesContext["manifests"],
		predicates: {
			predicates: predicatesFixture(),
		} as VersaillesContext["predicates"],
		parsedContracts: {},
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
	if (overrides.contracts !== undefined) {
		context.contracts = overrides.contracts as VersaillesContext["contracts"];
	}
	if (overrides.manifests !== undefined) {
		context.manifests = {
			manifests: overrides.manifests,
		} as VersaillesContext["manifests"];
	}
	if (overrides.predicates !== undefined) {
		context.predicates = {
			predicates: overrides.predicates,
		} as VersaillesContext["predicates"];
	}
	return context;
}

/**
 * Parse-then-validate helper mirroring the real pipeline (parser produces the
 * AST, the validator consumes it). Throws only if the FIXTURE expression fails
 * to parse — that is a test-authoring error, not a validator behavior.
 */
function validate(
	expr: string,
	clauseKind: ClauseKind,
	clauseId: string,
	scope: ValidatorScope,
	context: VersaillesContext = makeContext(),
): ValidationResult {
	const parsed = parseExpression(expr, clauseKind, clauseId);
	if (!parsed.ok) {
		throw new Error(
			`test fixture parse failed for "${expr}": ${JSON.stringify(parsed.errors)}`,
		);
	}
	return semanticValidate(parsed.ast, clauseKind, clauseId, context, scope);
}

describe("semanticValidate — field resolution: root + nested (A, B, C)", () => {
	it("A: valid when a root field ref resolves and the comparison type matches", () => {
		const result = validate("balance >= 0", "preconditions", PRE0, PRE_SCOPE);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("A: valid for an operation param root in a precondition", () => {
		const result = validate("amount >= 1", "preconditions", PRE0, PRE_SCOPE);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("B: UNKNOWN_FIELD when the root identifier is in neither manifest fields nor operation params", () => {
		const result = validate("nope >= 0", "preconditions", PRE0, PRE_SCOPE);
		expect(result.valid).toBe(false);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({
			contractId: PRE0,
			code: "UNKNOWN_FIELD",
			field: "nope",
		});
	});

	it("B: UNKNOWN_FIELD also fires for invariants scope (manifest-only resolution)", () => {
		const result = validate("nope > 0", "invariants", INV0, INV_SCOPE);
		expect(result.valid).toBe(false);
		expect(result.errors[0].code).toBe("UNKNOWN_FIELD");
	});

	it("C: transitive nested resolution succeeds through two levels (order.customer.name)", () => {
		const result = validate(
			'order.customer.name == "Ada"',
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("C: two-segment nested resolution succeeds (order.total)", () => {
		const result = validate(
			"order.total >= 0",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("C: UNRESOLVED_NESTED_FIELD when a second-segment field is missing", () => {
		const result = validate(
			"order.missing > 0",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			contractId: PRE0,
			code: "UNRESOLVED_NESTED_FIELD",
			field: "order.missing",
		});
	});

	it("C: UNRESOLVED_NESTED_FIELD when a third-segment field is missing (transitive)", () => {
		const result = validate(
			'order.customer.nope == "x"',
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "UNRESOLVED_NESTED_FIELD",
			field: "order.customer.nope",
		});
	});

	it("C: UNRESOLVED_NESTED_FIELD when the referenced type has no manifest entry", () => {
		const context = makeContext({
			manifests: {
				[OS]: {
					sourceHash: "man-os",
					fields: { ghost: "GhostType" },
				},
			},
		});
		const result = validate(
			'ghost.name == "x"',
			"preconditions",
			PRE0,
			PRE_SCOPE,
			context,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "UNRESOLVED_NESTED_FIELD",
			field: "ghost.name",
		});
	});
});

describe("semanticValidate — type compatibility (D)", () => {
	it("D: TYPE_MISMATCH when comparing a number field to a string literal", () => {
		const result = validate(
			'balance == "high"',
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "TYPE_MISMATCH",
			field: "balance",
		});
	});

	it("D: valid when comparing a number field to a number literal", () => {
		const result = validate("balance == 5", "preconditions", PRE0, PRE_SCOPE);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("D: valid when comparing two number fields", () => {
		const result = validate(
			"total >= balance",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

describe("semanticValidate — `in` operand shape (E)", () => {
	it("E: valid when an enum<string> field is compared with a list_literal of members", () => {
		const result = validate(
			'status in ["OPEN", "SHIPPED"]',
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("E: INVALID_IN_OPERAND when the RHS is a scalar literal, not a list", () => {
		const result = validate("status in 5", "preconditions", PRE0, PRE_SCOPE);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "INVALID_IN_OPERAND",
			field: "5",
		});
	});

	it("E: valid when a list<number> field is compared with a list_literal of numbers", () => {
		const result = validate(
			"items in [1, 2]",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("E: TYPE_MISMATCH when list_literal members don't match the enum element type (stated choice)", () => {
		// The RHS is list-shaped, so the failure is member-type incompatibility
		// (numbers are not members of enum<string>), not an operand shape
		// violation. Per the pinned ambiguity #2 this is TYPE_MISMATCH.
		const result = validate(
			"status in [1, 2]",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "TYPE_MISMATCH",
			field: "status",
		});
	});

	it("E: valid when the RHS is a field of list<T> type matching the left type", () => {
		const result = validate(
			"tags in customer.allowedTags",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("E: INVALID_IN_OPERAND when the RHS field resolves to a scalar type", () => {
		const result = validate(
			"status in amount",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "INVALID_IN_OPERAND",
			field: "amount",
		});
	});
});

describe("semanticValidate — predicate exists (F)", () => {
	it("F: valid for a registered verified-pure predicate with matching arity and arg types", () => {
		const result = validate(
			"isPositive(balance)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("F: UNKNOWN_PREDICATE for an unregistered predicate name", () => {
		const result = validate(
			"notRegistered(balance)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "UNKNOWN_PREDICATE",
			field: "predicateCall(notRegistered)",
		});
	});
});

describe("semanticValidate — predicate arity (G)", () => {
	it("G: PREDICATE_ARITY when too few args are passed", () => {
		const result = validate("isPositive()", "preconditions", PRE0, PRE_SCOPE);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "PREDICATE_ARITY",
			field: "predicateCall(isPositive)",
		});
	});

	it("G: PREDICATE_ARITY when too many args are passed", () => {
		const result = validate(
			"isPositive(balance, total)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0].code).toBe("PREDICATE_ARITY");
	});

	it("G: PREDICATE_ARITY when a zero-param predicate receives an arg", () => {
		const result = validate("noArg(balance)", "preconditions", PRE0, PRE_SCOPE);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "PREDICATE_ARITY",
			field: "predicateCall(noArg)",
		});
	});
});

describe("semanticValidate — predicate arg types (H)", () => {
	it("H: PREDICATE_ARG_TYPE when an arg's resolved type doesn't match paramTypes[i]", () => {
		// isPositive expects number; status is enum<string>.
		const result = validate(
			"isPositive(status)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "PREDICATE_ARG_TYPE",
			field: "predicateCall(isPositive)",
		});
	});

	it("H: valid when each arg's resolved type matches paramTypes", () => {
		const result = validate(
			"isPositive(balance)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("H: valid when an enum-typed arg matches an enum paramType", () => {
		const result = validate(
			"isAvailable(status)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

describe("semanticValidate — no verifiedPure purity gate (I, ADR-0019)", () => {
	it("I: a predicate declared WITHOUT verifiedPure now resolves fine (was UNVERIFIED_PREDICATE)", () => {
		const result = validate(
			"missingPurity(balance)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("I: a predicate whose verifiedPure would have been false now resolves fine (field silently ignored)", () => {
		const result = validate(
			"sideEffectful(balance)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});
});

describe("semanticValidate — old() scope defense-in-depth (J)", () => {
	it("J: OLD_SCOPE error when an old node appears outside postconditions (bypassing parse-time enforcement)", () => {
		// Hand-built AST: the parser would reject old(...) in preconditions, so
		// this simulates an AST that reached the validator as if the
		// parse-time guard were bypassed (build-spec §5.1 defense-in-depth).
		const bypassAst: Node = {
			type: "old",
			ref: { type: "fieldRef", path: ["balance"] },
		};
		const result = semanticValidate(
			bypassAst,
			"preconditions",
			PRE0,
			makeContext(),
			PRE_SCOPE,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "OLD_SCOPE",
			field: "old",
		});
	});

	it("J: no OLD_SCOPE error for old() inside a postcondition; the inner ref still resolves", () => {
		const result = validate(
			"old(balance) <= balance",
			"postconditions",
			POST0,
			POST_SCOPE,
		);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});
});

describe("semanticValidate — low-confidence warning tier (K, ADR-0004)", () => {
	it("K: LOW_CONFIDENCE_FIELD warning for an inferred field; valid stays true", () => {
		const result = validate(
			"inferredField >= 0",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatchObject({
			code: "LOW_CONFIDENCE_FIELD",
			field: "inferredField",
		});
	});

	it("K: a declared confidence field emits no warning", () => {
		const result = validate("balance >= 0", "preconditions", PRE0, PRE_SCOPE);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});
});

describe("semanticValidate — params resolution scope (L)", () => {
	it("L: preconditions may reference operation params", () => {
		const result = validate("amount >= 1", "preconditions", PRE0, PRE_SCOPE);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("L: invariants may NOT reference operation params (UNKNOWN_FIELD)", () => {
		const result = validate("amount >= 1", "invariants", INV0, INV_SCOPE);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "UNKNOWN_FIELD",
			field: "amount",
		});
	});

	it("L: an enum-typed operation param is usable in preconditions", () => {
		const result = validate(
			'requestStatus in ["OPEN"]',
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

describe("semanticValidate — error/warning shape (M) + never-throws", () => {
	it("M: every hard error carries { contractId (echoed clauseId), code, field, detail } with nonempty detail", () => {
		const failing = [
			validate("nope >= 0", "preconditions", PRE0, PRE_SCOPE),
			validate("order.missing > 0", "preconditions", PRE0, PRE_SCOPE),
			validate('balance == "high"', "preconditions", PRE0, PRE_SCOPE),
			validate("status in 5", "preconditions", PRE0, PRE_SCOPE),
			validate("notRegistered(balance)", "preconditions", PRE0, PRE_SCOPE),
			validate("isPositive()", "preconditions", PRE0, PRE_SCOPE),
			validate("isPositive(status)", "preconditions", PRE0, PRE_SCOPE),
		];
		for (const result of failing) {
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
			for (const error of result.errors) {
				expect(error.contractId).toBe(PRE0);
				expect(typeof error.code).toBe("string");
				expect(error.code.length).toBeGreaterThan(0);
				expect(error.field.length).toBeGreaterThan(0);
				expect(error.detail.length).toBeGreaterThan(0);
			}
		}
	});

	it("M: warnings carry { code, field, detail } with nonempty detail", () => {
		const result = validate(
			"inferredField >= 0",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.warnings).toHaveLength(1);
		const warning = result.warnings[0];
		expect(warning.code).toBe("LOW_CONFIDENCE_FIELD");
		expect(warning.field.length).toBeGreaterThan(0);
		expect(warning.detail.length).toBeGreaterThan(0);
	});

	it("M: valid is false iff errors is non-empty, and warnings never flip valid", () => {
		const context = makeContext({
			manifests: {
				[OS]: {
					sourceHash: "man-os",
					fields: { inferredField: { type: "number", confidence: "inferred" } },
				},
			},
		});
		const withWarning = semanticValidate(
			{ type: "fieldRef", path: ["inferredField"] },
			"invariants",
			INV0,
			context,
			INV_SCOPE,
		);
		expect(withWarning.warnings.length).toBeGreaterThan(0);
		expect(withWarning.valid).toBe(true);
		expect(withWarning.errors).toEqual([]);
	});

	it("never throws when the component manifest entry is missing (defensive, structured failure)", () => {
		const context = makeContext({ manifests: {} });
		let result: ValidationResult | undefined;
		expect(() => {
			result = semanticValidate(
				{ type: "fieldRef", path: ["anything"] },
				"preconditions",
				PRE0,
				context,
				PRE_SCOPE,
			);
		}).not.toThrow();
		expect(result).toBeDefined();
		// ADR-0011 fix: when the component has no manifest entry (greenfield),
		// UNKNOWN_FIELD is suppressed — fields will be derived from contracts at emit time.
		expect(result?.valid).toBe(true);
		expect(result?.errors).toEqual([]);
	});

	it("never throws when the operation is absent from the contracts (params treat as none)", () => {
		const context = makeContext({ contracts: contractsFixture() });
		let result: ValidationResult | undefined;
		expect(() => {
			result = semanticValidate(
				{ type: "fieldRef", path: ["amount"] },
				"preconditions",
				PRE0,
				context,
				{ component: OS, operation: "doesNotExist" },
			);
		}).not.toThrow();
		expect(result).toBeDefined();
		// amount is a param of placeOrder, not doesNotExist, and not a manifest
		// field — so it fails to resolve without crashing.
		expect(result?.valid).toBe(false);
		expect(result?.errors[0]?.code).toBe("UNKNOWN_FIELD");
	});
});

describe("semanticValidate — [] wildcard field-path segment (decision 7)", () => {
	// build-spec §4.1: field_ref := IDENT ( "." IDENT | "[" NUMBER "]" | "[]" )*;
	// §4.3: FieldPath = (string | number | "[]")[]. Pinned decision 7: index
	// segments ("[0]", "[]") are valid only when the current type is list<T>
	// and strip the type to T. The parser emits the wildcard as the STRING "[]"
	// (parser.ts parseFieldRefSuffixes), so resolveFieldPath must dispatch "[]"
	// as an index BEFORE the nested-field-name branch — otherwise a list<T>
	// field emits a spurious UNRESOLVED_NESTED_FIELD ("not a component type").
	// docs/specs/manifest-extraction.md relies on the wildcard: order.items[].sku.
	//
	// RED phase (chunk 3.2c): (a)–(d) fail against current src; (e) negative
	// controls assert unchanged outcomes (valid:false + code + field — the
	// detail message for `[]` on a non-list changes from "not a component type"
	// to "not a list type" once the fix lands, so the message is not pinned);
	// (f) pins that none of the positives emit low-confidence warnings.

	it("a: [] on a list<number> field strips to the element type (items[] >= 0)", () => {
		const result = validate("items[] >= 0", "preconditions", PRE0, PRE_SCOPE);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("b: [] on a list<component> field then a nested name resolves (orders[].total > 0)", () => {
		const context = makeContext({
			manifests: {
				[OS]: {
					sourceHash: "man-os",
					fields: { orders: "list<Order>" },
				},
				Order: {
					sourceHash: "man-order",
					fields: { total: "number" },
				},
			},
		});
		const result = validate(
			"orders[].total > 0",
			"preconditions",
			PRE0,
			PRE_SCOPE,
			context,
		);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("c: chained wildcards resolve through nested lists (orders[].items[] >= 0)", () => {
		const context = makeContext({
			manifests: {
				[OS]: {
					sourceHash: "man-os",
					fields: { orders: "list<Order>" },
				},
				Order: {
					sourceHash: "man-order",
					fields: { items: "list<number>" },
				},
			},
		});
		const result = validate(
			"orders[].items[] >= 0",
			"preconditions",
			PRE0,
			PRE_SCOPE,
			context,
		);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("d: wildcard and numeric index mix in one reachable-set comparison (orders[].total > 0 and orders[0].total > 0)", () => {
		const context = makeContext({
			manifests: {
				[OS]: {
					sourceHash: "man-os",
					fields: { orders: "list<Order>" },
				},
				Order: {
					sourceHash: "man-order",
					fields: { total: "number" },
				},
			},
		});
		const result = validate(
			"orders[].total > 0 and orders[0].total > 0",
			"preconditions",
			PRE0,
			PRE_SCOPE,
			context,
		);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it('e: [] on a non-list field stays UNRESOLVED_NESTED_FIELD (name[] == "x")', () => {
		const context = makeContext({
			manifests: {
				[OS]: {
					sourceHash: "man-os",
					fields: { name: "string" },
				},
			},
		});
		const result = validate(
			'name[] == "x"',
			"preconditions",
			PRE0,
			PRE_SCOPE,
			context,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "UNRESOLVED_NESTED_FIELD",
			field: "name[]",
		});
	});

	it("e: a nested-name segment on a list<number> field stays UNRESOLVED_NESTED_FIELD (items.foo)", () => {
		const result = validate("items.foo > 0", "preconditions", PRE0, PRE_SCOPE);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "UNRESOLVED_NESTED_FIELD",
			field: "items.foo",
		});
	});

	it("e: a numeric index on a list<number> field remains valid (items[1] == 0)", () => {
		const result = validate("items[1] == 0", "preconditions", PRE0, PRE_SCOPE);
		expect(result).toEqual({ valid: true, errors: [], warnings: [] });
	});

	it("f: wildcard positives never emit LOW_CONFIDENCE_FIELD (all declared types)", () => {
		const context = makeContext({
			manifests: {
				[OS]: {
					sourceHash: "man-os",
					fields: { orders: "list<Order>" },
				},
				Order: {
					sourceHash: "man-order",
					fields: { total: "number", items: "list<number>" },
				},
			},
		});
		const result = validate(
			"orders[].total > 0 and orders[].items[] >= 0",
			"preconditions",
			PRE0,
			PRE_SCOPE,
			context,
		);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});
});

describe("semanticValidate — UNKNOWN_PREDICATE fuzzy-match suggestions (VERSAILLES-172)", () => {
	// New behavior (RED phase): when a predicateCall references an undeclared
	// predicate, the UNKNOWN_PREDICATE detail appends up to 2 suggestions for
	// declared keys within Levenshtein distance ≤ 2 — " — did you mean "X"?"
	// (two suggestions join as "a" or "b"). Pinned rule: ordering is
	// distance-then-alphabetical — closest match first, ties alphabetical.
	// Suggestions live ONLY in the detail string; the error shape
	// (code/field/detail/contractId) is unchanged. No suggestion when there are
	// no declared predicates at all or no declared key is within range.
	//
	// Default fixture declares: isPositive, isAvailable, noArg, sideEffectful,
	// missingPurity.

	it("F-fuzzy: a typo within distance 1 appends exactly one suggestion to the detail", () => {
		// isPositiv → isPositive = 1; every other declared key is ≥ 7.
		const result = validate(
			"isPositiv(balance)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			contractId: PRE0,
			code: "UNKNOWN_PREDICATE",
			field: "predicateCall(isPositiv)",
		});
		expect(result.errors[0].detail).toBe(
			'Predicate "isPositiv" is not declared in contracts.json — did you mean "isPositive"?',
		);
	});

	it("F-fuzzy: distance exactly 2 (the threshold boundary) still suggests the close key", () => {
		// isPostiv → isPositive = 2 (insert e, insert i); every other declared
		// key is ≥ 7, so this pins the ≤ 2 boundary on the near side.
		const result = validate(
			"isPostiv(balance)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "UNKNOWN_PREDICATE",
			field: "predicateCall(isPostiv)",
		});
		expect(result.errors[0].detail).toBe(
			'Predicate "isPostiv" is not declared in contracts.json — did you mean "isPositive"?',
		);
	});

	it("F-fuzzy: at most 2 suggestions, closest first — cap and distance-first ordering", () => {
		// isPositiv → isPositive = 1, isPositive2 = 2, isPositive3 = 2,
		// isAvailable = 8. Top 2: isPositive (distance 1), then the distance-2
		// tie broken alphabetically → isPositive2. isPositive3 is dropped by
		// the at-most-2 cap even though it is within range. isAvailable is
		// never suggested because it is beyond the ≤ 2 threshold.
		const context = makeContext({
			predicates: {
				isPositive: {
					params: ["n"],
					paramTypes: ["number"],
					returnType: "boolean",
					sourceRef: "Num.isPositive",
				},
				isPositive2: {
					params: ["n"],
					paramTypes: ["number"],
					returnType: "boolean",
					sourceRef: "Num.isPositive2",
				},
				isPositive3: {
					params: ["n"],
					paramTypes: ["number"],
					returnType: "boolean",
					sourceRef: "Num.isPositive3",
				},
				isAvailable: {
					params: ["status"],
					paramTypes: ["enum<OPEN,SHIPPED>"],
					returnType: "boolean",
					sourceRef: "Order.isAvailable",
				},
			},
		});
		const result = validate(
			"isPositiv(balance)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
			context,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "UNKNOWN_PREDICATE",
			field: "predicateCall(isPositiv)",
		});
		expect(result.errors[0].detail).toBe(
			'Predicate "isPositiv" is not declared in contracts.json — did you mean "isPositive" or "isPositive2"?',
		);
	});

	it("F-fuzzy: equal-distance ties break alphabetically, not by declaration order", () => {
		// isPositivee → isPositive = 1 AND isPositive2 = 1 (tie); isAvailable
		// is far. isPositive2 is declared FIRST so a naive insertion-order
		// implementation would suggest "isPositive2" first; the pinned rule
		// emits the alphabetically-earlier "isPositive" first.
		const context = makeContext({
			predicates: {
				isPositive2: {
					params: ["n"],
					paramTypes: ["number"],
					returnType: "boolean",
					sourceRef: "Num.isPositive2",
				},
				isPositive: {
					params: ["n"],
					paramTypes: ["number"],
					returnType: "boolean",
					sourceRef: "Num.isPositive",
				},
				isAvailable: {
					params: ["status"],
					paramTypes: ["enum<OPEN,SHIPPED>"],
					returnType: "boolean",
					sourceRef: "Order.isAvailable",
				},
			},
		});
		const result = validate(
			"isPositivee(balance)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
			context,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "UNKNOWN_PREDICATE",
			field: "predicateCall(isPositivee)",
		});
		expect(result.errors[0].detail).toBe(
			'Predicate "isPositivee" is not declared in contracts.json — did you mean "isPositive" or "isPositive2"?',
		);
	});

	it("F-fuzzy: a far-off name (distance > 2) keeps the plain detail — no suggestion", () => {
		// totallyWrong is ≥ 9 from every declared key → no "did you mean" suffix.
		const result = validate(
			"totallyWrong(balance)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "UNKNOWN_PREDICATE",
			field: "predicateCall(totallyWrong)",
		});
		expect(result.errors[0].detail).toBe(
			'Predicate "totallyWrong" is not declared in contracts.json',
		);
	});

	it("F-fuzzy: a workspace with an empty declared-predicates map never suggests", () => {
		const context = makeContext({ predicates: {} });
		const result = validate(
			"isPositive(balance)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
			context,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "UNKNOWN_PREDICATE",
			field: "predicateCall(isPositive)",
		});
		expect(result.errors[0].detail).toBe(
			'Predicate "isPositive" is not declared in contracts.json',
		);
	});

	it("F-fuzzy: a null predicates file (no declarations at all) never suggests", () => {
		const context = makeContext();
		context.predicates = null;
		const result = validate(
			"isPositive(balance)",
			"preconditions",
			PRE0,
			PRE_SCOPE,
			context,
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatchObject({
			code: "UNKNOWN_PREDICATE",
			field: "predicateCall(isPositive)",
		});
		expect(result.errors[0].detail).toBe(
			'Predicate "isPositive" is not declared in contracts.json',
		);
	});
});
