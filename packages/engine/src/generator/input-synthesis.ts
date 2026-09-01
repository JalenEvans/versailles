/**
 * Input synthesis (ADR-0020): pre-call state construction, deterministic valid
 * call arguments, invariant/postcondition assertion descriptors, and the small
 * value-derivation helpers (defaults, enum members, partition-outside values)
 * that drive concrete-case planning.
 */
import type { Node } from "../../../core/src/core/parser.js";
import type {
	ContractClause,
	ContractOperation,
	VersaillesContext,
} from "../../../core/src/loader/workspace.js";
import {
	INVERTED_NUMERIC_OP,
	SIMPLE_COMPARE_OPS,
	classifyClause,
	collectFieldRefs,
	fieldRefName,
} from "./clause-analysis.js";
import { predicateValidValueForParam } from "./concrete-cases.js";
import { type EvalEnv, derivePostState, evaluate } from "./evaluator.js";
import type { AssertionDescriptor } from "./ir.js";

/** Default pre-state numeric value (≥ 0 keeps `balance >= 0` invariants true). */
export const PRE_STATE_NUMBER = 50;
/** Pre-state adjustment cap so the builder always terminates. */
export const PRE_STATE_ADJUST_ROUNDS = 10;
/** Deterministic sweep bound for the expected-rejection candidate search. */
export const EXPECTED_REJECTION_SWEEP_MAX = 300;

/**
 * Builds the pre-call component state from the manifest (deterministic default
 * per type), capturing ONLY the manifest fields the case's relevant clauses
 * actually reference (the operation's postconditions + the component's
 * invariants) so `old(field)` resolves and the emitted args carry just the
 * fields that matter — never every manifest field. Numeric fields are then
 * deterministically bumped until every invariant evaluates true (capped so
 * the builder always terminates).
 */
export function buildPreState(
	manifestFields: Record<string, string>,
	invariants: ContractClause[],
	context: VersaillesContext,
	relevantClauses: ContractClause[],
): Record<string, unknown> {
	const relevant = new Set<string>();
	for (const clause of relevantClauses) {
		const ast = context.parsedContracts[clause.id];
		if (ast !== undefined) {
			collectFieldRefs(ast, relevant);
		}
	}
	const state: Record<string, unknown> = {};
	for (const [field, typeRef] of Object.entries(manifestFields)) {
		if (relevant.has(field)) {
			state[field] = defaultValue(typeRef);
		}
	}
	for (let round = 0; round < PRE_STATE_ADJUST_ROUNDS; round++) {
		if (allInvariantsHold(state, invariants, context)) {
			break;
		}
		for (const field of Object.keys(state)) {
			if (typeof state[field] === "number") {
				state[field] = (state[field] as number) + PRE_STATE_NUMBER;
			}
		}
	}
	return state;
}

export function allInvariantsHold(
	state: Record<string, unknown>,
	invariants: ContractClause[],
	context: VersaillesContext,
): boolean {
	for (const invariant of invariants) {
		const ast = context.parsedContracts[invariant.id];
		if (
			ast !== undefined &&
			!evaluate(ast, { params: {}, pre: state, post: state })
		) {
			return false;
		}
	}
	return true;
}

/**
 * Center W2a: an invariant case must be self-consistent — its call inputs must
 * derive a post-state that still satisfies every invariant (e.g. amount <=
 * balance for `old(balance) - amount == balance` with `balance >= 0`). If the
 * operation's effects feed an invariant, sweep the first numeric param from
 * its valid lower bound upward and pick the first value whose derived
 * post-state honors all invariants. Falls back to the valid params when no
 * adjustment is needed or none can be derived (v1 heuristic — deterministic).
 */
export function pickInvariantPreservingParams(
	operation: ContractOperation,
	preconditions: ContractClause[],
	postconditions: ContractClause[],
	invariants: ContractClause[],
	manifestFields: Record<string, string>,
	preState: Record<string, unknown>,
	baseParams: Record<string, unknown>,
	context: VersaillesContext,
): Record<string, unknown> {
	const effectFields = new Set(
		(operation.effects ?? []).map((effect) => effect.field),
	);
	const invariantFields = new Set<string>();
	for (const invariant of invariants) {
		const ast = context.parsedContracts[invariant.id];
		if (ast !== undefined) {
			collectFieldRefs(ast, invariantFields);
		}
	}
	if (![...effectFields].some((field) => invariantFields.has(field))) {
		return baseParams;
	}

	const numericParams = (operation.params ?? [])
		.filter((param) => param.type.trim() === "number")
		.map((param) => param.name);
	if (numericParams.length === 0) {
		return baseParams;
	}
	const target = numericParams[0];
	const { lower, upper } = numericConstraintBounds(preconditions, context);
	const lo = lower[target] ?? Number.NEGATIVE_INFINITY;
	const hi = upper[target] ?? Number.POSITIVE_INFINITY;
	if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
		return baseParams;
	}

	for (
		let value = lo;
		value <= Math.min(hi, EXPECTED_REJECTION_SWEEP_MAX);
		value += 1
	) {
		const params = { ...baseParams, [target]: value };
		const post = derivePostState(
			postconditions,
			preState,
			params,
			effectFields,
			context,
		);
		if (allInvariantsHold(post, invariants, context)) {
			return params;
		}
	}
	return baseParams;
}

/**
 * Center W2b: derives renderable assertion descriptors from simple
 * `field op literal` invariants (e.g. `balance >= 0`) so the emitter can
 * assert the invariant's subject field with a real matcher. Compound or
 * non-comparable invariants contribute no descriptor.
 */
export function invariantAssertions(
	invariants: ContractClause[],
	context: VersaillesContext,
): AssertionDescriptor[] {
	const assertions: AssertionDescriptor[] = [];
	for (const invariant of invariants) {
		const ast = context.parsedContracts[invariant.id];
		if (ast === undefined) {
			continue;
		}
		const descriptor = simpleCompareDescriptor(ast);
		if (descriptor !== null) {
			assertions.push(descriptor);
		}
	}
	return assertions;
}

/**
 * Center W2b counterpart for postconditions (VERSAILLES-146): derives
 * renderable assertion descriptors from simple postcondition compares
 * (`field op expr` / `expr op field`) so a postcondition-satisfaction case
 * asserts the effect field with a real matcher instead of a bare call with no
 * assertion. The expected literal is the OTHER side evaluated against the
 * captured pre-state and the valid params — old() resolves to the captured
 * pre-state, and a bare field ref resolves params → post → pre with post ===
 * preState (DbC post-state resolution, Center W3): in a postcondition a bare
 * field IS the post-state, so while PLANNING the captured pre-state is the
 * only deterministic value available. E.g. `balance == old(balance) + price`
 * with pre-state balance 50 and valid price 1 derives
 * { subject: "balance", op: "==", literal: 51 } — the exact post-call value
 * the assertion must pin. Non-computable expressions (predicateCall,
 * unresolvable refs) contribute no descriptor — never a bad literal (mirrors
 * invariantAssertions' conservative skip).
 */
export function postconditionAssertions(
	postconditions: ContractClause[],
	preState: Record<string, unknown>,
	validParams: Record<string, unknown>,
	context: VersaillesContext,
): AssertionDescriptor[] {
	const assertions: AssertionDescriptor[] = [];
	const env: EvalEnv = { params: validParams, pre: preState, post: preState };
	for (const post of postconditions) {
		const ast = context.parsedContracts[post.id];
		if (
			ast === undefined ||
			ast.type !== "compare" ||
			!SIMPLE_COMPARE_OPS.has(ast.op)
		) {
			continue;
		}
		const leftVar = fieldRefName(ast.left);
		const rightVar = fieldRefName(ast.right);
		// Exactly ONE side is a single-segment fieldRef (the assertion
		// subject); the other side is the expected-value expression. Both-side
		// fieldRef compares (e.g. `status == newStatus`) are skipped — with no
		// unique field subject the descriptor would be ambiguous (mirrors
		// simpleCompareDescriptor's literal-only shape).
		let subject: string;
		let expr: Node;
		let inverted = false;
		if (leftVar !== null && rightVar === null) {
			subject = leftVar;
			expr = ast.right;
		} else if (rightVar !== null && leftVar === null) {
			subject = rightVar;
			expr = ast.left;
			inverted = true;
		} else {
			continue;
		}
		const literal = evaluate(expr, env);
		if (literal === undefined) {
			continue;
		}
		// Invert numeric ops when the subject sits on the RIGHT
		// (`old(balance) >= balance` → subject balance, op <=, literal 50);
		// == and != pass through. `balance != 0` keeps op "!=" and the
		// emitter's not.toEqual(0).
		const op =
			ast.op === "==" || ast.op === "!=" || !inverted
				? ast.op
				: INVERTED_NUMERIC_OP[ast.op];
		if (op === undefined) {
			continue;
		}
		assertions.push({
			subject,
			op: op as AssertionDescriptor["op"],
			literal,
		});
	}
	return assertions;
}

/**
 * Extracts `{ subject, op, literal }` from a `field op literal` / `literal op
 * field` compare node, or null for any other shape.
 */
export function simpleCompareDescriptor(ast: Node): AssertionDescriptor | null {
	if (ast.type !== "compare" || !SIMPLE_COMPARE_OPS.has(ast.op)) {
		return null;
	}
	const leftVar = fieldRefName(ast.left);
	const rightVar = fieldRefName(ast.right);
	if (leftVar !== null && ast.right.type === "literal") {
		return {
			subject: leftVar,
			op: ast.op as AssertionDescriptor["op"],
			literal: ast.right.value,
		};
	}
	if (rightVar !== null && ast.left.type === "literal") {
		const op =
			ast.op === "==" || ast.op === "!=" ? ast.op : INVERTED_NUMERIC_OP[ast.op];
		if (op === undefined) {
			return null;
		}
		return {
			subject: rightVar,
			op: op as AssertionDescriptor["op"],
			literal: ast.left.value,
		};
	}
	return null;
}

/**
 * Extracts per-variable numeric lower/upper bounds from numeric comparison
 * preconditions (the same classification buildValidParams relies on).
 */
export function numericConstraintBounds(
	preconditions: ContractClause[],
	context: VersaillesContext,
): { lower: Record<string, number>; upper: Record<string, number> } {
	const lower: Record<string, number> = {};
	const upper: Record<string, number> = {};
	for (const pre of preconditions) {
		const ast = context.parsedContracts[pre.id];
		if (ast === undefined) {
			continue;
		}
		const shape = classifyClause(ast);
		if (shape.kind !== "numeric") {
			continue;
		}
		const b = shape.boundary;
		if (shape.op === ">=") {
			lower[shape.variable] = Math.max(
				lower[shape.variable] ?? Number.NEGATIVE_INFINITY,
				b,
			);
		} else if (shape.op === ">") {
			lower[shape.variable] = Math.max(
				lower[shape.variable] ?? Number.NEGATIVE_INFINITY,
				b + 1,
			);
		} else if (shape.op === "<=") {
			upper[shape.variable] = Math.min(
				upper[shape.variable] ?? Number.POSITIVE_INFINITY,
				b,
			);
		} else {
			upper[shape.variable] = Math.min(
				upper[shape.variable] ?? Number.POSITIVE_INFINITY,
				b - 1,
			);
		}
	}
	return { lower, upper };
}

/**
 * Builds deterministic valid call arguments: numeric params pick a value
 * inside the intersection of their numeric comparison constraints; string
 * params pick the first `in`-clause member when constrained; enum params pick
 * their first member. Predicate-aware (VERSAILLES-23 F4, build-spec §9.1):
 * when a registered predicate-call precondition guards a numeric param and the
 * bounds-derived value is the provably-invalid default 0, the value is
 * replaced with one the predicate accepts (number → PREDICATE_VALID_NUMBER).
 * Non-zero bound-derived values are kept (e.g. amount >= 10 with
 * isPositive(amount) keeps 10 — overriding to 1 would break the bound).
 * Accept-side synthesis never pushes to warnings and never crashes.
 */
export function buildValidParams(
	operation: ContractOperation,
	preconditions: ContractClause[],
	context: VersaillesContext,
): Record<string, unknown> {
	const { lower, upper } = numericConstraintBounds(preconditions, context);
	const inFirst: Record<string, unknown> = {};
	for (const pre of preconditions) {
		const ast = context.parsedContracts[pre.id];
		if (ast === undefined) {
			continue;
		}
		const shape = classifyClause(ast);
		if (
			shape.kind === "in" &&
			inFirst[shape.variable] === undefined &&
			shape.members.length > 0
		) {
			inFirst[shape.variable] = shape.members[0];
		}
	}

	const params: Record<string, unknown> = {};
	for (const param of operation.params ?? []) {
		const typeRef = param.type.trim();
		if (typeRef === "number") {
			let value = pickNumeric(lower[param.name], upper[param.name]);
			// Conservative v1 predicate override: only when the derived value
			// is the provably-invalid default 0. A non-zero bound-derived value
			// already satisfies a positive-style predicate guard, so it stays.
			// The typeof guard also keeps boolean/string predicate values out of
			// the number branch (defensive; a validated context cannot pair a
			// number param with a non-number predicate paramType).
			if (value === 0) {
				const predicateValue = predicateValidValueForParam(
					param.name,
					preconditions,
					context,
				);
				if (typeof predicateValue === "number") {
					value = predicateValue;
				}
			}
			params[param.name] = value;
		} else if (typeRef === "string") {
			params[param.name] = inFirst[param.name] ?? "initial";
		} else if (typeRef === "boolean") {
			params[param.name] = false;
		} else {
			params[param.name] = defaultValue(typeRef);
		}
	}
	return params;
}

export function pickNumeric(
	lower: number | undefined,
	upper: number | undefined,
): number {
	if (lower !== undefined && upper !== undefined) {
		return Math.floor((lower + upper) / 2);
	}
	if (lower !== undefined) {
		return lower;
	}
	if (upper !== undefined) {
		return upper;
	}
	return 0;
}

/** Deterministic default value per manifest/param typeRef. */
export function defaultValue(typeRef: string): unknown {
	const trimmed = typeRef.trim();
	if (trimmed === "number") {
		return PRE_STATE_NUMBER;
	}
	if (trimmed === "boolean") {
		return false;
	}
	if (trimmed === "string") {
		return "initial";
	}
	if (trimmed.startsWith("enum<")) {
		const members = enumMembers(trimmed) ?? [];
		return members[0] ?? "initial";
	}
	if (trimmed.startsWith("list<")) {
		return [];
	}
	if (trimmed.startsWith("optional<")) {
		return defaultValue(trimmed.slice("optional<".length, -1));
	}
	return null;
}

export function differentFrom(value: unknown): unknown {
	if (value === null) {
		return "value";
	}
	if (typeof value === "number") {
		return value === 0 ? 1 : value - 1;
	}
	if (typeof value === "boolean") {
		return !value;
	}
	return `${String(value)}-other`;
}

/** A deterministic value outside the partition member set. */
export function outsideValue(members: unknown[]): unknown {
	if (members.every((member) => typeof member === "string")) {
		let candidate = "INVALID";
		while (members.includes(candidate)) {
			candidate = `_${candidate}`;
		}
		return candidate;
	}
	if (members.every((member) => typeof member === "number")) {
		let candidate = Math.max(...(members as number[])) + 1;
		while (members.includes(candidate)) {
			candidate += 1;
		}
		return candidate;
	}
	if (members.includes(true) && !members.includes(false)) {
		return false;
	}
	if (members.includes(false) && !members.includes(true)) {
		return true;
	}
	return "INVALID";
}

/** Parses `enum<v1,v2,...>` typeRefs into their member values. */
export function enumMembers(typeRef: string): unknown[] | null {
	const match = /^enum<(.+)>$/.exec(typeRef.trim());
	if (match === null) {
		return null;
	}
	return match[1]
		.split(",")
		.map((member) => member.trim())
		.filter((member) => member !== "")
		.map(parseEnumMember);
}

export function parseEnumMember(raw: string): string | number | boolean {
	if (raw === "true") {
		return true;
	}
	if (raw === "false") {
		return false;
	}
	if (/^[0-9]+$/.test(raw)) {
		return Number(raw);
	}
	return raw;
}
