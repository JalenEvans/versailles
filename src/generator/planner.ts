/**
 * The deterministic case planner (build-spec §9.1–§9.2, ADR-0002/0007).
 *
 * A pure function from a validated VersaillesContext (isValid: true) to the
 * framework-agnostic PlannedSuite IR. No randomness, no timestamps, no LLM —
 * same context in, byte-identical suite out.
 *
 * §9.1 per-operation cases:
 * - Boundary values: for every numeric comparison in preconditions, cases at
 *   the boundary, boundary−1, and boundary+1 with value-derived outcomes. The
 *   falsifying boundary case doubles as that clause's precondition-violation
 *   case (tests find violation cases by (traces, outcome, falsifying input),
 *   never by kind).
 * - Equivalence partitions: for every `in` clause or enum-typed param, one
 *   case per member (accept) plus one outside the set (reject, configured
 *   idiom — for an `in` clause it is also that clause's violation input).
 * - Precondition-violation cases: for clauses that cannot double as a
 *   boundary/partition reject (e.g. `x != null`), a dedicated case whose input
 *   falsifies the clause; outcome reject with the configured idiom.
 * - Postcondition-satisfaction cases: valid inputs asserted against every
 *   postcondition, with the captured pre-call state stored in `inputs` under
 *   the manifest field names so `old(field)` resolves.
 *
 * §9.2 per-component invariant tests (only for components WITH invariants):
 * - Invariant cases per operation: valid pre-state, call with valid inputs,
 *   assert every invariant post-call.
 * - Expected-rejection cases: inputs satisfying the operation's postconditions
 *   but leaving a component invariant violated — the operation should refuse
 *   to complete (the bug class DbC is designed to catch). Lives in
 *   suite.invariantCases.
 */
import type { Node } from "../core/parser.js";
import type {
	ContractClause,
	ContractOperation,
	VersaillesContext,
} from "../loader/workspace.js";
import type {
	AssertionDescriptor,
	CaseKind,
	CoverageManifest,
	OperationCaseGroup,
	PlannedCase,
	PlannedSuite,
} from "./ir.js";

type NumericOp = ">" | ">=" | "<" | "<=";

type ClauseShape =
	| { kind: "numeric"; variable: string; op: NumericOp; boundary: number }
	| { kind: "in"; variable: string; members: unknown[] }
	| { kind: "other" };

type EvalEnv = {
	params: Record<string, unknown>;
	pre: Record<string, unknown>;
	post: Record<string, unknown>;
};

type ExpectedRejection = {
	inputs: Record<string, unknown>;
	violatedInvariants: string[];
	satisfiedPostconditions: string[];
};

/** Default pre-state numeric value (≥ 0 keeps `balance >= 0` invariants true). */
const PRE_STATE_NUMBER = 50;
/** Deterministic sweep bound for the expected-rejection candidate search. */
const EXPECTED_REJECTION_SWEEP_MAX = 300;
/** Pre-state adjustment cap so the builder always terminates. */
const PRE_STATE_ADJUST_ROUNDS = 10;

/**
 * Valid JS identifier (Center W1): component / operation / param names flow
 * into generated files as import specifiers, describe titles, method calls and
 * object keys. Anything else would let hostile contract names break out of the
 * generated surface, so the planner refuses to plan them.
 */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function assertSafeIdentifier(name: string, what: string): void {
	if (!IDENTIFIER_RE.test(name)) {
		throw new Error(
			`Refusing to generate tests: ${what} "${name}" is not a valid JS identifier (must match /^[A-Za-z_$][A-Za-z0-9_$]*$/)`,
		);
	}
}

/**
 * Gate: no component / operation / param name may flow raw into a generated
 * file (Center W1). Clause ids are dotted contract paths, not identifiers, so
 * they are NOT validated here — the emitter escapes them instead.
 */
function assertSafeIdentifiers(context: VersaillesContext): void {
	if (context.contracts === null) {
		return;
	}
	for (const [componentName, component] of Object.entries(
		context.contracts.contracts,
	)) {
		assertSafeIdentifier(componentName, "component name");
		for (const [operationName, operation] of Object.entries(
			component.operations ?? {},
		)) {
			assertSafeIdentifier(operationName, "operation name");
			for (const param of operation.params ?? []) {
				assertSafeIdentifier(param.name, "param name");
			}
		}
	}
}

/**
 * Plans the full test-case suite for a validated context. Throws when
 * `context.isValid` is false — generation only runs against approved
 * contracts (contract invariant 1, build-spec §9).
 */
export function planTestCases(context: VersaillesContext): PlannedSuite {
	if (!context.isValid) {
		throw new Error(
			"planTestCases requires a validated context (isValid: true) — generation is blocked for invalid contracts",
		);
	}
	if (context.contracts === null) {
		throw new Error("planTestCases requires a contracts store in the context");
	}
	assertSafeIdentifiers(context);

	const idiom = context.config?.rejection?.idiom ?? "throws";
	const operations: OperationCaseGroup[] = [];
	const invariantCases: PlannedCase[] = [];
	const clauseIds: string[] = [];

	for (const [componentName, component] of Object.entries(
		context.contracts.contracts,
	)) {
		const invariants = component.invariants ?? [];
		for (const invariant of invariants) {
			clauseIds.push(invariant.id);
		}
		const manifestFields =
			context.manifests?.manifests[componentName]?.fields ?? {};

		// Component-level counter: expected-rejection ids carry the operation
		// segment "<component>.<operation>.expected-rejection-<n>" (Center B1)
		// so the emitter can derive the real operation name from segment 1.
		// The counter itself stays component-scoped so ids stay unique even
		// when several operations contribute §9.2 cases.
		const componentCounters: Partial<Record<CaseKind, number>> = {};
		const nextComponentId = (kind: CaseKind, operation: string): string => {
			const current = componentCounters[kind] ?? 0;
			componentCounters[kind] = current + 1;
			return `${componentName}.${operation}.${kind}-${current}`;
		};

		for (const [operationName, operation] of Object.entries(
			component.operations ?? {},
		)) {
			const preconditions = operation.preconditions ?? [];
			const postconditions = operation.postconditions ?? [];
			for (const pre of preconditions) {
				clauseIds.push(pre.id);
			}
			for (const post of postconditions) {
				clauseIds.push(post.id);
			}

			const cases: PlannedCase[] = [];
			const counters: Partial<Record<CaseKind, number>> = {};
			const nextId = (kind: CaseKind): string => {
				const current = counters[kind] ?? 0;
				counters[kind] = current + 1;
				return `${componentName}.${operationName}.${kind}-${current}`;
			};

			// §9.1 — per-operation cases.
			for (const pre of preconditions) {
				const ast = context.parsedContracts[pre.id];
				if (ast === undefined) {
					continue;
				}
				const shape = classifyClause(ast);
				if (shape.kind === "numeric") {
					planBoundaryCases(shape, pre.id, cases, nextId, idiom);
				} else if (shape.kind === "in") {
					planPartitionCases(shape, pre.id, cases, nextId, idiom);
				} else {
					planGenericViolationCase(ast, pre.id, cases, nextId, idiom);
				}
			}

			// §9.1 — enum-typed params are an equivalence-partition source.
			for (const param of operation.params ?? []) {
				const members = enumMembers(param.type);
				if (members === null) {
					continue;
				}
				const traceClause = findTraceClause(
					preconditions,
					invariants,
					param.name,
					context,
				);
				if (traceClause === null) {
					continue;
				}
				planEnumPartitionCases(
					param.name,
					members,
					traceClause.id,
					cases,
					nextId,
					idiom,
				);
			}

			// §9.1 — postcondition-satisfaction (only when there is a
			// postcondition to assert; traces must stay non-empty).
			if (postconditions.length > 0) {
				const validParams = buildValidParams(operation, preconditions, context);
				const preState = buildPreState(manifestFields, invariants, context);
				const postIds = postconditions.map((post) => post.id);
				cases.push({
					id: nextId("postcondition-satisfaction"),
					kind: "postcondition-satisfaction",
					description: `valid input asserting postconditions ${postIds.join(", ")}`,
					inputs: { ...validParams, ...preState },
					expects: { outcome: "accept", postconditions: postIds },
					traces: postIds,
				});
			}

			// §9.2 — per-component invariant tests (none for a component
			// without invariants).
			if (invariants.length > 0) {
				const validParams = buildValidParams(operation, preconditions, context);
				const preState = buildPreState(manifestFields, invariants, context);
				// Center W2a: pick call inputs whose DERIVED post-state still
				// satisfies every invariant (e.g. amount <= balance for
				// `old(balance) - amount == balance` with `balance >= 0`) —
				// the case must be self-consistent.
				const invariantParams = pickInvariantPreservingParams(
					operation,
					preconditions,
					postconditions,
					invariants,
					manifestFields,
					preState,
					validParams,
					context,
				);
				const invariantIds = invariants.map((invariant) => invariant.id);
				// Center W2b: thread real assertion descriptors for simple
				// `field op literal` invariants so the emitter renders
				// `expect(result.balance).toBeGreaterThanOrEqual(0)` instead
				// of a bare toBeDefined() accept render.
				const assertions = invariantAssertions(invariants, context);
				invariantCases.push({
					id: nextId("invariant"),
					kind: "invariant",
					description: `call ${componentName}.${operationName} and assert invariant ${invariantIds.join(", ")} still holds`,
					inputs: { ...invariantParams, ...preState },
					expects: {
						outcome: "accept",
						postconditions: invariantIds,
						assertions,
					},
					traces: invariantIds,
				});

				const rejection = planExpectedRejection(
					operation,
					preconditions,
					postconditions,
					invariants,
					manifestFields,
					context,
				);
				if (rejection !== null) {
					invariantCases.push({
						id: nextComponentId("expected-rejection", operationName),
						kind: "expected-rejection",
						description: `postconditions hold but invariant ${rejection.violatedInvariants.join(", ")} would be violated`,
						inputs: rejection.inputs,
						expects: { outcome: "reject", rejectionIdiom: idiom },
						traces: [
							...rejection.violatedInvariants,
							...rejection.satisfiedPostconditions,
						],
					});
				}
			}

			operations.push({
				component: componentName,
				operation: operationName,
				cases,
			});
		}
	}

	return { operations, invariantCases, clauseIds };
}

/**
 * Builds the traceability manifest: every source clause ID → the test IDs
 * that trace it; clauses with no generated test stay representable as empty
 * arrays (§9.3). Pure function of the suite — deterministic.
 */
export function coverageManifest(suite: PlannedSuite): CoverageManifest {
	const coverage: Record<string, string[]> = {};
	for (const clauseId of suite.clauseIds) {
		coverage[clauseId] = [];
	}
	const all = allCases(suite);
	for (const case_ of all) {
		for (const clauseId of case_.traces) {
			if (clauseId in coverage) {
				coverage[clauseId].push(case_.id);
			}
		}
	}
	return { coverage };
}

function allCases(suite: PlannedSuite): PlannedCase[] {
	return [
		...suite.operations.flatMap((group) => group.cases),
		...suite.invariantCases,
	];
}

/**
 * §9.1 boundary planning: three cases at boundary−1, boundary, boundary+1
 * with value-derived outcomes. For `x >= b`, boundary−1 rejects; for
 * `x <= b`, boundary+1 rejects. The reject case doubles as the clause's
 * precondition-violation case.
 */
function planBoundaryCases(
	shape: Extract<ClauseShape, { kind: "numeric" }>,
	clauseId: string,
	cases: PlannedCase[],
	nextId: (kind: CaseKind) => string,
	idiom: string,
): void {
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
			inputs: { [shape.variable]: item.value },
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
 */
function planPartitionCases(
	shape: Extract<ClauseShape, { kind: "in" }>,
	clauseId: string,
	cases: PlannedCase[],
	nextId: (kind: CaseKind) => string,
	idiom: string,
): void {
	for (const member of shape.members) {
		cases.push({
			id: nextId("partition"),
			kind: "partition",
			description: `member ${String(member)} of ${clauseId}`,
			inputs: { [shape.variable]: member },
			expects: { outcome: "accept" },
			traces: [clauseId],
		});
	}
	cases.push({
		id: nextId("partition"),
		kind: "partition",
		description: `value outside the set of ${clauseId}`,
		inputs: { [shape.variable]: outsideValue(shape.members) },
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
 */
function planEnumPartitionCases(
	paramName: string,
	members: unknown[],
	clauseId: string,
	cases: PlannedCase[],
	nextId: (kind: CaseKind) => string,
	idiom: string,
): void {
	for (const member of members) {
		cases.push({
			id: nextId("partition"),
			kind: "partition",
			description: `enum member ${String(member)} of ${paramName}`,
			inputs: { [paramName]: member },
			expects: { outcome: "accept" },
			traces: [clauseId],
		});
	}
	cases.push({
		id: nextId("partition"),
		kind: "partition",
		description: `value outside enum ${paramName}`,
		inputs: { [paramName]: outsideValue(members) },
		expects: { outcome: "reject", rejectionIdiom: idiom },
		traces: [clauseId],
	});
}

/**
 * §9.1 precondition-violation for clauses that cannot double as a
 * boundary/partition reject (e.g. `newTier != null`). Synthesizes a
 * deterministic falsifying input; clauses we cannot falsify are skipped
 * (v1 heuristic — no SMT solver, build-spec §9.5).
 */
function planGenericViolationCase(
	ast: Node,
	clauseId: string,
	cases: PlannedCase[],
	nextId: (kind: CaseKind) => string,
	idiom: string,
): void {
	const falsifier = falsifyingInput(ast);
	if (falsifier === null) {
		return;
	}
	cases.push({
		id: nextId("precondition-violation"),
		kind: "precondition-violation",
		description: `violates ${clauseId}`,
		inputs: falsifier,
		expects: { outcome: "reject", rejectionIdiom: idiom },
		traces: [clauseId],
	});
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
function planExpectedRejection(
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
	const preState = buildPreState(manifestFields, invariants, context);
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

/**
 * Builds the pre-call component state from the manifest (deterministic default
 * per type), then deterministically bumps numeric fields until every invariant
 * evaluates true (capped so the builder always terminates). Invariants are
 * evaluated against the state itself (invariants reference manifest fields).
 */
function buildPreState(
	manifestFields: Record<string, string>,
	invariants: ContractClause[],
	context: VersaillesContext,
): Record<string, unknown> {
	const state: Record<string, unknown> = {};
	for (const [field, typeRef] of Object.entries(manifestFields)) {
		state[field] = defaultValue(typeRef);
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

function allInvariantsHold(
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
function pickInvariantPreservingParams(
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
function invariantAssertions(
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

const SIMPLE_COMPARE_OPS = new Set([">=", ">", "<=", "<", "==", "!="]);

const INVERTED_NUMERIC_OP: Record<string, string> = {
	">": "<",
	"<": ">",
	">=": "<=",
	"<=": ">=",
};

/**
 * Extracts `{ subject, op, literal }` from a `field op literal` / `literal op
 * field` compare node, or null for any other shape.
 */
function simpleCompareDescriptor(ast: Node): AssertionDescriptor | null {
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
function numericConstraintBounds(
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
 * their first member.
 */
function buildValidParams(
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
			params[param.name] = pickNumeric(lower[param.name], upper[param.name]);
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

function pickNumeric(
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
function defaultValue(typeRef: string): unknown {
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

/**
 * Derives the post-call state from postconditions of the shape
 * `expr == f` / `f == expr` where f is an effect field (e.g.
 * `old(balance) - amount == balance` → post.balance = old(balance) - amount).
 * Used only by the expected-rejection search.
 */
function derivePostState(
	postconditions: ContractClause[],
	pre: Record<string, unknown>,
	params: Record<string, unknown>,
	effectFields: Set<string>,
	context: VersaillesContext,
): Record<string, unknown> {
	const post: Record<string, unknown> = { ...pre };
	for (const clause of postconditions) {
		const ast = context.parsedContracts[clause.id];
		if (ast === undefined || ast.type !== "compare" || ast.op !== "==") {
			continue;
		}
		const rightVar = fieldRefName(ast.right);
		if (rightVar !== null && effectFields.has(rightVar)) {
			post[rightVar] = evaluate(ast.left, { params, pre, post });
		}
		const leftVar = fieldRefName(ast.left);
		if (leftVar !== null && effectFields.has(leftVar)) {
			post[leftVar] = evaluate(ast.right, { params, pre, post });
		}
	}
	return post;
}

/**
 * A tiny evaluator over the restricted, side-effect-free grammar — enough to
 * resolve `old(field)` against the captured pre-state and check
 * invariants/postconditions during planning. Pure and deterministic.
 */
function evaluate(node: Node, env: EvalEnv): unknown {
	switch (node.type) {
		case "literal":
			return node.value;
		case "fieldRef": {
			const root = node.path[0];
			if (typeof root === "string") {
				// DbC post-state resolution (Center W3): in postcondition
				// evaluation a bare field ref is the POST-state — only
				// old(...) names the pre-state. Resolution order is therefore
				// params → post → pre. (Callers that evaluate invariants and
				// preconditions pass pre === post, so this order is neutral
				// there.)
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
			const left = evaluate(node.left, env);
			const right = evaluate(node.right, env);
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
			const left = evaluate(node.left, env);
			const right = evaluate(node.right, env);
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
				Boolean(evaluate(node.left, env)) && Boolean(evaluate(node.right, env))
			);
		case "or":
			return (
				Boolean(evaluate(node.left, env)) || Boolean(evaluate(node.right, env))
			);
		case "not":
			return !evaluate(node.operand, env);
		case "predicateCall":
			return undefined;
	}
	return undefined;
}

/** Classifies a clause AST into the shapes the planner can act on. */
function classifyClause(ast: Node): ClauseShape {
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
function falsifyingInput(ast: Node): Record<string, unknown> | null {
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

function differentFrom(value: unknown): unknown {
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
function outsideValue(members: unknown[]): unknown {
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
function enumMembers(typeRef: string): unknown[] | null {
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

function parseEnumMember(raw: string): string | number | boolean {
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

/**
 * Picks the clause a partition/other case should trace: the first precondition
 * referencing the param, else the first precondition, else the first
 * invariant. Guarantees non-empty traces for every planned case.
 */
function findTraceClause(
	preconditions: ContractClause[],
	invariants: ContractClause[],
	paramName: string,
	context: VersaillesContext,
): ContractClause | null {
	const referenced = preconditions.find((pre) => {
		const ast = context.parsedContracts[pre.id];
		return ast !== undefined && nodeReferencesParam(ast, paramName);
	});
	if (referenced !== undefined) {
		return referenced;
	}
	if (preconditions.length > 0) {
		return preconditions[0];
	}
	if (invariants.length > 0) {
		return invariants[0];
	}
	return null;
}

function nodeReferencesParam(node: Node, name: string): boolean {
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

function collectFieldRefs(node: Node, out: Set<string>): void {
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

function fieldRefName(node: Node): string | null {
	if (
		node.type === "fieldRef" &&
		node.path.length === 1 &&
		typeof node.path[0] === "string"
	) {
		return node.path[0];
	}
	return null;
}

function isNumericOp(op: string): op is NumericOp {
	return op === ">" || op === ">=" || op === "<" || op === "<=";
}
