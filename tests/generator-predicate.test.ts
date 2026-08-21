import { describe, expect, it } from "vitest";

import { parseExpression } from "../src/core/parser.js";
import type { ClauseKind, Node } from "../src/core/parser.js";
// The generator core (src/generator/) is implemented; these value imports
// resolve at runtime. The assertions below pin the generator contract the
// implementation must satisfy.
import { coverageManifest, planTestCases } from "../src/generator/index.js";
import type {
	CoverageManifest,
	PlannedCase,
	PlannedSuite,
} from "../src/generator/index.js";
import type { LoaderWarning } from "../src/loader/workspace.js";
import type {
	ContractClause,
	ContractsFile,
	ManifestsFile,
	PredicatesFile,
	VersaillesContext,
	WorkspaceConfig,
} from "../src/loader/workspace.js";

/**
 * Predicate-call precondition planning (VERSAILLES-22 F3, build-spec §9.1) —
 * pinned against docs/contracts/deterministic-generation.contract.yaml and
 * docs/specs/deterministic-generation.md.
 *
 * The F3 bug: a precondition whose AST is a predicate call (e.g.
 * `isPositive(amount)`) currently produces ZERO generated cases — the
 * planner's falsifying-input synthesis only understands `compare` ASTs, so
 * the predicate clause silently falls through. This file pins the contract
 * behaviour: predicate-call preconditions on primitive params MUST produce at
 * least one deterministic violation case, and genuinely unplannable predicate
 * clauses MUST surface an explicit non-silent warning instead of silently
 * emitting zero cases.
 *
 * ── Module contract (what these tests require from src/generator/) ────────
 *
 * Same public surface as tests/generator.test.ts:
 *
 * ```ts
 * export declare function planTestCases(context: VersaillesContext): PlannedSuite;
 * export declare function coverageManifest(suite: PlannedSuite): CoverageManifest;
 * ```
 *
 * ── Design decisions these tests pin (documented for the implementer) ─────
 *
 * 1. Predicate-call violation-case synthesis (build-spec §9.1): for a
 *    predicate-call precondition whose args are all fieldRefs to primitive
 *    operation params, the planner MUST synthesize at least one
 *    precondition-violation case by deterministically falsifying the
 *    predicate against the paramTypes (e.g. number → a non-positive value).
 *    Registry example hints are a `can`, not a `must` (the registry carries
 *    no hints field today) — the planner may derive the input from
 *    paramTypes alone. The tests therefore pin existence + kind + traces +
 *    reject outcome + a NUMERIC falsifying input, NOT the exact value
 *    (0 vs a hint-derived negative is implementation-determined).
 * 2. The synthesized case is a normal §9.1 violation case: kind
 *    "precondition-violation", traces the predicate clause id, expects
 *    outcome "reject", and carries the configured rejection idiom
 *    (default "throws", ADR-0007).
 * 3. Non-silent unplannability (deterministic-generation.contract.yaml):
 *    when the planner genuinely cannot falsify a predicate clause (e.g. a
 *    non-primitive paramType like `list<number>`, or an argument shape the
 *    v1 heuristic cannot reason about), it MUST NOT silently emit zero cases.
 *    Instead the planned suite carries a warning. The seam follows the repo's
 *    existing warning conventions: LoaderWarning { code, field, detail }
 *    (src/loader/workspace.ts). The planner is a pure function of the context
 *    and must not mutate context.validationWarnings, so the suite itself
 *    carries planning warnings:
 *
 *    ```ts
 *    type PlannedSuite = {
 *      operations: OperationCaseGroup[];
 *      invariantCases: PlannedCase[];
 *      clauseIds: string[];
 *      warnings: LoaderWarning[];   // NEW — suite-level planning warnings
 *    };
 *    ```
 *
 *    Warning shape: code "PREDICATE_UNPLANNABLE", field = the clause id,
 *    detail = a non-empty human-readable explanation. The generate handler
 *    (src/cli/handlers/generate.ts) merges suite.warnings into
 *    CliResult.warnings (pinned in tests/cli.test.ts). Since src/ is not
 *    touched by these tests, the access is typed through a local intersection
 *    cast — the runtime assertion is what matters.
 * 4. Determinism (ADR-0002) holds for predicate contexts too: two plan runs
 *    over the same context produce identical suites (and identical warnings).
 * 5. Non-regression: predicate-call preconditions coexist with numeric
 *    compare preconditions — the numeric clause keeps its §9.1 boundary
 *    cases while the predicate clause gains its violation case.
 * 6. Predicate-aware valid-input synthesis (VERSAILLES-23 F4, build-spec
 *    §9.1, deterministic-generation.contract.yaml): valid inputs for
 *    satisfaction/invariant cases are synthesized by buildValidParams, and
 *    for a param guarded by a registered predicate-call precondition the
 *    type-default can be provably invalid (a bare number param picks 0, and
 *    isPositive(0) is false). The F4 fixture therefore gives setSubtotal a
 *    postcondition so an accept case is planned, and the tests pin that the
 *    accept case's amount is a NUMBER the registered predicate accepts —
 *    never 0. The deterministic rule is frozen to the contract example: a
 *    number-paramType predicate guard → 1 (the positive counterpart of the
 *    -1 violation counter-example). Registry example hints remain a `can`,
 *    not a `must` — paramTypes alone must drive this.
 * 7. Accept-side negative control: a degenerate predicate (one whose
 *    false-set is empty / unknown semantics, e.g. an accept-all-number
 *    predicate) must NOT produce spurious PREDICATE_UNPLANNABLE warnings and
 *    must not crash — the warning channel is reserved for genuinely
 *    unplannable VIOLATION synthesis (decision 3), never accept synthesis.
 * 8. Violation-case isolation (VERSAILLES-147, build-spec §9.1): each
 *    precondition-violation case must satisfy ALL *other* clauses while
 *    falsifying this one — so the planner merges the falsifier OVER
 *    buildValidParams, giving every non-falsified param a deterministic
 *    valid value (never undefined). The committed example broke this:
 *    `addItem("", undefined)` falsifies BOTH pre0 and pre1 (undefined price
 *    is not isPositive), and `addItem(undefined, -1)` has no legitimate sku.
 *    The addItem fixture below pins the isolated inputs EXACTLY:
 *    pre0-violation `{ sku: "", price: 1 }` (predicate-guarded price keeps
 *    the predicate-valid 1), pre1-violation `{ sku: "initial", price: -1 }`
 *    (sku keeps the deterministic valid string default "initial").
 */

const ORDER = "OrderService";
const ACCOUNT = "AccountService";
const PLAIN = "PlainService";

const PRED_CLAUSE = "OrderService.setSubtotal.pre0";

/** The clause id the F3 bug hit in production: a numeric predicate-call precondition. */
const PRED_CLAUSE_ACCOUNT = "AccountService.withdraw.pre1";

/** V-147 (§9.1 isolation): the committed example's addItem clause ids. */
const ADD_ITEM_PRE0 = "OrderService.addItem.pre0";
const ADD_ITEM_PRE1 = "OrderService.addItem.pre1";

function contractsFixture(): ContractsFile {
	return {
		version: "1.0",
		contracts: {
			[ORDER]: {
				invariants: [],
				operations: {
					setSubtotal: {
						id: "OrderService.setSubtotal",
						params: [{ name: "amount", type: "number" }],
						preconditions: [
							{
								id: PRED_CLAUSE,
								expr: "isPositive(amount)",
							},
						],
						// F4 (VERSAILLES-23): the postcondition + effect force
						// buildValidParams to run, so the predicate-guarded
						// param gets an ACCEPT case — the surface the F4 bug
						// hits (a bare number param synthesizes 0, which
						// isPositive rejects). F3's violation-case assertions
						// are unaffected: the violation case for PRED_CLAUSE
						// is still planned identically.
						postconditions: [
							{
								id: "OrderService.setSubtotal.post0",
								expr: "subtotal == amount",
							},
						],
						effects: [{ field: "subtotal", kind: "mutate" }],
						sourceHash: "setsubtotal-hash",
					},
				},
			},
			[ACCOUNT]: {
				invariants: [],
				operations: {
					withdraw: {
						id: "AccountService.withdraw",
						params: [{ name: "amount", type: "number" }],
						preconditions: [
							{
								id: "AccountService.withdraw.pre0",
								expr: "amount >= 10",
							},
							{
								id: PRED_CLAUSE_ACCOUNT,
								expr: "isPositive(amount)",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "withdraw-hash",
					},
				},
			},
		},
	};
}

function unplannableContractsFixture(): ContractsFile {
	return {
		version: "1.0",
		contracts: {
			[ORDER]: {
				invariants: [],
				operations: {
					setSubtotal: {
						id: "OrderService.setSubtotal",
						// A non-primitive paramType: the v1 falsifying-input
						// heuristic cannot derive a violation candidate from
						// `list<number>` — genuinely unplannable today.
						params: [{ name: "items", type: "list<number>" }],
						preconditions: [
							{
								id: PRED_CLAUSE,
								expr: "isNonEmpty(items)",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "setsubtotal-list-hash",
					},
				},
			},
		},
	};
}

function manifestsFixture(): ManifestsFile {
	return {
		version: "1.0",
		manifests: {
			[ORDER]: {
				sourceHash: "man-order",
				fields: { subtotal: "number" },
			},
			[ACCOUNT]: {
				sourceHash: "man-account",
				fields: { balance: "number" },
			},
		},
	};
}

function predicatesFixture(): PredicatesFile {
	return {
		version: "1.0",
		predicates: {
			isPositive: {
				params: ["n"],
				paramTypes: ["number"],
				returnType: "boolean",
				sourceRef: "Num.isPositive",
				sourceHash: "p-positive",
				verifiedPure: true,
			},
			isNonEmpty: {
				params: ["items"],
				paramTypes: ["list<number>"],
				returnType: "boolean",
				sourceRef: "List.isNonEmpty",
				sourceHash: "p-nonempty",
				verifiedPure: true,
			},
		},
	};
}

function makeConfig(rejectionIdiom?: "throws" | "returns"): WorkspaceConfig {
	const config: WorkspaceConfig = {
		grammarVersion: "1.0",
		schemaVersion: "1.0",
		sourceRoots: ["src/**/*.ts"],
		language: "typescript",
		testFramework: "vitest",
		generatedDir: ".versailles/generated",
		staleness: { blockOnStale: false },
	};
	if (rejectionIdiom !== undefined) {
		config.rejection = { idiom: rejectionIdiom };
	}
	return config;
}

/**
 * Parses every fixture expr with the real parser so the context carries real
 * ASTs in parsedContracts (the shape the loader produces, build-spec §6).
 * Throws only on a fixture-authoring error — never a generator behaviour.
 */
function parseAll(contracts: ContractsFile): Record<string, Node> {
	const parsed: Record<string, Node> = {};
	const walk = (clauses: ContractClause[], kind: ClauseKind): void => {
		for (const clause of clauses) {
			const result = parseExpression(clause.expr, kind, clause.id);
			if (!result.ok) {
				throw new Error(
					`fixture parse failed for ${clause.id}: ${JSON.stringify(result.errors)}`,
				);
			}
			parsed[clause.id] = result.ast;
		}
	};
	for (const component of Object.values(contracts.contracts)) {
		walk(component.invariants ?? [], "invariants");
		for (const operation of Object.values(component.operations ?? {})) {
			walk(operation.preconditions ?? [], "preconditions");
			walk(operation.postconditions ?? [], "postconditions");
		}
	}
	return parsed;
}

/**
 * Builds a fully-loaded, isValid VersaillesContext in memory (no files, no
 * loader), mirroring the fixture approach in tests/generator.test.ts.
 */
function makeContext(rejectionIdiom?: "throws" | "returns"): VersaillesContext {
	const contracts = contractsFixture();
	return {
		config: makeConfig(rejectionIdiom),
		contracts,
		manifests: manifestsFixture(),
		predicates: predicatesFixture(),
		parsedContracts: parseAll(contracts),
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

function makeUnplannableContext(): VersaillesContext {
	const contracts = unplannableContractsFixture();
	return {
		config: makeConfig(),
		contracts,
		manifests: manifestsFixture(),
		predicates: predicatesFixture(),
		parsedContracts: parseAll(contracts),
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

function allCases(suite: PlannedSuite): PlannedCase[] {
	return [
		...suite.operations.flatMap((group) => group.cases),
		...suite.invariantCases,
	];
}

function predicateViolationCases(
	suite: PlannedSuite,
	clauseId: string,
): PlannedCase[] {
	return allCases(suite).filter(
		(case_) =>
			case_.kind === "precondition-violation" &&
			case_.traces.includes(clauseId) &&
			case_.expects.outcome === "reject",
	);
}

/** suite.warnings typed through the planned seam (see header decision 3). */
function suiteWarnings(suite: PlannedSuite): LoaderWarning[] {
	return (
		(suite as PlannedSuite & { warnings?: LoaderWarning[] }).warnings ?? []
	);
}

/** Accept-outcome cases of one operation's group (the F4 accept surface). */
function acceptCases(
	suite: PlannedSuite,
	component: string,
	operation: string,
): PlannedCase[] {
	return (
		suite.operations.find(
			(group) => group.component === component && group.operation === operation,
		)?.cases ?? []
	).filter((case_) => case_.expects.outcome === "accept");
}

/**
 * F4 backward-compat control (VERSAILLES-23): an operation with a PLAIN
 * number param — no predicate clause, no numeric compare — must keep today's
 * deterministic valid default (0). The postcondition forces buildValidParams
 * to run without adding any predicate awareness.
 */
function plainParamsContext(): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
		contracts: {
			[PLAIN]: {
				invariants: [],
				operations: {
					setValue: {
						id: "PlainService.setValue",
						params: [{ name: "x", type: "number" }],
						preconditions: [],
						postconditions: [
							{ id: "PlainService.setValue.post0", expr: "value == x" },
						],
						effects: [{ field: "value", kind: "mutate" }],
						sourceHash: "plain-hash",
					},
				},
			},
		},
	};
	return {
		config: makeConfig(),
		contracts,
		manifests: {
			version: "1.0",
			manifests: {
				[PLAIN]: { sourceHash: "man-plain", fields: { value: "number" } },
			},
		},
		predicates: { version: "1.0", predicates: {} },
		parsedContracts: parseAll(contracts),
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

/**
 * F4 negative-context guard (VERSAILLES-23): a DEGENERATE predicate whose
 * false-set is empty / whose semantics the v1 heuristic cannot prove (an
 * accept-all-number predicate). The accept side must still synthesize
 * deterministically WITHOUT a spurious PREDICATE_UNPLANNABLE warning and
 * WITHOUT crashing — the warning channel is violation-only (F3).
 */
function degeneratePredicateContext(): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
		contracts: {
			[ORDER]: {
				invariants: [],
				operations: {
					setSubtotal: {
						id: "OrderService.setSubtotal",
						params: [{ name: "amount", type: "number" }],
						preconditions: [{ id: PRED_CLAUSE, expr: "isAnyNumber(amount)" }],
						postconditions: [
							{
								id: "OrderService.setSubtotal.post0",
								expr: "subtotal == amount",
							},
						],
						effects: [{ field: "subtotal", kind: "mutate" }],
						sourceHash: "setsubtotal-any-hash",
					},
				},
			},
		},
	};
	return {
		config: makeConfig(),
		contracts,
		manifests: {
			version: "1.0",
			manifests: {
				[ORDER]: { sourceHash: "man-order", fields: { subtotal: "number" } },
			},
		},
		predicates: {
			version: "1.0",
			predicates: {
				isAnyNumber: {
					params: ["n"],
					paramTypes: ["number"],
					returnType: "boolean",
					sourceRef: "Num.isAnyNumber",
					sourceHash: "p-any",
					verifiedPure: true,
				},
			},
		},
		parsedContracts: parseAll(contracts),
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

/**
 * V-147 isolation fixture (VERSAILLES-147, build-spec §9.1): mirrors the
 * committed example's OrderService.addItem — params sku (string) and price
 * (number), pre0 `sku != ""` (a GENERIC clause → planGenericViolationCase)
 * and pre1 `isPositive(price)` (a PREDICATE clause →
 * planPredicateViolationCase). The shared makeContext() fixtures are
 * single-param ops, which cannot expose the isolation defect (a single param
 * has no "other clause" to leave undefined) — so this is a dedicated fixture.
 * A violation case for EITHER clause must carry a valid value for the other
 * param: `{ sku: "", price: 1 }` for pre0 and `{ sku: "initial", price: -1 }`
 * for pre1 (buildValidParams: string → "initial", isPositive-guarded number →
 * 1).
 */
function addItemIsolationContext(): VersaillesContext {
	const contracts: ContractsFile = {
		version: "1.0",
		contracts: {
			[ORDER]: {
				invariants: [],
				operations: {
					addItem: {
						id: "OrderService.addItem",
						params: [
							{ name: "sku", type: "string" },
							{ name: "price", type: "number" },
						],
						preconditions: [
							{ id: ADD_ITEM_PRE0, expr: 'sku != ""' },
							{ id: ADD_ITEM_PRE1, expr: "isPositive(price)" },
						],
						postconditions: [],
						effects: [],
						sourceHash: "additem-isolation-hash",
					},
				},
			},
		},
	};
	return {
		config: makeConfig(),
		contracts,
		manifests: {
			version: "1.0",
			manifests: {
				[ORDER]: { sourceHash: "man-order-isolation", fields: {} },
			},
		},
		predicates: predicatesFixture(),
		parsedContracts: parseAll(contracts),
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

describe("planTestCases — predicate-call preconditions (§9.1, VERSAILLES-22 F3)", () => {
	it("plans at least one precondition-violation case for a numeric predicate-call precondition", () => {
		const suite = planTestCases(makeContext());

		const violations = predicateViolationCases(suite, PRED_CLAUSE);
		expect(violations.length).toBeGreaterThan(0);
		const violation = violations[0];
		expect(violation.kind).toBe("precondition-violation");
		expect(violation.expects.outcome).toBe("reject");
		expect(violation.expects.rejectionIdiom).toBe("throws");
		expect(violation.traces).toContain(PRED_CLAUSE);
		// The falsifying input targets the predicate's numeric arg with a
		// NUMBER value. Exact value (0 vs hint-derived negative) is
		// implementation-determined — the contract example allows either.
		expect(typeof violation.inputs.amount).toBe("number");
	});

	it("carries the configured rejection idiom on the predicate violation case (ADR-0007)", () => {
		const suite = planTestCases(makeContext("returns"));

		const violations = predicateViolationCases(suite, PRED_CLAUSE);
		expect(violations.length).toBeGreaterThan(0);
		for (const violation of violations) {
			expect(violation.expects.rejectionIdiom).toBe("returns");
		}
	});
});

describe("coverageManifest — predicate-clause coverage (§9.3, VERSAILLES-22 F3)", () => {
	it("maps the predicate-call clause to at least one generated test id", () => {
		const suite = planTestCases(makeContext());

		const manifest: CoverageManifest = coverageManifest(suite);
		const testIds = manifest.coverage[PRED_CLAUSE];
		expect(Array.isArray(testIds)).toBe(true);
		expect(testIds.length).toBeGreaterThan(0);

		const all = allCases(suite);
		for (const testId of testIds) {
			const case_ = all.find((candidate) => candidate.id === testId);
			expect(case_).toBeDefined();
			expect(case_?.traces).toContain(PRED_CLAUSE);
		}
	});
});

describe("planTestCases — non-silent unplannable predicate warnings (deterministic-generation.contract.yaml)", () => {
	it("surfaces a PREDICATE_UNPLANNABLE warning for a predicate with a non-primitive paramType — never a silent zero", () => {
		const suite = planTestCases(makeUnplannableContext());

		// The clause produces no violation case (genuinely unplannable) —
		// but the suite MUST NOT silently drop it: a structured warning
		// carrying the clause id is the non-silent signal.
		expect(predicateViolationCases(suite, PRED_CLAUSE)).toEqual([]);

		const warnings = suiteWarnings(suite);
		expect(warnings).toContainEqual(
			expect.objectContaining({
				code: "PREDICATE_UNPLANNABLE",
				field: PRED_CLAUSE,
			}),
		);
		const warning = warnings.find((w) => w.field === PRED_CLAUSE);
		expect(warning?.code).toBe("PREDICATE_UNPLANNABLE");
		expect(warning?.detail.length).toBeGreaterThan(0);
	});

	it("does not emit unplannable warnings for plannable predicate clauses", () => {
		const suite = planTestCases(makeContext());
		expect(suiteWarnings(suite)).toEqual([]);
	});
});

describe("planTestCases — predicate determinism (ADR-0002)", () => {
	it("two plan runs over the same predicate context produce identical suites including the violation case", () => {
		const first = planTestCases(makeContext());
		const second = planTestCases(makeContext());

		expect(second).toEqual(first);
		expect(predicateViolationCases(first, PRED_CLAUSE).length).toBeGreaterThan(
			0,
		);
		expect(predicateViolationCases(second, PRED_CLAUSE).length).toBeGreaterThan(
			0,
		);
	});
});

describe("planTestCases — non-regression: predicate + numeric compare coexistence (§9.1)", () => {
	it("keeps the numeric clause's boundary cases while adding the predicate clause's violation case", () => {
		const suite = planTestCases(makeContext());

		// Numeric compare clause (amount >= 10): §9.1 boundary synthesis is
		// unaffected by the presence of a predicate-call precondition.
		const boundaries = allCases(suite).filter(
			(case_) =>
				case_.kind === "boundary" &&
				case_.traces.includes("AccountService.withdraw.pre0"),
		);
		expect(boundaries.length).toBeGreaterThan(0);
		const values = boundaries
			.map((case_) => case_.inputs.amount as number)
			.sort((a, b) => a - b);
		expect(values).toEqual([9, 10, 11]);

		// Predicate clause in the SAME operation still gets its violation case.
		const predicateViolations = predicateViolationCases(
			suite,
			PRED_CLAUSE_ACCOUNT,
		);
		expect(predicateViolations.length).toBeGreaterThan(0);
	});
});

describe("planTestCases — predicate-aware valid-input synthesis (§9.1, VERSAILLES-23 F4)", () => {
	it("synthesizes a predicate-aware valid input for an isPositive-guarded numeric param — never the falsifying 0 (contract example: 1)", () => {
		const suite = planTestCases(makeContext());

		const accepts = acceptCases(suite, ORDER, "setSubtotal");
		expect(accepts.length).toBeGreaterThan(0);
		const amount = accepts[0].inputs.amount;

		// Robust contract pin (build-spec §9.1): a "valid" input must be a
		// NUMBER the registered predicate accepts. isPositive(0) is false, so
		// 0 is provably invalid and must never appear on the accept side.
		expect(typeof amount).toBe("number");
		expect(amount).not.toBe(0);
		// Deterministic rule freeze (deterministic-generation.contract.yaml
		// example: isPositive → 1): a number-paramType predicate guard
		// synthesizes 1 — the positive counterpart of the -1 violation
		// counter-example. Deliberately an exact-value pin, not merely
		// not-to-be-0 — the contract names 1 and the planner must stay
		// deterministic (ADR-0002).
		expect(amount).toBe(1);
	});

	it("predicate-guarded accept cases keep the existing ADR-0007 accept shape — outcome accept, no rejectionIdiom (no regression)", () => {
		const suite = planTestCases(makeContext());

		const accepts = acceptCases(suite, ORDER, "setSubtotal");
		expect(accepts.length).toBeGreaterThan(0);
		for (const accept of accepts) {
			expect(accept.expects.outcome).toBe("accept");
			// The rejection idiom is a reject-case-only field (ADR-0007).
			// Predicate-aware synthesis must not reshape an accept case into
			// a reject-shaped one.
			expect(accept.expects.rejectionIdiom).toBeUndefined();
		}
	});

	it("keeps the legacy valid default (0) for a predicate-less numeric param — backward compat", () => {
		const suite = planTestCases(plainParamsContext());

		const accepts = acceptCases(suite, PLAIN, "setValue");
		expect(accepts.length).toBeGreaterThan(0);
		// No predicate clause constrains x — today's deterministic default
		// (pickNumeric with no bounds → 0) must stay unchanged. The F4 fix
		// must only affect predicate-guarded params.
		expect(accepts[0].inputs.x).toBe(0);
	});

	it("synthesizes predicate-aware accept inputs deterministically — two runs, identical accept inputs (ADR-0002)", () => {
		const first = planTestCases(makeContext());
		const second = planTestCases(makeContext());

		const amount1 = acceptCases(first, ORDER, "setSubtotal")[0]?.inputs.amount;
		const amount2 = acceptCases(second, ORDER, "setSubtotal")[0]?.inputs.amount;
		expect(amount2).toEqual(amount1);
		expect(amount1).not.toBeUndefined();
	});

	it("plans a coherent pair for a guarded op: predicate violation (reject) AND a non-provably-invalid accept", () => {
		const suite = planTestCases(makeContext());

		// F3 side: the predicate-call precondition still yields its violation
		// case with a reject outcome.
		const violations = predicateViolationCases(suite, PRED_CLAUSE);
		expect(violations.length).toBeGreaterThan(0);
		expect(violations[0].expects.outcome).toBe("reject");

		// F4 side: the SAME operation's accept case is not provably invalid.
		const accepts = acceptCases(suite, ORDER, "setSubtotal");
		expect(accepts.length).toBeGreaterThan(0);
		expect(accepts[0].expects.outcome).toBe("accept");
		expect(accepts[0].inputs.amount).toBe(1);

		// Coherence: the "valid" input is distinct from the falsifying input —
		// the accept value never reuses the violation counter-example.
		expect(accepts[0].inputs.amount).not.toBe(violations[0].inputs.amount);
	});

	it("never warns or crashes on the accept side for a degenerate (accept-all) predicate guard", () => {
		const suite = planTestCases(degeneratePredicateContext());

		// No crash; the accept case is still planned with a numeric value.
		const accepts = acceptCases(suite, ORDER, "setSubtotal");
		expect(accepts.length).toBeGreaterThan(0);
		expect(typeof accepts[0].inputs.amount).toBe("number");

		// The accept side must not surface PREDICATE_UNPLANNABLE warnings —
		// that channel is reserved for genuinely unplannable VIOLATION
		// synthesis (F3). A number paramType is always plannable on the accept
		// side, even when the predicate's false-set is empty / unknown.
		expect(suiteWarnings(suite)).toEqual([]);
	});
});

describe("planTestCases — violation-case isolation (§9.1, VERSAILLES-147)", () => {
	it("predicate-violation case satisfies the OTHER clause — sku takes the deterministic valid string, never undefined (V-147)", () => {
		const suite = planTestCases(addItemIsolationContext());

		// pre1 `isPositive(price)` violation: the falsifying input is
		// price = -1. §9.1 requires the case to satisfy all OTHER clauses, so
		// sku must carry buildValidParams' deterministic valid string
		// default "initial" — never undefined (the committed example's
		// `addItem(undefined, -1)` left sku undefined, which itself falsifies
		// pre0 `sku != ""` and breaks isolation).
		const violations = predicateViolationCases(suite, ADD_ITEM_PRE1);
		expect(violations.length).toBeGreaterThan(0);
		expect(violations[0].inputs).toEqual({ sku: "initial", price: -1 });
	});

	it("generic-violation case satisfies the OTHER clause — price takes the registered-predicate-valid value 1, never undefined (V-147)", () => {
		const suite = planTestCases(addItemIsolationContext());

		// pre0 `sku != ""` violation: the falsifying input is sku = "" (the
		// generic planGenericViolationCase path). §9.1 requires the case to
		// satisfy all OTHER clauses, so the predicate-guarded price must keep
		// the predicate-valid value 1 — never undefined (the committed
		// example's `addItem("", undefined)` left price undefined, which
		// itself falsifies pre1 `isPositive(price)` and breaks isolation).
		const violations = allCases(suite).filter(
			(case_) =>
				case_.kind === "precondition-violation" &&
				case_.traces.includes(ADD_ITEM_PRE0) &&
				case_.expects.outcome === "reject",
		);
		expect(violations.length).toBeGreaterThan(0);
		expect(violations[0].inputs).toEqual({ sku: "", price: 1 });
	});
});
