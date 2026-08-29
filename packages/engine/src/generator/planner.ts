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
 * - Predicate-call preconditions: a top-level predicate call (e.g.
 *   `isPositive(amount)`) gets one deterministic violation case synthesized
 *   from the registered predicate's paramTypes, or a non-silent
 *   PREDICATE_UNPLANNABLE suite warning when genuinely unplannable — never a
 *   silent zero (deterministic-generation.contract.yaml, VERSAILLES-22 F3).
 * - Predicate-aware valid inputs: valid-input synthesis (buildValidParams)
 *   replaces a provably-invalid bounds-derived value (the default 0) with a
 *   value the registered predicate accepts (number → 1), so a predicate guard
 *   never receives an input it rejects on the accept side
 *   (deterministic-generation.contract.yaml, VERSAILLES-23 F4).
 * - Unplannable operations (VERSAILLES-25): a staged operation whose component
 *   carries extracted method metadata but that is MISSING from it — no
 *   matching method metadata and no resolvable source method — is never
 *   emitted as the legacy static options-object call (dead, unrunnable code).
 *   Instead it surfaces a non-silent UNPLANNABLE_OPERATION suite warning (the
 *   same LoaderWarning tier as PREDICATE_UNPLANNABLE, VERSAILLES-22 F3) and
 *   its cases are skipped while its clause ids stay mapped in coverage.json as
 *   a detectable zero-coverage gap (build-spec §9.1/§9.3). A component with NO
 *   methods key stays fully legacy — byte-identical options-object emission.
 * - Postcondition-satisfaction cases: valid inputs asserted against every
 *   postcondition, with the captured pre-call state stored in `inputs` under
 *   the manifest field names so `old(field)` resolves. Simple
 *   `field op expr` postconditions also derive real matcher assertions
 *   (`expects.assertions`) with old() + arithmetic resolved against the
 *   captured pre-state and valid params, so the emitter asserts the effect
 *   field instead of a bare call (VERSAILLES-146).
 *
 * §9.2 per-component invariant tests (only for components WITH invariants):
 * - Invariant cases per operation: valid pre-state, call with valid inputs,
 *   assert every invariant post-call.
 * - Expected-rejection cases: inputs satisfying the operation's postconditions
 *   but leaving a component invariant violated — the operation should refuse
 *   to complete (the bug class DbC is designed to catch). Lives in
 *   suite.invariantCases.
 */
import type { Node } from "../../../core/src/core/parser.js";
import type {
	ContractClause,
	ContractOperation,
	LoaderWarning,
	VersaillesContext,
} from "../../../core/src/loader/workspace.js";
import type { PredicateEntry } from "../../../core/src/predicates/registry.js";
import { renderClausePredicate } from "./codegen.js";
import type {
	ArbitrarySpec,
	AssertionDescriptor,
	CaseKind,
	CoverageManifest,
	OperationCaseGroup,
	PlannedCase,
	PlannedSuite,
	PropertyClause,
	PropertyDescriptor,
	PropertyOutcome,
	PropertyPlan,
} from "./ir.js";
import { derivePropertySeed } from "./seed.js";
import type {
	ClauseShape as StrategyClauseShape,
	StrategyMap,
} from "./strategy.js";
import { selectStrategy } from "./strategy.js";

type NumericOp = ">" | ">=" | "<" | "<=";

type ClauseShape =
	| { kind: "numeric"; variable: string; op: NumericOp; boundary: number }
	| { kind: "in"; variable: string; members: unknown[] }
	| { kind: "predicateCall" }
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
	// Suite-level planning warnings (VERSAILLES-22 F3): a genuinely
	// unplannable predicate-call precondition lands here instead of silently
	// producing zero cases. LoaderWarning shape, ADR-0004 non-blocking tier.
	const warnings: LoaderWarning[] = [];

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

			// VERSAILLES-25 (deterministic-generation.contract.yaml §9.1): a
			// staged operation with no matching method metadata and no
			// resolvable source method must NOT be emitted as the legacy
			// static options-object call (`<Component>.<op>({ ...inputs })`) —
			// that is dead, unrunnable code (TypeError at runtime) with no
			// signal. The authoritative "no resolvable source method" signal is
			// the component's extracted methods map (F1): when the map EXISTS
			// but the staged op is missing from it, warn non-silently (same
			// LoaderWarning tier as PREDICATE_UNPLANNABLE) and skip the op's
			// cases. A component with NO methods key stays fully legacy —
			// "no matching metadata" is vacuously false there, so legacy
			// suites keep their byte-identical options-object emission.
			const componentMethods =
				context.manifests?.manifests[componentName]?.methods;
			if (
				componentMethods !== undefined &&
				componentMethods[operationName] === undefined
			) {
				const operationId = `${componentName}.${operationName}`;
				const present = Object.keys(componentMethods).join(", ");
				warnings.push({
					code: "UNPLANNABLE_OPERATION",
					field: operationId,
					detail: `Staged operation ${operationId} has no matching method in ${componentName}'s extracted methods metadata (present: ${present || "none"}) — no resolvable source method, so its cases are skipped and no call is emitted`,
				});
				// Keep the operation group in the suite with EMPTY cases: the
				// component's file still renders (the CLI e2e reads it), and
				// the clause ids collected above stay mapped in coverage.json
				// as a detectable zero-coverage gap (contract can: skip the
				// cases, keep the coverage gap visible). The emitter renders
				// no invocation for an empty-case group — and never the
				// legacy options-object call.
				operations.push({
					component: componentName,
					operation: operationName,
					cases,
				});
				continue;
			}

			// §9.1 — per-operation cases.
			for (const pre of preconditions) {
				const ast = context.parsedContracts[pre.id];
				if (ast === undefined) {
					continue;
				}
				const shape = classifyClause(ast);
				if (shape.kind === "numeric") {
					planBoundaryCases(
						shape,
						pre.id,
						cases,
						nextId,
						idiom,
						operation,
						preconditions,
						context,
					);
				} else if (shape.kind === "in") {
					planPartitionCases(
						shape,
						pre.id,
						cases,
						nextId,
						idiom,
						operation,
						preconditions,
						context,
					);
				} else if (shape.kind === "predicateCall") {
					// classifyClause returns "predicateCall" exactly when
					// ast.type === "predicateCall", so the cast is safe and
					// narrows the Node union for the synthesizer.
					planPredicateViolationCase(
						ast as Extract<Node, { type: "predicateCall" }>,
						pre.id,
						cases,
						nextId,
						idiom,
						warnings,
						context,
						operation,
						preconditions,
					);
				} else {
					planGenericViolationCase(
						ast,
						pre.id,
						cases,
						nextId,
						idiom,
						operation,
						preconditions,
						context,
					);
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
					operation,
					preconditions,
					context,
				);
			}

			// §9.1 — postcondition-satisfaction (only when there is a
			// postcondition to assert; traces must stay non-empty).
			if (postconditions.length > 0) {
				const validParams = buildValidParams(operation, preconditions, context);
				const preState = buildPreState(manifestFields, invariants, context, [
					...postconditions,
					...invariants,
				]);
				const postIds = postconditions.map((post) => post.id);
				// VERSAILLES-146: derive real matcher assertions from the
				// postconditions (old() + arithmetic resolved against the
				// captured pre-state and valid params) so the emitter never
				// reduces a satisfaction case to a bare call with no
				// assertion. Same preState/validParams objects the case inputs
				// are built from — the assertions must pin exactly the
				// post-state those inputs derive.
				const assertions = postconditionAssertions(
					postconditions,
					preState,
					validParams,
					context,
				);
				cases.push({
					id: nextId("postcondition-satisfaction"),
					kind: "postcondition-satisfaction",
					description: `valid input asserting postconditions ${postIds.join(", ")}`,
					inputs: { ...validParams, ...preState },
					expects: { outcome: "accept", postconditions: postIds, assertions },
					traces: postIds,
				});
			}

			// §9.2 — per-component invariant tests (none for a component
			// without invariants).
			if (invariants.length > 0) {
				const validParams = buildValidParams(operation, preconditions, context);
				const preState = buildPreState(manifestFields, invariants, context, [
					...postconditions,
					...invariants,
				]);
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

				// §9.2 expected-rejection (ADR-0017): when
				// config.propertyBased.enabled is true the seeded PBT planner
				// emits the expected-rejection PROPERTY (planPropertyBlocks),
				// so the §9.2 bounded sweep (EXPECTED_REJECTION_SWEEP_MAX) is
				// REPLACED — no expected-rejection case enters
				// suite.invariantCases. When disabled/absent the sweep remains
				// the v1 fallback. This gating keeps the v1 default output
				// byte-identical (backward-compat pin, ADR-0017).
				const pbtEnabled = context.config?.propertyBased?.enabled === true;
				if (!pbtEnabled) {
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
			}

			operations.push({
				component: componentName,
				operation: operationName,
				cases,
			});
		}
	}

	return { operations, invariantCases, clauseIds, warnings };
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
 *
 * Case-input isolation (VERSAILLES-148, build-spec §9.1): a boundary case must
 * satisfy every OTHER param while this one probes the boundary, so each input
 * merges buildValidParams UNDER the target value — buildValidParams FIRST,
 * boundary value LAST so the overlay wins (the reject needs price=0 while the
 * base gives price=1); siblings keep deterministic valid values, never
 * undefined.
 */
function planBoundaryCases(
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
function planPartitionCases(
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
function planEnumPartitionCases(
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
function planGenericViolationCase(
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
function planPredicateViolationCase(
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
function predicateFalsifyingInput(
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
function predicateValidValue(
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
function predicateValidValueForParam(
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

/**
 * Builds the pre-call component state from the manifest (deterministic default
 * per type), capturing ONLY the manifest fields the case's relevant clauses
 * actually reference (the operation's postconditions + the component's
 * invariants) so `old(field)` resolves and the emitted args carry just the
 * fields that matter — never every manifest field. Numeric fields are then
 * deterministically bumped until every invariant evaluates true (capped so
 * the builder always terminates).
 */
function buildPreState(
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
function postconditionAssertions(
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
 * their first member. Predicate-aware (VERSAILLES-23 F4, build-spec §9.1):
 * when a registered predicate-call precondition guards a numeric param and the
 * bounds-derived value is the provably-invalid default 0, the value is
 * replaced with one the predicate accepts (number → PREDICATE_VALID_NUMBER).
 * Non-zero bound-derived values are kept (e.g. amount >= 10 with
 * isPositive(amount) keeps 10 — overriding to 1 would break the bound).
 * Accept-side synthesis never pushes to warnings and never crashes.
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

// ── Seeded PBT emission — planPropertyBlocks (ADR-0017, build-spec §9.6) ─────
//
// The property-block planner: a pure function of the ALREADY-PLANNED concrete
// suite (for the full source clause-id stream) plus the loaded context (for
// param typeRefs, effects, enum members, parsed clause ASTs, the predicates
// registry, and config.propertyBased). Same inputs → identical
// descriptors/strategies/warnings (ADR-0002, re-scoped to generation-time by
// ADR-0017).
//
// Per-clause strategy gating (selectStrategy, Chunk 4): "example" → NO
// property block (the concrete §9.1/§9.2 cases fully cover it); "property"
// and "property-with-falsifier" → an ACCEPT-side satisfies block is planned
// (the deterministic example falsifier of a predicateCall precondition is
// retained in the concrete suite). Effects-overlap invariants → an
// invariant-preserving block. Expected-rejection (enabled) → a rejects block
// tracing the §9.2 sweep's deterministic first-hit set (violated invariants +
// satisfied postconditions) with the configured rejection idiom (ADR-0007).

/** Per-clause planning metadata — which operation/component owns a clause. */
type PropertyClauseMeta = {
	component: string;
	operationName: string | null;
	operation: ContractOperation | null;
	surface: "precondition" | "postcondition" | "invariant";
};

/** Per-param ArbitrarySpec derivation result; unplannable names the culprit. */
type ArbitrarySpecResult = {
	specs: ArbitrarySpec[];
	unplannable: string | null;
};

/**
 * Builds the per-clause metadata lookup with the same component → operation →
 * clauses traversal planTestCases uses, so every source clause id in
 * suite.clauseIds resolves to its surface and owning operation.
 */
function collectClauseMeta(
	context: VersaillesContext,
): Record<string, PropertyClauseMeta> {
	const meta: Record<string, PropertyClauseMeta> = {};
	for (const [componentName, component] of Object.entries(
		context.contracts?.contracts ?? {},
	)) {
		for (const invariant of component.invariants ?? []) {
			meta[invariant.id] = {
				component: componentName,
				operationName: null,
				operation: null,
				surface: "invariant",
			};
		}
		for (const [operationName, operation] of Object.entries(
			component.operations ?? {},
		)) {
			for (const pre of operation.preconditions ?? []) {
				meta[pre.id] = {
					component: componentName,
					operationName,
					operation,
					surface: "precondition",
				};
			}
			for (const post of operation.postconditions ?? []) {
				meta[post.id] = {
					component: componentName,
					operationName,
					operation,
					surface: "postcondition",
				};
			}
		}
	}
	return meta;
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
function resolveClauseShape(
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
function operationOverlapsInvariant(
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
function postconditionEnv(
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
function postconditionIsComputable(ast: Node, env: EvalEnv): boolean {
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
function compoundHasNumericBound(node: Node): boolean {
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

/**
 * Builds the per-param { min, max } bounds map from the raw per-variable
 * lower/upper records (the shape the ArbitrarySpec bounds field requires —
 * build-spec §9.6). Only params with BOTH bounds resolved carry a bounds
 * object; the map is what buildArbitrarySpecs consumes AFTER cross-param
 * propagation has extended the records (VERSAILLES-165).
 */
function numericBoundsFromRecords(
	operation: ContractOperation,
	lower: Record<string, number>,
	upper: Record<string, number>,
): Record<string, { min: number; max: number }> {
	const out: Record<string, { min: number; max: number }> = {};
	for (const param of operation.params ?? []) {
		if (param.type.trim() !== "number") {
			continue;
		}
		const lo = lower[param.name];
		const hi = upper[param.name];
		if (lo !== undefined && hi !== undefined) {
			out[param.name] = { min: lo, max: hi };
		}
	}
	return out;
}

/**
 * Recurses an AST collecting per-variable numeric lower/upper bounds from
 * every numeric comparison inside `and`-chain leaves and top-level numeric
 * leaves. Center W4: `or` subtrees are SKIPPED entirely — an `or` disjunct
 * does not imply either side holds (`a >= 0 or b >= 0` bounds neither a nor b
 * individually), so `or`-derived bounds would feed unsound values into
 * cross-param propagation. `literal OP field` compares are normalized to
 * `field invertedOP literal` before the bound is applied.
 */
function collectNumericBounds(
	node: Node,
	lower: Record<string, number>,
	upper: Record<string, number>,
): void {
	if (node.type === "and") {
		collectNumericBounds(node.left, lower, upper);
		collectNumericBounds(node.right, lower, upper);
		return;
	}
	if (node.type === "or") {
		// W4: never collect from a disjunct — see the docstring.
		return;
	}
	if (node.type !== "compare" || !isNumericOp(node.op)) {
		return;
	}
	const inverted: Record<NumericOp, NumericOp> = {
		">": "<",
		"<": ">",
		">=": "<=",
		"<=": ">=",
	};
	let left = node.left;
	let right = node.right;
	let op = node.op;
	const leftVar = fieldRefName(left);
	const rightVar = fieldRefName(right);
	if (leftVar === null && rightVar !== null && isNumericOp(op)) {
		left = right;
		right = node.left;
		op = inverted[op];
	}
	const variable = fieldRefName(left);
	if (
		variable === null ||
		right.type !== "literal" ||
		typeof right.value !== "number"
	) {
		return;
	}
	const b = right.value;
	if (op === ">=") {
		lower[variable] = Math.max(lower[variable] ?? Number.NEGATIVE_INFINITY, b);
	} else if (op === ">") {
		lower[variable] = Math.max(
			lower[variable] ?? Number.NEGATIVE_INFINITY,
			b + 1,
		);
	} else if (op === "<=") {
		upper[variable] = Math.min(upper[variable] ?? Number.POSITIVE_INFINITY, b);
	} else {
		upper[variable] = Math.min(
			upper[variable] ?? Number.POSITIVE_INFINITY,
			b - 1,
		);
	}
}

/**
 * Derives the per-param ArbitrarySpec list for an operation from its param
 * typeRefs, enum members, and the compound-aware numeric bounds. list<X> →
 * inner kind + default []; optional<X> → inner kind + the inner type's
 * deterministic default. A component-typed (or otherwise unrepresentable) param
 * has no ArbitrarySpec kind, so the whole operation's property blocks are
 * unplannable (the clause's valid region cannot become filterable arbitraries).
 * Center W1: an INVERTED derived bound (min > max — contradictory leaves like
 * `x >= 10 and x <= 5`, or cross-param propagation that over-constrains a
 * coupling) makes the region unsatisfiable — fc.integer({ min, max }) with
 * min > max throws at runtime, so the operation's descriptors are
 * PROPERTY_UNPLANNABLE instead of emitting a broken arbitrary.
 */
function buildArbitrarySpecs(
	operation: ContractOperation,
	bounds: Record<string, { min: number; max: number }>,
): ArbitrarySpecResult {
	const specs: ArbitrarySpec[] = [];
	for (const param of operation.params ?? []) {
		const paramBounds = bounds[param.name];
		if (paramBounds !== undefined && paramBounds.min > paramBounds.max) {
			return {
				specs: [],
				unplannable: `"${param.name}" (derived bounds { min: ${paramBounds.min}, max: ${paramBounds.max}} are inverted — the valid region is unsatisfiable)`,
			};
		}
		const spec = arbitrarySpecForType(
			param.name,
			param.type,
			bounds[param.name],
		);
		if (spec === null) {
			return {
				specs: [],
				unplannable: `"${param.name}" (type "${param.type}")`,
			};
		}
		specs.push(spec);
	}
	return { specs, unplannable: null };
}

/**
 * Maps one param typeRef to its ArbitrarySpec (kind = the fast-check arbitrary
 * family the emitter renders). Returns null for typeRefs with no kind
 * (component-typed and other unrepresentable types).
 */
function arbitrarySpecForType(
	param: string,
	typeRef: string,
	bounds: { min: number; max: number } | undefined,
): ArbitrarySpec | null {
	const trimmed = typeRef.trim();
	if (trimmed === "number") {
		return {
			param,
			typeRef,
			kind: "number",
			...(bounds === undefined ? {} : { bounds }),
		};
	}
	if (trimmed === "string") {
		return { param, typeRef, kind: "string" };
	}
	if (trimmed === "boolean") {
		return { param, typeRef, kind: "boolean" };
	}
	if (/^enum<(.+)>$/.test(trimmed)) {
		return {
			param,
			typeRef,
			kind: "enum",
			members: enumMembers(trimmed) ?? [],
		};
	}
	if (trimmed.startsWith("list<")) {
		const inner = trimmed.slice("list<".length, -1);
		const innerSpec = arbitrarySpecForType(param, inner, undefined);
		if (innerSpec === null) {
			return null;
		}
		return { ...innerSpec, typeRef, default: [] };
	}
	if (trimmed.startsWith("optional<")) {
		const inner = trimmed.slice("optional<".length, -1);
		const innerSpec = arbitrarySpecForType(param, inner, undefined);
		if (innerSpec === null) {
			return null;
		}
		return { ...innerSpec, typeRef, default: defaultValue(inner) };
	}
	return null;
}

// ── Joint sampling (VERSAILLES-165) — multi-param guard oracle routing ───────
//
// A guard oracle with more than one callback parameter can never be an
// arbitrary `.filter(...)` (fast-check's filter passes exactly ONE value), so
// the planner CLASSIFIES the multi-param guard's AST and routes it to a
// joint-sampling strategy instead of the old blanket PROPERTY_UNPLANNABLE gate:
//   - Equality-mirror — a bothSideFieldRef equality `p1 == p2`: the SOURCE
//     (the left operand) is sampled from its arbitrary and the TARGET (the
//     right operand) mirrors the value, so the oracle holds by construction
//     (zero filter sparsity). The target's ArbitrarySpec carries mirrorOf.
//   - Record + bounded filter — a conjunction of numeric bounds, literal
//     inequalities, and sum/difference couplings: cross-param propagation
//     derives per-param bounds from the coupling leaves BEFORE any filter so
//     the sampled joint region is bounded first.
//   - Anything else — non-mirrorable `!=`, equality-of-sums, unboundable
//     couplings, unrenderable oracles, component-typed params — keeps the
//     PROPERTY_UNPLANNABLE gate.

/**
 * Equality-mirror detection: a top-level `compare` with op `==` and BOTH sides
 * single-segment fieldRefs (`p1 == p2`) routes to the equality-mirror strategy
 * — the SOURCE (the left operand) is generated from its arbitrary and the value
 * is mirrored to the TARGET (the right operand). Returns null for any
 * non-mirror shape: `!=`/`!==` (mirroring would assert the OPPOSITE of what the
 * oracle asserts), a compare with an arithmetic side, a compound, a
 * self-equality (`p1 == p1` — degenerate single-param, not a mirror), or an
 * equality whose operands are NOT both operation params (Center B1): the SOURCE
 * is sampled from its own arbitrary, so a manifest-FIELD operand (e.g. `status
 * == newStatus` where `status` is a field, not an op param) has no arbitrary to
 * sample from. Field-operand equalities route to the emitter's FIELD-BOUND
 * layout (B1) instead — no mirror, no field-source spec; the descriptor
 * carries op-params only and the field maps to `instance.<field>` after the
 * call.
 */
function equalityMirrorInfo(
	ast: Node,
	opParamNames: Set<string>,
): { source: string; target: string } | null {
	if (ast.type !== "compare" || ast.op !== "==") {
		return null;
	}
	const left = fieldRefName(ast.left);
	const right = fieldRefName(ast.right);
	if (left === null || right === null || left === right) {
		return null;
	}
	if (!opParamNames.has(left) || !opParamNames.has(right)) {
		return null;
	}
	return { source: left, target: right };
}

/**
 * True for a top-level `==` compare whose BOTH sides are single-segment
 * fieldRefs — the equality-FAMILY shape (Center B1). The equality-mirror
 * strategy only covers the op-param × op-param subset (equalityMirrorInfo); a
 * field-operand equality in this family is still PLANNED (never
 * PROPERTY_UNPLANNABLE) — the emitter's FIELD-BOUND layout renders it.
 */
function bothSideFieldRefEquality(ast: Node): boolean {
	return (
		ast.type === "compare" &&
		ast.op === "==" &&
		fieldRefName(ast.left) !== null &&
		fieldRefName(ast.right) !== null
	);
}

/** A normalized sum/difference coupling leaf `p1 ± p2 <op> C`. */
type CouplingLeaf = {
	arithOp: "+" | "-";
	p1: string;
	p2: string;
	/** The compare op, normalized to arithmetic-side-left orientation. */
	op: string;
	C: number;
};

/**
 * Normalizes a compare node into a coupling leaf: one side an `arithmetic`
 * node `p1 + p2` / `p1 - p2` (both operands single-segment fieldRefs), the
 * other side a numeric literal. Literal-left compares (`C >= p1 + p2`) are
 * inverted to arithmetic-left. Returns null when the compare is not a
 * two-fieldRef sum/difference against a numeric literal. `==`/`!=` couplings
 * are still returned (op preserved) so the caller can reject them as
 * equality-of-sums — they are never propagated (measure-zero).
 */
function couplingLeaf(node: Node): CouplingLeaf | null {
	if (node.type !== "compare") {
		return null;
	}
	let arithSide = node.left;
	let litSide = node.right;
	let op: string = node.op;
	if (arithSide.type !== "arithmetic" && litSide.type === "arithmetic") {
		arithSide = litSide;
		litSide = node.left;
		op = INVERTED_NUMERIC_OP[op] ?? op;
	}
	if (arithSide.type !== "arithmetic" || litSide.type !== "literal") {
		return null;
	}
	if (typeof litSide.value !== "number") {
		return null;
	}
	if (arithSide.op !== "+" && arithSide.op !== "-") {
		return null;
	}
	const p1 = fieldRefName(arithSide.left);
	const p2 = fieldRefName(arithSide.right);
	if (p1 === null || p2 === null) {
		return null;
	}
	return { arithOp: arithSide.op, p1, p2, op, C: litSide.value };
}

/**
 * Cross-param bound propagation (VERSAILLES-165): for a sum/difference
 * coupling leaf `p1 ± p2 <op> C` against the operation's KNOWN per-param
 * bounds, derives the tightest bound the OTHER side's known bound implies:
 *
 *   p1 + p2 <= C  (or < C)  with L1 ≤ p1, L2 ≤ p2 → p1 ≤ C − L2, p2 ≤ C − L1
 *   p1 + p2 >= C  (or > C)  with U1 ≥ p1, U2 ≥ p2 → p1 ≥ C − U2, p2 ≥ C − U1
 *   p1 − p2 <= C  (or < C)  with U2 ≥ p2, L1 ≤ p1 → p1 ≤ C + U2, p2 ≥ L1 − C
 *   p1 − p2 >= C  (or > C)  with L2 ≤ p2, U1 ≥ p1 → p1 ≥ C + L2, p2 ≤ U1 − C
 *
 * Strict ops follow the numericConstraintBounds convention (`< C` → the
 * exclusive boundary C−1, `> C` → C+1). Mutates `lower`/`upper` in place;
 * returns false when any needed operand bound is missing (the joint space is
 * unbounded there, so the coupling is unboundable).
 */
function propagateCouplingBound(
	leaf: CouplingLeaf,
	lower: Record<string, number>,
	upper: Record<string, number>,
): boolean {
	if (!isNumericOp(leaf.op)) {
		return false;
	}
	let C = leaf.C;
	if (leaf.op === "<") {
		C -= 1;
	} else if (leaf.op === ">") {
		C += 1;
	}
	const { p1, p2, arithOp } = leaf;
	if (arithOp === "+") {
		if (leaf.op === "<=" || leaf.op === "<") {
			const L1 = lower[p1];
			const L2 = lower[p2];
			if (L1 === undefined || L2 === undefined) {
				return false;
			}
			upper[p1] = Math.min(upper[p1] ?? Number.POSITIVE_INFINITY, C - L2);
			upper[p2] = Math.min(upper[p2] ?? Number.POSITIVE_INFINITY, C - L1);
			return true;
		}
		const U1 = upper[p1];
		const U2 = upper[p2];
		if (U1 === undefined || U2 === undefined) {
			return false;
		}
		lower[p1] = Math.max(lower[p1] ?? Number.NEGATIVE_INFINITY, C - U2);
		lower[p2] = Math.max(lower[p2] ?? Number.NEGATIVE_INFINITY, C - U1);
		return true;
	}
	// difference: p1 − p2
	if (leaf.op === "<=" || leaf.op === "<") {
		const U2 = upper[p2];
		const L1 = lower[p1];
		if (U2 === undefined || L1 === undefined) {
			return false;
		}
		upper[p1] = Math.min(upper[p1] ?? Number.POSITIVE_INFINITY, C + U2);
		lower[p2] = Math.max(lower[p2] ?? Number.NEGATIVE_INFINITY, L1 - C);
		return true;
	}
	const L2 = lower[p2];
	const U1 = upper[p1];
	if (L2 === undefined || U1 === undefined) {
		return false;
	}
	lower[p1] = Math.max(lower[p1] ?? Number.NEGATIVE_INFINITY, C + L2);
	upper[p2] = Math.min(upper[p2] ?? Number.POSITIVE_INFINITY, U1 - C);
	return true;
}

/**
 * Accepts/rejects the leaves of a multi-param guard for the record + bounded
 * filter strategy (VERSAILLES-165): a conjunction (`and`-chain) of numeric
 * bounds (`field op literal`), literal equalities/inequalities (filterable at
 * the record level), and sum/difference couplings (cross-param propagated).
 * Any other leaf — `or`/`not`/predicateCall nodes, fieldRef-vs-fieldRef
 * compares, equality-of-sums, a coupling referencing a manifest-FIELD operand
 * (Center B2), or an unboundable coupling — makes the guard unplannable.
 * Mutates `lower`/`upper` with the derived coupling bounds so the propagation
 * feeds the per-param bounds BEFORE buildArbitrarySpecs consumes them. Returns
 * null when every leaf is acceptable, else a human-readable reason.
 */
function recordLeafFailure(
	node: Node,
	lower: Record<string, number>,
	upper: Record<string, number>,
	opParamNames: Set<string>,
): string | null {
	if (node.type === "and") {
		return (
			recordLeafFailure(node.left, lower, upper, opParamNames) ??
			recordLeafFailure(node.right, lower, upper, opParamNames)
		);
	}
	if (node.type !== "compare") {
		return `contains a ${node.type} node — only conjunctions of numeric bounds, literal inequalities, and sum/difference couplings are record-samplable`;
	}
	const leftVar = fieldRefName(node.left);
	const rightVar = fieldRefName(node.right);
	if (
		(leftVar !== null && node.right.type === "literal") ||
		(rightVar !== null && node.left.type === "literal")
	) {
		// Numeric bound (contributes to collectNumericBounds) or a literal
		// equality/inequality — filterable at the record level, no bound needed.
		return null;
	}
	const coupling = couplingLeaf(node);
	if (coupling !== null) {
		// Center B2: a coupling leaf that references a manifest-FIELD operand
		// (not an op param) is not record-samplable — the field is instance
		// state, never a record key, so its value can neither be sampled nor
		// destructured for the composed filter. The joint region cannot be
		// bounded by sampling, so the clause stays PROPERTY_UNPLANNABLE.
		if (!opParamNames.has(coupling.p1) || !opParamNames.has(coupling.p2)) {
			const fieldOperand = opParamNames.has(coupling.p1)
				? coupling.p2
				: coupling.p1;
			return `coupling ${coupling.p1} ${coupling.arithOp} ${coupling.p2} ${coupling.op} ${coupling.C} references manifest-field operand "${fieldOperand}" — only operation params can be joint-sampled`;
		}
		if (!isNumericOp(coupling.op)) {
			return `equality-of-sums compare ${coupling.p1} ${coupling.arithOp} ${coupling.p2} ${coupling.op} ${coupling.C} is a measure-zero slice, not a bounded region`;
		}
		if (!propagateCouplingBound(coupling, lower, upper)) {
			return `unboundable coupling ${coupling.p1} ${coupling.arithOp} ${coupling.p2} ${coupling.op} ${coupling.C} — cross-param propagation needs bounds on both operands`;
		}
		return null;
	}
	return "multi-param compare is neither a fieldRef equality, a bounded coupling, nor a literal inequality";
}

/** The joint-sampling classification of a multi-param guard oracle's AST. */
type MultiParamGuardClass =
	| { kind: "mirror"; source: string; target: string }
	| { kind: "field-bound" }
	| { kind: "coupled-bounded" }
	| { kind: "unplannable"; detail: string };

/**
 * Classifies a multi-param guard oracle's AST for joint sampling
 * (VERSAILLES-165): an equality-mirror (top-level `p1 == p2` with BOTH operands
 * operation params), a FIELD-BOUND equality (a bothSideFieldRef `==` with at
 * least one manifest-FIELD operand — Center B1: plannable, never unplannable;
 * the emitter renders the field-bound layout), a record + bounded filter (a
 * conjunction of numeric bounds / literal inequalities / boundable couplings),
 * or unplannable. The cross-param propagation for coupled-bounded guards runs
 * HERE — mutating the operation's lower/upper bounds — so the derived bounds
 * land in the specs.
 */
function classifyMultiParamGuard(
	ast: Node,
	lower: Record<string, number>,
	upper: Record<string, number>,
	opParamNames: Set<string>,
): MultiParamGuardClass {
	const mirror = equalityMirrorInfo(ast, opParamNames);
	if (mirror !== null) {
		return { kind: "mirror", source: mirror.source, target: mirror.target };
	}
	// Center B1: a bothSideFieldRef equality `field == param` (at least one
	// operand a manifest FIELD, not an op param) is neither mirror-able (the
	// field is instance state, never a sampled arbitrary) nor record-filterable
	// (the field can never be destructured from the record) — but it IS
	// plannable via the emitter's FIELD-BOUND layout, so it must NOT trip the
	// PROPERTY_UNPLANNABLE gate below.
	if (bothSideFieldRefEquality(ast)) {
		return { kind: "field-bound" };
	}
	const failure = recordLeafFailure(ast, lower, upper, opParamNames);
	if (failure === null) {
		return { kind: "coupled-bounded" };
	}
	return { kind: "unplannable", detail: failure };
}

/**
 * Builds the per-param ArbitrarySpec list for an equality-mirror descriptor
 * (VERSAILLES-165): the mirror SOURCE's spec first (no mirrorOf — it has the
 * independent arbitrary), then the mirror TARGET's spec carrying
 * `mirrorOf: "<source>"` (no independent arbitrary — bounds/default stripped),
 * then the remaining operation-param specs in order. Center B1: BOTH operands
 * are guaranteed operation params (equalityMirrorInfo rejects field operands —
 * field-operand equalities route to the emitter's FIELD-BOUND layout), so no
 * manifest-field source spec is ever derived here. Returns null when the
 * source or target has no representable ArbitrarySpec.
 */
function buildMirrorParams(
	base: ArbitrarySpec[],
	source: string,
	target: string,
): ArbitrarySpec[] | null {
	const sourceSpec = base.find((spec) => spec.param === source) ?? null;
	if (sourceSpec === null) {
		return null;
	}
	const targetBase = base.find((spec) => spec.param === target) ?? null;
	if (targetBase === null) {
		return null;
	}
	// The mirror TARGET has NO independent arbitrary — bounds/default stripped.
	const targetSpec: ArbitrarySpec = {
		param: targetBase.param,
		typeRef: targetBase.typeRef,
		kind: targetBase.kind,
		members: targetBase.members,
		mirrorOf: source,
	};
	const rest = base.filter(
		(spec) => spec.param !== source && spec.param !== target,
	);
	return [sourceSpec, targetSpec, ...rest];
}

/**
 * The codegen predicates import table (predicate name → import specifier),
 * derived from the loaded predicates registry. renderClausePredicate only uses
 * the map to VALIDATE resolvability — the emitted call is the bare name — so
 * the registered sourceRef (falling back to the conventional specifier) is the
 * registry-derived value.
 */
function predicatesImportMap(
	context: VersaillesContext,
): Record<string, string> {
	const map: Record<string, string> = {};
	for (const [name, entry] of Object.entries(
		context.predicates?.predicates ?? {},
	)) {
		map[name] = entry.sourceRef || "./predicates.js";
	}
	return map;
}

/**
 * Parses the codegen'd clause predicate's parameter list from its byte-pinned
 * `(<params>) => <expr>` form — the SAME parsing the vitest emitter's
 * oracleParamsOf applies to the GAP-3 guard set. codegen.ts output never
 * mangles the head — split at the first `) => `, then the params on ", ".
 * A guard oracle with >1 callback params can never be an arbitrary
 * `.filter(...)` (fast-check filter passes exactly ONE value), so the planner
 * uses this count to mark multi-param-oracle operations PROPERTY_UNPLANNABLE.
 */
function oracleParamsOf(code: string): string[] {
	const arrow = code.indexOf(") => ");
	if (arrow === -1) {
		return [];
	}
	const head = code.slice(1, arrow);
	if (head.trim() === "") {
		return [];
	}
	return head.split(", ").map((param) => param.trim());
}

/**
 * Plans the property blocks for a validated context + its already-planned
 * concrete suite (ADR-0017, build-spec §9.6). Throws when context.isValid is
 * false (mirrors planTestCases — generation only runs against approved
 * contracts). Property blocks are NEVER planned when
 * config.propertyBased.enabled is false or absent (the v1 default output stays
 * byte-identical); the per-clause strategy record is still total over
 * suite.clauseIds with pbtEnabled: false semantics.
 */
export function planPropertyBlocks(
	suite: PlannedSuite,
	context: VersaillesContext,
): PropertyPlan {
	if (!context.isValid) {
		throw new Error(
			"planPropertyBlocks requires a validated context (isValid: true) — generation is blocked for invalid contracts",
		);
	}
	if (context.contracts === null) {
		throw new Error(
			"planPropertyBlocks requires a contracts store in the context",
		);
	}

	const pbt = context.config?.propertyBased;
	const pbtEnabled = pbt?.enabled === true;
	const idiom = context.config?.rejection?.idiom ?? "throws";
	const grammarVersion = context.config?.grammarVersion ?? "1.0";
	const seedOverride = pbt?.seed;

	const descriptors: PropertyDescriptor[] = [];
	const warnings: LoaderWarning[] = [];
	const strategies: StrategyMap = {};

	const clauseMeta = collectClauseMeta(context);
	const predicates = predicatesImportMap(context);

	// Strategy record: EVERY source clause id → PbtStrategy (the total
	// coverage record). selectStrategy is a pure table lookup over the
	// resolved shape; pbtEnabled threads the config gate.
	for (const clauseId of suite.clauseIds) {
		strategies[clauseId] = selectStrategy(
			resolveClauseShape(clauseId, clauseMeta, context),
			{ pbtEnabled },
		);
	}

	// Enabled gate (ADR-0017 backward-compat pin).
	if (!pbtEnabled) {
		return { descriptors, strategies, warnings };
	}

	for (const [componentName, component] of Object.entries(
		context.contracts.contracts,
	)) {
		const invariants = component.invariants ?? [];
		for (const [operationName, operation] of Object.entries(
			component.operations ?? {},
		)) {
			// Descriptor ids: "<component>.<operation>.property-<outcome>-<n>",
			// n a per-(operation, outcome) counter from 0.
			const counters: Partial<Record<PropertyOutcome, number>> = {};
			const nextId = (outcome: PropertyOutcome): string => {
				const current = counters[outcome] ?? 0;
				counters[outcome] = current + 1;
				return `${componentName}.${operationName}.property-${outcome}-${current}`;
			};

			// Operation-wide numeric bounds: the compound-aware DIRECT bounds
			// (collectNumericBounds over every precondition) plus the cross-param
			// bounds propagation derives from the multi-param guard couplings
			// below (VERSAILLES-165). Propagation mutates these records before
			// the final { min, max } map is built, so the derived bounds land in
			// the specs BEFORE buildArbitrarySpecs consumes them.
			const lower: Record<string, number> = {};
			const upper: Record<string, number> = {};
			for (const pre of operation.preconditions ?? []) {
				const ast = context.parsedContracts[pre.id];
				if (ast !== undefined) {
					collectNumericBounds(ast, lower, upper);
				}
			}

			// The emitted GAP-3 guard set for an operation is the clause oracle
			// of EVERY satisfies + invariant-preserving descriptor for the same
			// (component, operation), in plan order. Render the candidate
			// oracles once, then CLASSIFY every multi-param guard oracle's AST
			// (VERSAILLES-165) instead of blanket-unplannable: a guard oracle
			// with >1 callback params can never be an arbitrary `.filter(...)`
			// (fast-check's filter passes exactly ONE value, so filtering with a
			// multi-param oracle would evaluate the predicate against undefined
			// and silently discard the whole domain — a hanging property). A
			// clause whose oracle cannot render never reaches the emitted guard
			// set — its own descriptor carries the render-failure warning
			// (Center W5) below instead.
			const guardCandidates: { clauseId: string; ast: Node }[] = [];
			for (const pre of operation.preconditions ?? []) {
				const ast = context.parsedContracts[pre.id];
				if (strategies[pre.id] !== "example" && ast !== undefined) {
					guardCandidates.push({ clauseId: pre.id, ast });
				}
			}
			for (const post of operation.postconditions ?? []) {
				const ast = context.parsedContracts[post.id];
				if (strategies[post.id] !== "example" && ast !== undefined) {
					guardCandidates.push({ clauseId: post.id, ast });
				}
			}
			for (const invariant of invariants) {
				const ast = context.parsedContracts[invariant.id];
				if (ast !== undefined && operationOverlapsInvariant(operation, ast)) {
					guardCandidates.push({ clauseId: invariant.id, ast });
				}
			}
			const guardOracles: { clauseId: string; code: string }[] = [];
			for (const candidate of guardCandidates) {
				try {
					guardOracles.push({
						clauseId: candidate.clauseId,
						code: renderClausePredicate(candidate.ast, { predicates }),
					});
				} catch {
					// Render-failed clauses contribute no guard oracle (their own
					// descriptor warns + skips below — never a silent zero).
				}
			}

			// Joint-sampling router (VERSAILLES-165): classify EVERY multi-param
			// guard oracle's AST. An equality-mirror (`p1 == p2`, both operands
			// operation params), a FIELD-BOUND equality (a bothSideFieldRef `==`
			// with a manifest-FIELD operand — Center B1), and a record + bounded
			// filter (a conjunction of numeric bounds / literal inequalities /
			// boundable sum-difference couplings) are joint-plannable; anything
			// else — non-mirrorable `!=`, equality-of-sums, an unboundable
			// coupling, a coupling referencing a manifest field (Center B2) —
			// keeps the PROPERTY_UNPLANNABLE gate. A multi-param guard in the
			// operation's guard set makes EVERY satisfies/invariant-preserving
			// descriptor of the operation need the joint treatment: if ANY
			// multi-param guard is unplannable, the operation's
			// satisfies/invariant descriptors are all unplannable. Rejects
			// blocks are unaffected (they have no filters). The cross-param
			// propagation for coupled-bounded guards runs here, feeding the
			// operation's lower/upper records.
			const opParamNames = new Set(
				(operation.params ?? []).map((param) => param.name),
			);
			let multiParamUnplannable: { clauseId: string; detail: string } | null =
				null;
			for (const oracle of guardOracles) {
				if (oracleParamsOf(oracle.code).length <= 1) {
					continue;
				}
				const ast = context.parsedContracts[oracle.clauseId];
				if (ast === undefined) {
					continue;
				}
				const classification = classifyMultiParamGuard(
					ast,
					lower,
					upper,
					opParamNames,
				);
				if (classification.kind === "unplannable") {
					multiParamUnplannable = {
						clauseId: oracle.clauseId,
						detail: classification.detail,
					};
					break;
				}
			}

			// Final per-param bounds after propagation: only params with BOTH
			// bounds resolved carry a bounds object (the ArbitrarySpec bounds
			// shape requires min + max).
			const bounds = numericBoundsFromRecords(operation, lower, upper);
			const paramsResult = buildArbitrarySpecs(operation, bounds);
			const manifestFields =
				context.manifests?.manifests[componentName]?.fields ?? {};

			// Plans ONE descriptor for a property-strategy clause, or a
			// non-silent PROPERTY_UNPLANNABLE warning (the PREDICATE_UNPLANNABLE
			// tier) that skips it: unrepresentable operation params, an
			// unplannable multi-param guard oracle in the operation's filter set
			// (VERSAILLES-165), or a renderClausePredicate throw for the clause
			// (Center W5). Never silent, never a hard fail for renderer
			// unrepresentability.
			const planClauseDescriptor = (
				clauseId: string,
				ast: Node,
				outcome: PropertyOutcome,
			): void => {
				if (paramsResult.unplannable !== null) {
					warnings.push({
						code: "PROPERTY_UNPLANNABLE",
						field: clauseId,
						detail: `Cannot plan a property block for ${clauseId}: operation ${componentName}.${operationName} has param ${paramsResult.unplannable} — the clause's valid region cannot be turned into filterable arbitraries`,
					});
					return;
				}
				// Joint-sampling gate — satisfies and invariant-preserving
				// blocks only (rejects has no filters). A multi-param guard
				// that is NEITHER mirror-able NOR bounded (record + bounded
				// filter) makes every accept-side block of the operation
				// unplannable. The SELECTOR still records "property" for these
				// clauses (the strategy is the open-question coverage record);
				// the PLANNER finds the block unplannable and the coverage gap
				// stays visible in suite.clauseIds.
				if (
					(outcome === "satisfies" || outcome === "invariant-preserving") &&
					multiParamUnplannable !== null
				) {
					warnings.push({
						code: "PROPERTY_UNPLANNABLE",
						field: clauseId,
						detail: `Cannot plan a property block for ${clauseId}: guard oracle ${multiParamUnplannable.clauseId} is a multi-param oracle that cannot be joint-sampled (${multiParamUnplannable.detail}) — fast-check's .filter() passes one value, so no satisfies/invariant-preserving block in ${componentName}.${operationName} can filter its arbitraries to a valid region with this guard set`,
					});
					return;
				}
				let code: string;
				try {
					code = renderClausePredicate(ast, { predicates });
				} catch (error) {
					warnings.push({
						code: "PROPERTY_UNPLANNABLE",
						field: clauseId,
						detail: `Cannot render the property oracle for ${clauseId}: ${error instanceof Error ? error.message : String(error)}`,
					});
					return;
				}
				// Equality-mirror wiring (VERSAILLES-165, Center B1): when the
				// clause's OWN oracle is a bothSideFieldRef equality `p1 == p2`
				// with BOTH operands operation params, the mirror TARGET's spec
				// carries mirrorOf: "<source>" (no independent arbitrary) and
				// the SOURCE's spec precedes it. A field-operand equality is
				// NOT mirrored — equalityMirrorInfo returns null — and the
				// descriptor is planned with op-params only; the emitter
				// renders the FIELD-BOUND layout (field → instance.<field>).
				let params = paramsResult.specs;
				if (outcome === "satisfies" || outcome === "invariant-preserving") {
					const mirror = equalityMirrorInfo(ast, opParamNames);
					if (mirror !== null) {
						const mirrored = buildMirrorParams(
							paramsResult.specs,
							mirror.source,
							mirror.target,
						);
						if (mirrored === null) {
							warnings.push({
								code: "PROPERTY_UNPLANNABLE",
								field: clauseId,
								detail: `Cannot plan a property block for ${clauseId}: the equality-mirror source or target (${mirror.source} / ${mirror.target}) has no representable ArbitrarySpec — the mirrored value cannot be sampled`,
							});
							return;
						}
						params = mirrored;
					}
				}
				descriptors.push({
					id: nextId(outcome),
					component: componentName,
					operation: operationName,
					params,
					clauses: [{ clauseId, code }],
					outcome,
					traces: [clauseId],
					// Seed wiring: the explicit override wins; otherwise the
					// per-block derived seed over the block's OWN covered
					// clause ids + grammar version.
					seed: seedOverride ?? derivePropertySeed([clauseId], grammarVersion),
				});
			};

			// Preconditions: "property" (compound / bothSideFieldRef / other)
			// and "property-with-falsifier" (predicateCall) plan an ACCEPT-side
			// satisfies block; the deterministic example falsifier stays in
			// the concrete suite.
			for (const pre of operation.preconditions ?? []) {
				if (strategies[pre.id] === "example") {
					continue;
				}
				const ast = context.parsedContracts[pre.id];
				if (ast === undefined) {
					continue;
				}
				planClauseDescriptor(pre.id, ast, "satisfies");
			}

			// Postconditions: literal-computable stay example; uncomputable
			// become satisfies properties.
			for (const post of operation.postconditions ?? []) {
				if (strategies[post.id] === "example") {
					continue;
				}
				const ast = context.parsedContracts[post.id];
				if (ast === undefined) {
					continue;
				}
				planClauseDescriptor(post.id, ast, "satisfies");
			}

			// Invariants this operation's effects overlap → invariant-
			// preserving block, oracle = the codegen'd invariant.
			for (const invariant of invariants) {
				const ast = context.parsedContracts[invariant.id];
				if (ast === undefined) {
					continue;
				}
				if (!operationOverlapsInvariant(operation, ast)) {
					continue;
				}
				planClauseDescriptor(invariant.id, ast, "invariant-preserving");
			}

			// Expected-rejection (enabled): the §9.2 bounded sweep's
			// deterministic first-hit set (violated invariants + satisfied
			// postconditions) becomes a rejects property whose clauses are the
			// codegen'd oracles of the traced conditions, with the configured
			// rejection idiom (ADR-0007).
			const rejection = planExpectedRejection(
				operation,
				operation.preconditions ?? [],
				operation.postconditions ?? [],
				invariants,
				manifestFields,
				context,
			);
			if (rejection === null) {
				continue;
			}
			const traces = [
				...rejection.violatedInvariants,
				...rejection.satisfiedPostconditions,
			];
			if (paramsResult.unplannable !== null) {
				warnings.push({
					code: "PROPERTY_UNPLANNABLE",
					field: traces[0] ?? "",
					detail: `Cannot plan a property block for ${componentName}.${operationName}: operation has param ${paramsResult.unplannable} — the expected-rejection property cannot be planned`,
				});
				continue;
			}
			const rejectionClauses: PropertyClause[] = [];
			let rejectionError: { clauseId: string; detail: string } | null = null;
			for (const clauseId of traces) {
				const ast = context.parsedContracts[clauseId];
				if (ast === undefined) {
					rejectionError = {
						clauseId,
						detail: `Cannot plan a property block for ${clauseId}: missing parsed AST`,
					};
					break;
				}
				try {
					rejectionClauses.push({
						clauseId,
						code: renderClausePredicate(ast, { predicates }),
					});
				} catch (error) {
					rejectionError = {
						clauseId,
						detail: `Cannot render the property oracle for ${clauseId}: ${error instanceof Error ? error.message : String(error)}`,
					};
					break;
				}
			}
			if (rejectionError !== null) {
				warnings.push({
					code: "PROPERTY_UNPLANNABLE",
					field: rejectionError.clauseId,
					detail: rejectionError.detail,
				});
				continue;
			}
			descriptors.push({
				id: nextId("rejects"),
				component: componentName,
				operation: operationName,
				params: paramsResult.specs,
				clauses: rejectionClauses,
				outcome: "rejects",
				rejectionIdiom: idiom,
				traces,
				seed: seedOverride ?? derivePropertySeed(traces, grammarVersion),
			});
		}
	}

	return { descriptors, strategies, warnings };
}
