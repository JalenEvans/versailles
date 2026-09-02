/**
 * AST classification helpers (ADR-0020): the clause-shape classifiers and
 * AST-walking utilities the planner uses to decide how to plan a clause and
 * how to route its property strategy. Includes `resolveClauseShape`, the
 * resolver that maps a clause id + planning metadata to the strategy-table
 * input consumed by `selectStrategy`.
 */
import type { Node } from "../../../core/src/core/parser.js";
import type {
	ContractClause,
	ContractOperation,
	VersaillesContext,
} from "../../../core/src/loader/workspace.js";
import { type EvalEnv, evaluate } from "./evaluator.js";
import {
	buildPreState,
	buildValidParams,
	differentFrom,
	outsideValue,
} from "./input-synthesis.js";
import type { PropertyClauseMeta } from "./property-planning.js";
import type { ClauseShape as StrategyClauseShape } from "./strategy.js";

export type NumericOp = ">" | ">=" | "<" | "<=";

export type ClauseShape =
	| { kind: "numeric"; variable: string; op: NumericOp; boundary: number }
	| { kind: "in"; variable: string; members: unknown[] }
	| { kind: "predicateCall" }
	| { kind: "other" };

/** The compare ops `simpleCompareDescriptor`/postcondition handling act on. */
export const SIMPLE_COMPARE_OPS = new Set([">=", ">", "<=", "<", "==", "!="]);

/** Numeric compare-op inversion table (right-side subject normalization). */
export const INVERTED_NUMERIC_OP: Record<string, string> = {
	">": "<",
	"<": ">",
	">=": "<=",
	"<=": ">=",
};

/** Classifies a clause AST into the shapes the planner can act on. */
export function classifyClause(ast: Node): ClauseShape {
	if (ast.type === "predicateCall") {
		return { kind: "predicateCall" };
	}
	if (ast.type !== "compare") {
		return { kind: "other" };
	}
	let left = ast.left;
	let right = ast.right;
	let effectiveOp = ast.op;
	// Normalize `literal OP field` into `field invertedOP literal`.
	const leftVar = fieldRefName(left);
	const rightVar = fieldRefName(right);
	if (leftVar === null && rightVar !== null && isNumericOp(ast.op)) {
		const inverted: Record<string, NumericOp> = {
			">": "<",
			"<": ">",
			">=": "<=",
			"<=": ">=",
		};
		left = right;
		right = ast.left;
		effectiveOp = inverted[ast.op];
	}

	if (isNumericOp(effectiveOp)) {
		const variable = fieldRefName(left);
		if (
			variable !== null &&
			right.type === "literal" &&
			typeof right.value === "number"
		) {
			return {
				kind: "numeric",
				variable,
				op: effectiveOp,
				boundary: right.value,
			};
		}
		return { kind: "other" };
	}
	if (effectiveOp === "in") {
		const variable = fieldRefName(left);
		if (
			variable !== null &&
			right.type === "literal" &&
			Array.isArray(right.value)
		) {
			return { kind: "in", variable, members: right.value };
		}
		return { kind: "other" };
	}
	// Anything else (== / != / compound expressions) has no dedicated planner
	// branch: it falls through to planGenericViolationCase, which derives a
	// falsifying input straight from the AST.
	return { kind: "other" };
}

/**
 * Synthesizes a deterministic input falsifying the clause, for clauses that
 * are not covered by boundary/partition planning. Returns null when no
 * falsifying input can be derived (v1 heuristic).
 */
export function falsifyingInput(ast: Node): Record<string, unknown> | null {
	if (ast.type !== "compare") {
		return null;
	}
	const leftVar = fieldRefName(ast.left);
	if (leftVar !== null && ast.right.type === "literal") {
		const literal = ast.right.value;
		switch (ast.op) {
			case "!=":
				return { [leftVar]: literal };
			case "==":
				return { [leftVar]: differentFrom(literal) };
			case ">":
			case ">=":
				return typeof literal === "number" ? { [leftVar]: literal - 1 } : null;
			case "<":
			case "<=":
				return typeof literal === "number" ? { [leftVar]: literal + 1 } : null;
			case "in":
				return Array.isArray(literal)
					? { [leftVar]: outsideValue(literal) }
					: null;
		}
	}
	return null;
}

export function nodeReferencesParam(node: Node, name: string): boolean {
	switch (node.type) {
		case "fieldRef":
			return node.path[0] === name;
		case "old":
			return node.ref.path[0] === name;
		case "compare":
		case "arithmetic":
		case "and":
		case "or":
			return (
				nodeReferencesParam(node.left, name) ||
				nodeReferencesParam(node.right, name)
			);
		case "not":
			return nodeReferencesParam(node.operand, name);
		case "predicateCall":
			return node.args.some((arg) => nodeReferencesParam(arg, name));
		case "literal":
			return false;
	}
}

export function collectFieldRefs(node: Node, out: Set<string>): void {
	switch (node.type) {
		case "fieldRef":
			out.add(node.path[0] as string);
			break;
		case "old":
			out.add(node.ref.path[0] as string);
			break;
		case "compare":
		case "arithmetic":
		case "and":
		case "or":
			collectFieldRefs(node.left, out);
			collectFieldRefs(node.right, out);
			break;
		case "not":
			collectFieldRefs(node.operand, out);
			break;
		case "predicateCall":
			for (const arg of node.args) {
				collectFieldRefs(arg, out);
			}
			break;
		case "literal":
			break;
	}
}

export function fieldRefName(node: Node): string | null {
	if (
		node.type === "fieldRef" &&
		node.path.length === 1 &&
		typeof node.path[0] === "string"
	) {
		return node.path[0];
	}
	return null;
}

export function isNumericOp(op: string): op is NumericOp {
	return op === ">" || op === ">=" || op === "<" || op === "<=";
}

/**
 * Resolves a clause's RESOLVED strategy shape (build-spec §9.6): a top-level
 * compound wins over any numeric-bound sub-expression (compound precedence);
 * predicateCall preconditions classify by AST type; bothSideFieldRef
 * preconditions are the two-single-segment-fieldRef compare; postconditions
 * split literal-computable (postconditionAssertions can derive a matcher) from
 * uncomputable; invariants split effects-overlap (any operation in the
 * component mutates a referenced field) from plain.
 */
export function resolveClauseShape(
	clauseId: string,
	meta: Record<string, PropertyClauseMeta>,
	context: VersaillesContext,
): StrategyClauseShape {
	const m = meta[clauseId];
	const ast = context.parsedContracts[clauseId];
	// Defensive: a validated context parses every clause in the source stream,
	// so a missing meta/AST is unreachable. Resolve conservatively so the
	// strategy record stays total over suite.clauseIds.
	if (m === undefined || ast === undefined) {
		return { surface: "precondition", kind: "other" };
	}
	if (m.surface === "invariant") {
		const component = context.contracts?.contracts[m.component];
		const overlapping = Object.values(component?.operations ?? {}).some(
			(operation) => operationOverlapsInvariant(operation, ast),
		);
		return {
			surface: "invariant",
			kind: overlapping ? "effects-overlap" : "plain",
		};
	}
	if (m.surface === "postcondition") {
		const env =
			m.operation === null
				? undefined
				: postconditionEnv(m.operation, m.component, context);
		return {
			surface: "postcondition",
			kind:
				env !== undefined && postconditionIsComputable(ast, env)
					? "literal"
					: "uncomputable",
		};
	}
	// precondition
	if (ast.type === "and" || ast.type === "or") {
		return {
			surface: "precondition",
			kind: "compound",
			hasNumericBound: compoundHasNumericBound(ast),
		};
	}
	if (ast.type === "predicateCall") {
		return { surface: "precondition", kind: "predicateCall" };
	}
	const shape = classifyClause(ast);
	if (shape.kind === "numeric") {
		return { surface: "precondition", kind: "numeric-bound" };
	}
	if (shape.kind === "in") {
		return { surface: "precondition", kind: "in" };
	}
	if (ast.type === "compare") {
		if (fieldRefName(ast.left) !== null && fieldRefName(ast.right) !== null) {
			return { surface: "precondition", kind: "bothSideFieldRef" };
		}
	}
	return { surface: "precondition", kind: "other" };
}

/** True when the operation's effects touch a field the invariant references. */
export function operationOverlapsInvariant(
	operation: ContractOperation,
	invariantAst: Node,
): boolean {
	const effectFields = new Set(
		(operation.effects ?? []).map((effect) => effect.field),
	);
	const invariantFields = new Set<string>();
	collectFieldRefs(invariantAst, invariantFields);
	return [...effectFields].some((field) => invariantFields.has(field));
}

/**
 * The postcondition evaluation environment postconditionAssertions would use
 * for this operation (valid params + captured pre-state), used to decide
 * literal-computability.
 */
export function postconditionEnv(
	operation: ContractOperation,
	componentName: string,
	context: VersaillesContext,
): EvalEnv {
	const preconditions = operation.preconditions ?? [];
	const postconditions = operation.postconditions ?? [];
	const invariants =
		context.contracts?.contracts[componentName]?.invariants ?? [];
	const manifestFields =
		context.manifests?.manifests[componentName]?.fields ?? {};
	const validParams = buildValidParams(operation, preconditions, context);
	const preState = buildPreState(manifestFields, invariants, context, [
		...postconditions,
		...invariants,
	]);
	return { params: validParams, pre: preState, post: preState };
}

/**
 * Mirrors postconditionAssertions' descriptor decision exactly: a
 * `field op expr` / `expr op field` compare where exactly ONE side is a
 * single-segment fieldRef and the other side evaluates to a defined value is
 * literal-computable (the concrete case asserts a real matcher). Both-side
 * fieldRef compares (e.g. `status == newStatus`) and unresolvable expressions
 * are uncomputable → property.
 */
export function postconditionIsComputable(ast: Node, env: EvalEnv): boolean {
	if (ast.type !== "compare" || !SIMPLE_COMPARE_OPS.has(ast.op)) {
		return false;
	}
	const leftVar = fieldRefName(ast.left);
	const rightVar = fieldRefName(ast.right);
	let expr: Node;
	if (leftVar !== null && rightVar === null) {
		expr = ast.right;
	} else if (rightVar !== null && leftVar === null) {
		expr = ast.left;
	} else {
		return false;
	}
	return evaluate(expr, env) !== undefined;
}

/** True when a compound AST contains a numeric comparison sub-expression. */
export function compoundHasNumericBound(node: Node): boolean {
	if (node.type === "compare") {
		return isNumericOp(node.op);
	}
	if (node.type === "and" || node.type === "or") {
		return (
			compoundHasNumericBound(node.left) || compoundHasNumericBound(node.right)
		);
	}
	return false;
}
