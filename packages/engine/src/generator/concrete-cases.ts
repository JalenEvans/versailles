/**
 * Concrete-case planners (ADR-0020): the build-spec §9.1 boundary / partition /
 * enum-partition / generic-violation / predicate-violation planners and the
 * §9.2 expected-rejection sweep, plus the predicate falsification heuristics.
 */
import type { Node } from "../../../core/src/core/parser.js";
import type {
	ContractClause,
	ContractOperation,
	LoaderWarning,
	VersaillesContext,
} from "../../../core/src/loader/workspace.js";
import type { PredicateEntry } from "../../../core/src/predicates/registry.js";
import type { ClauseShape } from "./clause-analysis.js";
import { collectFieldRefs, falsifyingInput } from "./clause-analysis.js";
import { derivePostState, evaluate } from "./evaluator.js";
import {
	EXPECTED_REJECTION_SWEEP_MAX,
	buildPreState,
	buildValidParams,
	outsideValue,
} from "./input-synthesis.js";
import type { CaseKind, PlannedCase } from "./ir.js";

/**
 * Deterministic numeric counter-example for predicate falsification
 * (VERSAILLES-22 F3, build-spec §9.1): number → -1. Chosen over 0 because 0
 * SATISFIES isNonNegative-style predicates (n >= 0), so it would not falsify
 * them; -1 deterministically falsifies positive, non-negative, even,
 * greater-than-threshold, and similar numeric predicates the v1 heuristic must
 * reject. No registry example-hint field exists yet, so paramTypes alone drive
 * the synthesis (a `can`, not a `must`, per the contract).
 */
const PREDICATE_FALSIFY_NUMBER = -1;
/**
 * Deterministic numeric value the v1 accept-side heuristic uses for a
 * predicate-guarded number param (VERSAILLES-23 F4, build-spec §9.1,
 * deterministic-generation.contract.yaml example: isPositive → 1): the positive
 * counterpart of PREDICATE_FALSIFY_NUMBER. Chosen over 0 because 0 is provably
 * invalid for positive-style predicates (isPositive(0) is false); 1 is the
 * smallest value positive, non-negative, and similar numeric predicates accept.
 * No registry example-hint field exists yet, so paramTypes alone drive the
 * synthesis (a `can`, not a `must`, per the contract).
 */
const PREDICATE_VALID_NUMBER = 1;

type ExpectedRejection = {
	inputs: Record<string, unknown>;
	violatedInvariants: string[];
	satisfiedPostconditions: string[];
};

/**
 * §9.1 boundary planning: three cases at boundary−1, boundary, boundary+1
 * with value-derived outcomes. For `x >= b`, boundary−1 rejects; for
 * `x <= b`, boundary+1 rejects. The reject case doubles as the clause's
 * precondition-violation case.
 *
 * Case-input isolation (VERSAILLES-148, build-spec §9.1): a boundary case must
 * satisfy every OTHER param while this one probes the boundary, so each input
 * merges buildValidParams UNDER the target value — buildValidParams FIRST,
 * boundary value LAST so the overlay wins (the reject needs price=0 while the
 * base gives price=1); siblings keep deterministic valid values, never
 * undefined.
 */
export function planBoundaryCases(
	shape: Extract<ClauseShape, { kind: "numeric" }>,
	clauseId: string,
	cases: PlannedCase[],
	nextId: (kind: CaseKind) => string,
	idiom: string,
	operation: ContractOperation,
	preconditions: ContractClause[],
	context: VersaillesContext,
): void {
	const base = buildValidParams(operation, preconditions, context);
	const b = shape.boundary;
	const spec: { value: number; outcome: "accept" | "reject"; label: string }[] =
		[];
	switch (shape.op) {
		case ">=":
			spec.push({ value: b - 1, outcome: "reject", label: "boundary-1" });
			spec.push({ value: b, outcome: "accept", label: "boundary" });
			spec.push({ value: b + 1, outcome: "accept", label: "boundary+1" });
			break;
		case ">":
			spec.push({ value: b - 1, outcome: "reject", label: "boundary-1" });
			spec.push({ value: b, outcome: "reject", label: "boundary" });
			spec.push({ value: b + 1, outcome: "accept", label: "boundary+1" });
			break;
		case "<=":
			spec.push({ value: b - 1, outcome: "accept", label: "boundary-1" });
			spec.push({ value: b, outcome: "accept", label: "boundary" });
			spec.push({ value: b + 1, outcome: "reject", label: "boundary+1" });
			break;
		case "<":
			spec.push({ value: b - 1, outcome: "accept", label: "boundary-1" });
			spec.push({ value: b, outcome: "reject", label: "boundary" });
			spec.push({ value: b + 1, outcome: "reject", label: "boundary+1" });
			break;
	}
	for (const item of spec) {
		cases.push({
			id: nextId("boundary"),
			kind: "boundary",
			description: `${item.label} (${item.outcome}): ${shape.variable}=${item.value} ${item.outcome === "reject" ? "falsifies" : "satisfies"} ${clauseId}`,
			inputs: { ...base, [shape.variable]: item.value },
			expects:
				item.outcome === "reject"
					? { outcome: "reject", rejectionIdiom: idiom }
					: { outcome: "accept" },
			traces: [clauseId],
		});
	}
}

/**
 * §9.1 equivalence partitions for an `in` clause: one case per member
 * (accept) plus one outside the set (reject, configured idiom — this also
 * serves as the clause's violation input).
 *
 * Case-input isolation (VERSAILLES-148, build-spec §9.1): a partition case
 * must satisfy every OTHER param while this one probes the member set, so each
 * input merges buildValidParams UNDER the target value — buildValidParams
 * FIRST, member/outside value LAST so the overlay wins; siblings keep
 * deterministic valid values, never undefined.
 */
export function planPartitionCases(
	shape: Extract<ClauseShape, { kind: "in" }>,
	clauseId: string,
	cases: PlannedCase[],
	nextId: (kind: CaseKind) => string,
	idiom: string,
	operation: ContractOperation,
	preconditions: ContractClause[],
	context: VersaillesContext,
): void {
	const base = buildValidParams(operation, preconditions, context);
	for (const member of shape.members) {
		cases.push({
			id: nextId("partition"),
			kind: "partition",
			description: `member ${String(member)} of ${clauseId}`,
			inputs: { ...base, [shape.variable]: member },
			expects: { outcome: "accept" },
			traces: [clauseId],
		});
	}
	cases.push({
		id: nextId("partition"),
		kind: "partition",
		description: `value outside the set of ${clauseId}`,
		inputs: { ...base, [shape.variable]: outsideValue(shape.members) },
		expects: { outcome: "reject", rejectionIdiom: idiom },
		traces: [clauseId],
	});
}

/**
 * §9.1 equivalence partitions for an enum-typed param (e.g. `enum<GOLD,SILVER>`
 * from the operation params): one case per member (accept) plus one outside
 * the set (reject). Traces the first clause that constrains the param (or the
 * operation's first precondition / the component's first invariant) so traces
 * stay non-empty and machine-checkable.
 *
 * Case-input isolation (VERSAILLES-148, build-spec §9.1): an enum-partition
 * case must satisfy every OTHER param while this one probes the enum, so each
 * input merges buildValidParams UNDER the target value — buildValidParams
 * FIRST, member/outside value LAST so the overlay wins; siblings keep
 * deterministic valid values, never undefined.
 */
export function planEnumPartitionCases(
	paramName: string,
	members: unknown[],
	clauseId: string,
	cases: PlannedCase[],
	nextId: (kind: CaseKind) => string,
	idiom: string,
	operation: ContractOperation,
	preconditions: ContractClause[],
	context: VersaillesContext,
): void {
	const base = buildValidParams(operation, preconditions, context);
	for (const member of members) {
		cases.push({
			id: nextId("partition"),
			kind: "partition",
			description: `enum member ${String(member)} of ${paramName}`,
			inputs: { ...base, [paramName]: member },
			expects: { outcome: "accept" },
			traces: [clauseId],
		});
	}
	cases.push({
		id: nextId("partition"),
		kind: "partition",
		description: `value outside enum ${paramName}`,
		inputs: { ...base, [paramName]: outsideValue(members) },
		expects: { outcome: "reject", rejectionIdiom: idiom },
		traces: [clauseId],
	});
}

/**
 * §9.1 precondition-violation for clauses that cannot double as a
 * boundary/partition reject (e.g. `newTier != null`). Synthesizes a
 * deterministic falsifying input; clauses we cannot falsify are skipped
 * (v1 heuristic — no SMT solver, build-spec §9.5). Top-level predicate-call
 * clauses NEVER reach here (they are routed to planPredicateViolationCase, so
 * their coverage gap is never silent).
 *
 * Violation-case isolation (VERSAILLES-147, build-spec §9.1): the case must
 * satisfy ALL *other* clauses while falsifying this one, so the falsifier is
 * merged OVER buildValidParams — every non-falsified param keeps a
 * deterministic valid value, never undefined (the committed example's
 * `addItem("", undefined)` left price undefined, falsifying `isPositive(price)`
 * too). Ordering matters: buildValidParams FIRST, falsifier OVERLAY LAST so
 * the falsifier wins on its own param.
 */
export function planGenericViolationCase(
	ast: Node,
	clauseId: string,
	cases: PlannedCase[],
	nextId: (kind: CaseKind) => string,
	idiom: string,
	operation: ContractOperation,
	preconditions: ContractClause[],
	context: VersaillesContext,
): void {
	const falsifier = falsifyingInput(ast);
	if (falsifier === null) {
		return;
	}
	const inputs = {
		...buildValidParams(operation, preconditions, context),
		...falsifier,
	};
	cases.push({
		id: nextId("precondition-violation"),
		kind: "precondition-violation",
		description: `violates ${clauseId}`,
		inputs,
		expects: { outcome: "reject", rejectionIdiom: idiom },
		traces: [clauseId],
	});
}

/**
 * §9.1 predicate-call violation synthesis (deterministic-generation.contract.yaml
 * + build-spec §9.1, VERSAILLES-22 F3): a precondition whose AST is a
 * predicate call (e.g. `isPositive(amount)`) must produce at least one
 * deterministic violation case, or an explicit non-silent PREDICATE_UNPLANNABLE
 * warning — never a silent zero. The falsifying input is synthesized purely
 * from the registered predicate's paramTypes (no randomness, ADR-0002); the
 * case is a normal §9.1 violation case (kind "precondition-violation", traces
 * the clause id, outcome reject with the configured rejection idiom, ADR-0007).
 *
 * Violation-case isolation (VERSAILLES-147, build-spec §9.1): the case must
 * satisfy ALL *other* clauses while falsifying this one, so the falsifier is
 * merged OVER buildValidParams — every non-falsified param keeps a
 * deterministic valid value, never undefined (the committed example's
 * `addItem(undefined, -1)` left sku undefined, falsifying `sku != ""` too).
 * Ordering matters: buildValidParams FIRST, falsifier OVERLAY LAST so the
 * falsifier wins on its own param.
 */
export function planPredicateViolationCase(
	ast: Extract<Node, { type: "predicateCall" }>,
	clauseId: string,
	cases: PlannedCase[],
	nextId: (kind: CaseKind) => string,
	idiom: string,
	warnings: LoaderWarning[],
	context: VersaillesContext,
	operation: ContractOperation,
	preconditions: ContractClause[],
): void {
	const entry = context.predicates?.predicates?.[ast.name];
	if (entry === undefined) {
		warnings.push({
			code: "PREDICATE_UNPLANNABLE",
			field: clauseId,
			detail: `Predicate "${ast.name}" is not declared in contracts.json — no falsifying input can be derived for ${clauseId}`,
		});
		return;
	}
	const falsifier = predicateFalsifyingInput(ast, entry);
	if (falsifier === null) {
		warnings.push({
			code: "PREDICATE_UNPLANNABLE",
			field: clauseId,
			detail: `Cannot deterministically falsify predicate call "${ast.name}" for ${clauseId} — the v1 heuristic requires the first argument to be a single-segment field reference with a primitive paramType (number, boolean, or string)`,
		});
		return;
	}
	const inputs = {
		...buildValidParams(operation, preconditions, context),
		...{ [falsifier.argName]: falsifier.value },
	};
	cases.push({
		id: nextId("precondition-violation"),
		kind: "precondition-violation",
		description: `violates ${clauseId} (predicate ${ast.name} falsified via ${falsifier.argName})`,
		inputs,
		expects: { outcome: "reject", rejectionIdiom: idiom },
		traces: [clauseId],
	});
}

/** A deterministic falsifying input for one predicate call argument. */
type PredicateFalsifier = { argName: string; value: unknown };

/**
 * The v1 falsification heuristic (build-spec §9.5 keeps SMT out of v1 scope):
 * the predicate's FIRST argument is the guarded value — its single-segment
 * fieldRef name becomes the inputs key, and the predicate's first paramType
 * determines the deterministic counter-example (number → -1, boolean → false,
 * string → ""). Returns null when genuinely unplannable: no args, a
 * non-fieldRef or multi-segment first argument, or a paramType the heuristic
 * cannot reason about (e.g. "list<number>", optional/component/enum types).
 */
export function predicateFalsifyingInput(
	ast: Extract<Node, { type: "predicateCall" }>,
	entry: PredicateEntry,
): PredicateFalsifier | null {
	const firstArg = ast.args[0];
	if (
		firstArg === undefined ||
		firstArg.type !== "fieldRef" ||
		firstArg.path.length !== 1 ||
		typeof firstArg.path[0] !== "string"
	) {
		return null;
	}
	const paramType = entry.paramTypes[0]?.trim() ?? "";
	if (paramType === "number") {
		return { argName: firstArg.path[0], value: PREDICATE_FALSIFY_NUMBER };
	}
	if (paramType === "boolean") {
		return { argName: firstArg.path[0], value: false };
	}
	if (paramType === "string") {
		return { argName: firstArg.path[0], value: "" };
	}
	return null;
}

/**
 * The v1 accept-side counterpart of predicateFalsifyingInput (VERSAILLES-23
 * F4, build-spec §9.1, deterministic-generation.contract.yaml): for a
 * top-level predicateCall precondition whose FIRST argument is a single-segment
 * fieldRef, returns a deterministic value the registered predicate ACCEPTS per
 * paramTypes[0] (number → PREDICATE_VALID_NUMBER, boolean → true, string →
 * "ok"). Returns undefined — no override, no warning, no crash — when the
 * argument is not a single-segment fieldRef or the paramType is one the v1
 * heuristic cannot reason about (e.g. "list<number>", optional/component/enum
 * types). Accept-side synthesis NEVER pushes to suite.warnings: the
 * PREDICATE_UNPLANNABLE channel is violation-only (F3), so a degenerate
 * accept-all predicate must plan an accept with NO warning and NO crash.
 */
export function predicateValidValue(
	ast: Extract<Node, { type: "predicateCall" }>,
	entry: PredicateEntry,
): unknown | undefined {
	const firstArg = ast.args[0];
	if (
		firstArg === undefined ||
		firstArg.type !== "fieldRef" ||
		firstArg.path.length !== 1 ||
		typeof firstArg.path[0] !== "string"
	) {
		return undefined;
	}
	const paramType = entry.paramTypes[0]?.trim() ?? "";
	if (paramType === "number") {
		return PREDICATE_VALID_NUMBER;
	}
	if (paramType === "boolean") {
		return true;
	}
	if (paramType === "string") {
		return "ok";
	}
	return undefined;
}

/**
 * Finds the first registered predicate-call precondition guarding a param — a
 * top-level predicateCall whose first argument is a single-segment fieldRef
 * naming the param — and returns the value that predicate ACCEPTS per
 * paramTypes[0]. Returns undefined when no guard applies (predicate-less
 * param, unregistered predicate, non-fieldRef / multi-segment arg, unknown
 * paramType): every one of those is a conservative no-override path with no
 * warning and no crash.
 */
export function predicateValidValueForParam(
	paramName: string,
	preconditions: ContractClause[],
	context: VersaillesContext,
): unknown | undefined {
	for (const pre of preconditions) {
		const ast = context.parsedContracts[pre.id];
		if (ast === undefined || ast.type !== "predicateCall") {
			continue;
		}
		const firstArg = ast.args[0];
		if (
			firstArg?.type !== "fieldRef" ||
			firstArg.path.length !== 1 ||
			typeof firstArg.path[0] !== "string" ||
			firstArg.path[0] !== paramName
		) {
			continue;
		}
		const entry = context.predicates?.predicates?.[ast.name];
		if (entry === undefined) {
			continue;
		}
		const value = predicateValidValue(
			ast as Extract<Node, { type: "predicateCall" }>,
			entry,
		);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

/**
 * §9.2 expected-rejection: a deterministic sweep over the operation's first
 * numeric param, other params at valid defaults, searching for inputs where
 * every postcondition evaluates true (old() resolved against the captured
 * pre-state) but at least one component invariant evaluates false post-call.
 * Only ops whose effects touch a field referenced by an invariant can
 * participate (otherwise no candidate can violate one). First hit wins — no
 * randomness. Returns null when no candidate exists.
 */
export function planExpectedRejection(
	operation: ContractOperation,
	preconditions: ContractClause[],
	postconditions: ContractClause[],
	invariants: ContractClause[],
	manifestFields: Record<string, string>,
	context: VersaillesContext,
): ExpectedRejection | null {
	if (postconditions.length === 0 || invariants.length === 0) {
		return null;
	}

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
		return null;
	}

	const numericParams = (operation.params ?? [])
		.filter((param) => param.type.trim() === "number")
		.map((param) => param.name);
	if (numericParams.length === 0) {
		return null;
	}
	const target = numericParams[0];
	const preState = buildPreState(manifestFields, invariants, context, [
		...postconditions,
		...invariants,
	]);
	// Soundness guard: cannot evaluate invariants against unknown state. If
	// the preState does not contain every field referenced by the invariants
	// (greenfield has no field types; brownfield partial manifest), skip.
	if (![...invariantFields].every((field) => field in preState)) {
		return null;
	}
	const baseParams = buildValidParams(operation, preconditions, context);

	for (let value = 1; value <= EXPECTED_REJECTION_SWEEP_MAX; value++) {
		const params = { ...baseParams, [target]: value };
		const post = derivePostState(
			postconditions,
			preState,
			params,
			effectFields,
			context,
		);
		const satisfied = postconditions.filter((postClause) => {
			const ast = context.parsedContracts[postClause.id];
			return (
				ast !== undefined &&
				Boolean(evaluate(ast, { params, pre: preState, post }))
			);
		});
		const violated = invariants.filter((invariant) => {
			const ast = context.parsedContracts[invariant.id];
			return (
				ast !== undefined && !evaluate(ast, { params: {}, pre: post, post })
			);
		});
		if (satisfied.length > 0 && violated.length > 0) {
			return {
				inputs: { ...params, ...preState },
				violatedInvariants: violated.map((invariant) => invariant.id),
				satisfiedPostconditions: satisfied.map((postClause) => postClause.id),
			};
		}
	}
	return null;
}
