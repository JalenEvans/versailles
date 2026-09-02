/**
 * The deterministic case planner (build-spec §9.1–§9.2, ADR-0002/0007) —
 * thin orchestrator (ADR-0020). The planning responsibility is split across
 * the modules it composes:
 *
 * - `clause-analysis.ts` — AST classification helpers (classifyClause, etc.)
 * - `concrete-cases.ts` — the §9.1 boundary/partition/enum/violation planners
 *   and the §9.2 expected-rejection sweep
 * - `input-synthesis.ts` — pre-state / valid params / assertion descriptors
 * - `evaluator.ts` — the mini expression evaluator
 * - `property-planning.ts` — the seeded PBT machinery (`planPropertyBlocks`)
 * - `oracle.ts` — the shared `oracleParamsOf` used by the PBT planner and the
 *   vitest emitter
 *
 * This file keeps only the orchestration surface: the identifier guards,
 * `planTestCases`, `coverageManifest` / `allCases`, and `findTraceClause`
 * (used only by the orchestrator). `planPropertyBlocks` is re-exported from
 * property-planning.js so `index.ts`'s `import { planPropertyBlocks } from
 * "./planner.js"` keeps the same public surface.
 *
 * A pure function from a validated VersaillesContext (isValid: true) to the
 * framework-agnostic PlannedSuite IR. No randomness, no timestamps, no LLM —
 * same context in, byte-identical suite out.
 */
import type { Node } from "../../../core/src/core/parser.js";
import type {
	ContractClause,
	ContractOperation,
	LoaderWarning,
	VersaillesContext,
} from "../../../core/src/loader/workspace.js";
import { classifyClause, nodeReferencesParam } from "./clause-analysis.js";
import {
	planBoundaryCases,
	planEnumPartitionCases,
	planExpectedRejection,
	planGenericViolationCase,
	planPartitionCases,
	planPredicateViolationCase,
} from "./concrete-cases.js";
import {
	buildPreState,
	buildValidParams,
	enumMembers,
	invariantAssertions,
	pickInvariantPreservingParams,
	postconditionAssertions,
} from "./input-synthesis.js";
import type {
	CaseKind,
	CoverageManifest,
	OperationCaseGroup,
	PlannedCase,
	PlannedSuite,
} from "./ir.js";
export { planPropertyBlocks } from "./property-planning.js";

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
