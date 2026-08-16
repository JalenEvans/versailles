import { describe, expect, it } from "vitest";

import { parseExpression } from "../src/core/parser.js";
import type { ClauseKind, Node, ParseError } from "../src/core/parser.js";
// The generator core (src/generator/) is implemented; these value imports
// resolve at runtime. The assertions below pin the generator contract the
// implementation must satisfy.
import {
	coverageManifest,
	emitSuite,
	planTestCases,
} from "../src/generator/index.js";
import type {
	CoverageManifest,
	EmittedFile,
	OperationCaseGroup,
	PlannedCase,
	PlannedSuite,
} from "../src/generator/index.js";
import type {
	ContractClause,
	ContractsFile,
	ManifestsFile,
	PredicatesFile,
	VersaillesContext,
	WorkspaceConfig,
} from "../src/loader/workspace.js";

/**
 * Deterministic generator core (Phase 4, VERSAILLES-6) — pinned against
 * docs/specs/deterministic-generation.md, docs/contracts/deterministic-generation.contract.yaml,
 * build-spec §9.1–§9.4, and ADR-0002 / ADR-0007 / ADR-0008 / ADR-0009.
 *
 * The generator is the core value proposition of Versailles: a pure,
 * deterministic compiler from an approved VersaillesContext (isValid: true)
 * to a framework-agnostic test-case IR. This file freezes the IR contract
 * that src/generator/ implements. The assertions below pin the behaviours
 * the implementation must satisfy.
 *
 * ── Module contract (what these tests require from src/generator/) ────────
 *
 * Module: src/generator/index.ts
 * Exports: planTestCases, emitSuite, coverageManifest (+ the IR types below)
 *
 * ```ts
 * export type CaseKind =
 *   | "boundary"                 // §9.1: boundary, boundary−1, boundary+1
 *   | "partition"                // §9.1: one per in-clause/enum member + one outside
 *   | "precondition-violation"   // §9.1: other clauses hold, this one falsified → reject
 *   | "postcondition-satisfaction" // §9.1: valid input, assert every postcondition
 *   | "invariant"                // §9.2: valid pre-state, call, assert invariants post-call
 *   | "expected-rejection";      // §9.2: postcondition satisfiable, invariant violated → reject
 *
 * export type PlannedCase = {
 *   id: string;                  // unique; "<component>.<operation>.<kind>-<n>"
 *   kind: CaseKind;
 *   description: string;         // non-empty, embedded in the rendered test name
 *   inputs: Record<string, unknown>; // call args (param name → value) PLUS
 *                                 // captured pre-call component state (field
 *                                 // name → value) so old(field) resolves
 *   expects: {
 *     outcome: "accept" | "reject";
 *     rejectionIdiom?: string;   // present on EVERY reject case; read from
 *                                 // config.rejection.idiom, default "throws" (ADR-0007)
 *     postconditions?: string[]; // postcondition clause IDs a satisfaction case asserts
 *   };
 *   traces: string[];            // contract clause IDs the case covers (§9.3)
 * };
 *
 * export type OperationCaseGroup = { component: string; operation: string; cases: PlannedCase[] };
 *
 * export type PlannedSuite = {
 *   operations: OperationCaseGroup[]; // §9.1 cases grouped per operation
 *   invariantCases: PlannedCase[];    // §9.2 invariant + expected-rejection cases
 *   clauseIds: string[];              // EVERY source clause ID (coverage needs
 *                                     // the full set to expose zero-coverage gaps)
 * };
 *
 * export type EmittedFile = { path: string; content: string };
 * export type EmitOptions = {
 *   generatedDir?: string;              // overrides ".versailles/generated"
 *   modulePaths?: Record<string, string>; // per-component import specifier overrides
 * };
 * export type CoverageManifest = { coverage: Record<string, string[]> };
 *
 * export declare function planTestCases(context: VersaillesContext): PlannedSuite;
 * export declare function emitSuite(
 *   suite: PlannedSuite,
 *   framework: "vitest" | "xunit" | "pytest",
 *   options?: EmitOptions,
 * ): EmittedFile[];
 * export declare function coverageManifest(suite: PlannedSuite): CoverageManifest;
 * ```
 *
 * ── Design decisions these tests pin (documented for the implementer) ─────
 *
 * 1. Rejection idiom (ADR-0007): the planner copies the configured idiom
 *    (config.rejection.idiom, default "throws") onto EVERY reject case's
 *    expects.rejectionIdiom — never hardcoded in the core. The vitest
 *    emitter alone knows the assertion text: "throws" →
 *    `expect(() => op(inputs)).toThrow()`, "returns" → `expect(op(inputs)).toBeNull()`.
 * 2. Boundary outcomes are value-derived: for `x >= b`, the boundary−1 value
 *    violates the clause → reject; boundary and boundary+1 → accept. For
 *    `x <= b`, boundary+1 violates → reject. A reject boundary case may
 *    double as that clause's precondition-violation case (same input); the
 *    tests therefore find violation cases by (traces, outcome, falsifying
 *    input), never by requiring a distinct kind.
 * 3. Partition outside-set case: kind "partition", outcome "reject" with the
 *    configured idiom (for an `in` clause it is also that clause's violation
 *    input). Partition members are kind "partition", outcome "accept".
 * 4. Pre-call state: postcondition-satisfaction / invariant / expected-rejection
 *    cases record the captured pre-call component state inside `inputs` under
 *    the manifest field name (e.g. `balance`) so the emitter can resolve
 *    `old(field)` and build the pre-state.
 * 5. Expected-rejection cases live in suite.invariantCases (§9.2 is the
 *    per-component invariant section); their ids are prefixed
 *    "<component>.<operation>.".
 * 6. Invalid contexts block generation: planTestCases throws when
 *    context.isValid is false (contract invariant 1).
 * 7. Emitter seam (ADR-0008/0009): emitSuite dispatches on framework across
 *    the full v1 matrix ("vitest" | "xunit" | "pytest"); an unknown framework
 *    string still throws at the seam (pinned in tests/emitters.test.ts).
 */

const ACCOUNT = "AccountService";
const CUSTOMER = "CustomerService";

const CLAUSE_IDS = [
	"AccountService.inv0",
	"AccountService.withdraw.pre0",
	"AccountService.withdraw.pre1",
	"AccountService.withdraw.post0",
	"AccountService.withdraw.post1",
	"AccountService.setStatus.pre0",
	"AccountService.setStatus.post0",
	"CustomerService.upgrade.pre0",
];

function contractsFixture(): ContractsFile {
	return {
		version: "1.0",
		contracts: {
			[ACCOUNT]: {
				invariants: [{ id: "AccountService.inv0", expr: "balance >= 0" }],
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
								id: "AccountService.withdraw.pre1",
								expr: "amount <= 100",
							},
						],
						postconditions: [
							{
								id: "AccountService.withdraw.post0",
								expr: "old(balance) - amount == balance",
							},
							{
								id: "AccountService.withdraw.post1",
								expr: "old(balance) >= balance",
							},
						],
						effects: [{ field: "balance", kind: "mutate" }],
						sourceHash: "withdraw-hash",
					},
					setStatus: {
						id: "AccountService.setStatus",
						params: [{ name: "newStatus", type: "string" }],
						preconditions: [
							{
								id: "AccountService.setStatus.pre0",
								expr: 'newStatus in ["ACTIVE", "FROZEN"]',
							},
						],
						postconditions: [
							{
								id: "AccountService.setStatus.post0",
								expr: "status == newStatus",
							},
						],
						effects: [{ field: "status", kind: "mutate" }],
						sourceHash: "setstatus-hash",
					},
				},
			},
			[CUSTOMER]: {
				// No invariants: §9.2 invariant/expected-rejection cases must
				// NOT be planned for this component (negative control).
				invariants: [],
				operations: {
					upgrade: {
						id: "CustomerService.upgrade",
						// enum-typed operation param: a §9.1 equivalence-partition
						// source (one case per member + one outside the set).
						params: [{ name: "newTier", type: "enum<GOLD,SILVER>" }],
						preconditions: [
							{
								id: "CustomerService.upgrade.pre0",
								expr: "newTier != null",
							},
						],
						postconditions: [],
						effects: [],
						sourceHash: "upgrade-hash",
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
			[ACCOUNT]: {
				sourceHash: "man-account",
				fields: { balance: "number", status: "string" },
			},
			[CUSTOMER]: { sourceHash: "man-customer", fields: {} },
		},
	};
}

function predicatesFixture(): PredicatesFile {
	return { version: "1.0", predicates: {} };
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
 * loader), mirroring the fixture approach in tests/validator.test.ts. With no
 * rejection argument the config carries NO rejection block — exercising the
 * ADR-0007 default (throws).
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

function makeInvalidContext(): VersaillesContext {
	const context = makeContext();
	return {
		...context,
		parseErrors: [
			{
				contractId: "AccountService.withdraw.pre0",
				field: "preconditions[0]",
				position: 0,
				found: "",
				expected: ["term"],
				message: "broken",
			} as ParseError,
		],
		isValid: false,
	};
}

function operationCases(
	suite: PlannedSuite,
	component: string,
	operation: string,
): PlannedCase[] {
	return (
		suite.operations.find(
			(group) => group.component === component && group.operation === operation,
		)?.cases ?? []
	);
}

function allCases(suite: PlannedSuite): PlannedCase[] {
	return [
		...suite.operations.flatMap((group) => group.cases),
		...suite.invariantCases,
	];
}

function boundaryCases(
	suite: PlannedSuite,
	component: string,
	operation: string,
	clauseId: string,
): PlannedCase[] {
	return operationCases(suite, component, operation).filter(
		(case_) => case_.kind === "boundary" && case_.traces.includes(clauseId),
	);
}

function rejectCases(suite: PlannedSuite): PlannedCase[] {
	return allCases(suite).filter((case_) => case_.expects.outcome === "reject");
}

describe("planTestCases — boundary values (§9.1)", () => {
	it("plans boundary, boundary−1, boundary+1 for `amount >= 10` (9, 10, 11), reject at boundary−1", () => {
		const suite = planTestCases(makeContext());

		const cases = boundaryCases(
			suite,
			ACCOUNT,
			"withdraw",
			"AccountService.withdraw.pre0",
		);
		const values = cases
			.map((case_) => case_.inputs.amount as number)
			.sort((a, b) => a - b);
		expect(values).toEqual([9, 10, 11]);

		const byValue = new Map(cases.map((case_) => [case_.inputs.amount, case_]));
		// 9 falsifies amount >= 10 → the operation must reject.
		expect(byValue.get(9)?.expects.outcome).toBe("reject");
		expect(byValue.get(9)?.expects.rejectionIdiom).toBe("throws");
		expect(byValue.get(10)?.expects.outcome).toBe("accept");
		expect(byValue.get(11)?.expects.outcome).toBe("accept");
		for (const case_ of cases) {
			expect(case_.traces).toContain("AccountService.withdraw.pre0");
		}
	});

	it("plans boundary, boundary−1, boundary+1 for `amount <= 100` (99, 100, 101), reject at boundary+1", () => {
		const suite = planTestCases(makeContext());

		const cases = boundaryCases(
			suite,
			ACCOUNT,
			"withdraw",
			"AccountService.withdraw.pre1",
		);
		const values = cases
			.map((case_) => case_.inputs.amount as number)
			.sort((a, b) => a - b);
		expect(values).toEqual([99, 100, 101]);

		const byValue = new Map(cases.map((case_) => [case_.inputs.amount, case_]));
		expect(byValue.get(99)?.expects.outcome).toBe("accept");
		expect(byValue.get(100)?.expects.outcome).toBe("accept");
		// 101 falsifies amount <= 100 → the operation must reject.
		expect(byValue.get(101)?.expects.outcome).toBe("reject");
		expect(byValue.get(101)?.expects.rejectionIdiom).toBe("throws");
		for (const case_ of cases) {
			expect(case_.traces).toContain("AccountService.withdraw.pre1");
		}
	});
});

describe("planTestCases — equivalence partitions (§9.1)", () => {
	it("plans one partition case per `in`-clause member plus one outside the set", () => {
		const suite = planTestCases(makeContext());

		const cases = operationCases(suite, ACCOUNT, "setStatus").filter(
			(case_) => case_.kind === "partition",
		);
		const memberValues = cases.map((case_) => case_.inputs.newStatus);
		expect(memberValues).toContain("ACTIVE");
		expect(memberValues).toContain("FROZEN");

		const outside = cases.filter(
			(case_) =>
				case_.inputs.newStatus !== "ACTIVE" &&
				case_.inputs.newStatus !== "FROZEN",
		);
		expect(outside.length).toBeGreaterThan(0);

		for (const case_ of cases) {
			expect(case_.traces).toContain("AccountService.setStatus.pre0");
		}
		for (const member of ["ACTIVE", "FROZEN"]) {
			const memberCase = cases.find(
				(case_) => case_.inputs.newStatus === member,
			);
			expect(memberCase?.expects.outcome).toBe("accept");
		}
		// The outside-set value falsifies the in clause → reject, configured idiom.
		expect(outside[0].expects.outcome).toBe("reject");
		expect(outside[0].expects.rejectionIdiom).toBe("throws");
	});

	it("plans one partition case per enum-typed field member plus one outside the set", () => {
		const suite = planTestCases(makeContext());

		const cases = operationCases(suite, CUSTOMER, "upgrade").filter(
			(case_) => case_.kind === "partition",
		);
		const memberValues = cases.map((case_) => case_.inputs.newTier);
		expect(memberValues).toContain("GOLD");
		expect(memberValues).toContain("SILVER");

		const outside = cases.filter(
			(case_) =>
				case_.inputs.newTier !== "GOLD" && case_.inputs.newTier !== "SILVER",
		);
		expect(outside.length).toBeGreaterThan(0);
		expect(outside[0].expects.outcome).toBe("reject");
		expect(outside[0].expects.rejectionIdiom).toBe("throws");
	});
});

describe("planTestCases — precondition-violation cases (§9.1, ADR-0007)", () => {
	it("plans a reject case per precondition clause, satisfying the other clauses but falsifying this one", () => {
		const suite = planTestCases(makeContext());

		// withdraw.pre0 (amount >= 10): falsify with 9, still <= 100.
		const pre0 = allCases(suite).filter(
			(case_) =>
				case_.traces.includes("AccountService.withdraw.pre0") &&
				case_.expects.outcome === "reject",
		);
		expect(pre0.length).toBeGreaterThan(0);
		expect(pre0.some((case_) => case_.inputs.amount === 9)).toBe(true);

		// withdraw.pre1 (amount <= 100): falsify with 101, still >= 10.
		const pre1 = allCases(suite).filter(
			(case_) =>
				case_.traces.includes("AccountService.withdraw.pre1") &&
				case_.expects.outcome === "reject",
		);
		expect(pre1.length).toBeGreaterThan(0);
		expect(pre1.some((case_) => case_.inputs.amount === 101)).toBe(true);

		// setStatus.pre0 (in-clause): falsify with a value outside the set.
		const inClause = allCases(suite).filter(
			(case_) =>
				case_.traces.includes("AccountService.setStatus.pre0") &&
				case_.expects.outcome === "reject",
		);
		expect(inClause.length).toBeGreaterThan(0);
		expect(
			inClause.some(
				(case_) =>
					case_.inputs.newStatus !== "ACTIVE" &&
					case_.inputs.newStatus !== "FROZEN",
			),
		).toBe(true);

		// CustomerService.upgrade.pre0 (newTier != null): falsify with null.
		const upgrade = allCases(suite).filter(
			(case_) =>
				case_.traces.includes("CustomerService.upgrade.pre0") &&
				case_.expects.outcome === "reject",
		);
		expect(upgrade.length).toBeGreaterThan(0);
		expect(upgrade.some((case_) => case_.inputs.newTier === null)).toBe(true);
	});

	it("every reject case carries the rejection idiom from config — default throws (ADR-0007)", () => {
		const suite = planTestCases(makeContext());
		const rejects = rejectCases(suite);
		expect(rejects.length).toBeGreaterThan(0);
		for (const case_ of rejects) {
			expect(case_.expects.rejectionIdiom).toBe("throws");
		}
	});
});

describe("planTestCases — postcondition-satisfaction cases (§9.1)", () => {
	it("plans satisfaction cases asserting every postcondition clause", () => {
		const suite = planTestCases(makeContext());

		const cases = operationCases(suite, ACCOUNT, "withdraw").filter(
			(case_) => case_.kind === "postcondition-satisfaction",
		);
		expect(cases.length).toBeGreaterThan(0);
		const satisfaction = cases[0];
		expect(satisfaction.expects.outcome).toBe("accept");
		expect(satisfaction.expects.postconditions).toEqual(
			expect.arrayContaining([
				"AccountService.withdraw.post0",
				"AccountService.withdraw.post1",
			]),
		);
		expect(satisfaction.traces).toEqual(
			expect.arrayContaining([
				"AccountService.withdraw.post0",
				"AccountService.withdraw.post1",
			]),
		);
		// The input is valid: satisfies both withdraw preconditions.
		const amount = satisfaction.inputs.amount as number;
		expect(amount).toBeGreaterThanOrEqual(10);
		expect(amount).toBeLessThanOrEqual(100);
	});

	it("captures pre-call state so old(field) can be resolved against it", () => {
		const suite = planTestCases(makeContext());

		const satisfaction = operationCases(suite, ACCOUNT, "withdraw").find(
			(case_) => case_.kind === "postcondition-satisfaction",
		);
		expect(satisfaction).toBeDefined();
		// The captured pre-call balance must be present in the case inputs so
		// the emitter can resolve old(balance) and build the pre-state.
		expect(typeof satisfaction?.inputs.balance).toBe("number");
		expect(satisfaction?.inputs.balance as number).toBeGreaterThanOrEqual(0);
	});
});

describe("planTestCases — per-component invariant tests (§9.2)", () => {
	it("plans an invariant case for each operation of a component with invariants (none for a component without)", () => {
		const suite = planTestCases(makeContext());

		for (const operation of ["withdraw", "setStatus"]) {
			const inv = suite.invariantCases.filter(
				(case_) =>
					case_.kind === "invariant" &&
					case_.id.startsWith(`AccountService.${operation}.`),
			);
			expect(inv.length).toBeGreaterThan(0);
			for (const case_ of inv) {
				expect(case_.kind).toBe("invariant");
				expect(case_.expects.outcome).toBe("accept");
				expect(case_.traces).toContain("AccountService.inv0");
			}
		}

		// CustomerService has no invariants → no §9.2 cases at all.
		expect(
			suite.invariantCases.filter((case_) =>
				case_.id.startsWith("CustomerService."),
			),
		).toEqual([]);
	});

	it("invariant cases build a valid pre-state satisfying all component invariants", () => {
		const suite = planTestCases(makeContext());

		const inv = suite.invariantCases.find(
			(case_) =>
				case_.id.startsWith("AccountService.withdraw.") &&
				case_.kind === "invariant",
		);
		expect(inv).toBeDefined();
		// Pre-state balance satisfies inv0 (balance >= 0).
		expect(inv?.inputs.balance as number).toBeGreaterThanOrEqual(0);
		// The call input is valid per withdraw preconditions.
		const amount = inv?.inputs.amount as number;
		expect(amount).toBeGreaterThanOrEqual(10);
		expect(amount).toBeLessThanOrEqual(100);
	});

	it("picks inputs whose DERIVED post-state still satisfies the invariant — the case must be self-consistent (Center W2)", () => {
		const suite = planTestCases(makeContext());
		const inv = suite.invariantCases.find(
			(case_) =>
				case_.id.startsWith("AccountService.withdraw.") &&
				case_.kind === "invariant",
		);
		expect(inv).toBeDefined();
		// post0 `old(balance) - amount == balance` derives
		// post.balance = old(balance) - amount = inputs.balance - inputs.amount.
		// An invariant case asserts balance >= 0 POST-call, so the derived
		// post-state must satisfy it — the planner may not emit a case whose
		// call would itself violate the invariant it claims to preserve
		// (current: amount=55, balance=50 → post-state -5).
		const balance = inv?.inputs.balance as number;
		const callAmount = inv?.inputs.amount as number;
		expect(balance - callAmount).toBeGreaterThanOrEqual(0);
	});
});

describe("planTestCases — expected-rejection cases (§9.2)", () => {
	it("plans expected-rejection cases when the postcondition holds but an invariant would be violated", () => {
		const suite = planTestCases(makeContext());

		const er = suite.invariantCases.find(
			(case_) => case_.kind === "expected-rejection",
		);
		expect(er).toBeDefined();
		expect(er?.expects.outcome).toBe("reject");
		expect(er?.expects.rejectionIdiom).toBe("throws");
		// The input satisfies the operation's postconditions but the resulting
		// state violates a component invariant: post-state balance = balance −
		// amount < 0, i.e. amount > pre-state balance.
		const amount = er?.inputs.amount as number;
		const balance = er?.inputs.balance as number;
		expect(amount).toBeGreaterThan(balance);
		// Traces the violated invariant AND the satisfied postcondition(s).
		expect(er?.traces).toContain("AccountService.inv0");
		expect(
			er?.traces.some((trace) =>
				trace.startsWith("AccountService.withdraw.post"),
			),
		).toBe(true);
	});

	it("uses the IR id format <component>.<operation>.<kind>-<n> — the expected-rejection id carries the operation segment (Center B1)", () => {
		const suite = planTestCases(makeContext());
		const er = suite.invariantCases.find(
			(case_) => case_.kind === "expected-rejection",
		);
		expect(er).toBeDefined();
		// The id must be "<component>.<operation>.<kind>-<n>", so the emitter
		// can derive the real operation name from segment 1. A component-only
		// prefix like "AccountService.expected-rejection-0" (no operation) is
		// a contract violation.
		expect(er?.id).toMatch(/^[^.]+\.[^.]+\.[^.]+-\d+$/);
		expect(er?.id).toMatch(
			/^AccountService\.withdraw\.expected-rejection-\d+$/,
		);
	});

	it("traces post0 for the expected-rejection case whose inputs genuinely satisfy it under post-state resolution (Center W3)", () => {
		const suite = planTestCases(makeContext());
		const er = suite.invariantCases.find(
			(case_) => case_.kind === "expected-rejection",
		);
		expect(er).toBeDefined();
		// Deterministic sweep first hit: amount=51 with captured pre-state
		// balance=50 derives post.balance = 50 - 51 = -1. DbC semantics: bare
		// field refs in a postcondition resolve to the POST-state (old() →
		// pre-state), so post0 `old(balance) - amount == balance` evaluates
		// 50 - 51 == -1 → true. A genuinely-satisfied postcondition must not
		// be dropped from the case's traces.
		expect(er?.inputs.amount).toBe(51);
		expect(er?.traces).toContain("AccountService.withdraw.post0");
		expect(er?.traces).toContain("AccountService.withdraw.post1");
		expect(er?.traces).toContain("AccountService.inv0");
	});
});

describe("planTestCases — rejection idiom configurability (ADR-0007)", () => {
	it('honors config.rejection.idiom = "returns" instead of hardcoding throws', () => {
		const suite = planTestCases(makeContext("returns"));
		const rejects = rejectCases(suite);
		expect(rejects.length).toBeGreaterThan(0);
		for (const case_ of rejects) {
			expect(case_.expects.rejectionIdiom).toBe("returns");
		}
	});
});

describe("planTestCases — generation gate (contract invariant 1)", () => {
	it("throws (never plans) when context.isValid is false", () => {
		expect(() => planTestCases(makeInvalidContext())).toThrow();
	});
});

describe("planTestCases — IR shape", () => {
	it("every planned case carries a unique id, a non-empty description, and non-empty traces", () => {
		const suite = planTestCases(makeContext());
		const all = allCases(suite);
		expect(all.length).toBeGreaterThan(0);

		const ids = all.map((case_) => case_.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const case_ of all) {
			expect(case_.description.length).toBeGreaterThan(0);
			expect(case_.traces.length).toBeGreaterThan(0);
		}
	});
});

describe("coverageManifest — traceability (§9.3)", () => {
	it("maps every contract clause id to the test ids that trace it", () => {
		const suite = planTestCases(makeContext());
		// clauseIds must carry the FULL source clause set so zero-coverage
		// clauses stay representable.
		expect(suite.clauseIds.sort()).toEqual([...CLAUSE_IDS].sort());

		const manifest: CoverageManifest = coverageManifest(suite);
		const all = allCases(suite);
		for (const clauseId of suite.clauseIds) {
			const testIds = manifest.coverage[clauseId];
			expect(Array.isArray(testIds)).toBe(true);
			for (const testId of testIds) {
				const case_ = all.find((candidate) => candidate.id === testId);
				expect(case_).toBeDefined();
				expect(case_?.traces).toContain(clauseId);
			}
		}
		// The invariant clause must be covered by the §9.2 cases.
		expect(manifest.coverage["AccountService.inv0"].length).toBeGreaterThan(0);
	});

	it("exposes zero-coverage clauses as empty test-id arrays", () => {
		const suite: PlannedSuite = {
			clauseIds: ["A.op.pre0", "A.op.post0"],
			operations: [
				{
					component: "A",
					operation: "op",
					cases: [
						{
							id: "A.op.boundary-0",
							kind: "boundary",
							description: "boundary value",
							inputs: { x: 1 },
							expects: { outcome: "accept" },
							traces: ["A.op.pre0"],
						},
					],
				},
			],
			invariantCases: [],
		};

		const manifest = coverageManifest(suite);
		expect(manifest.coverage["A.op.pre0"]).toEqual(["A.op.boundary-0"]);
		// A.clause with no generated test stays detectable as zero-coverage.
		expect(manifest.coverage["A.op.post0"]).toEqual([]);
	});
});

describe("emitSuite — vitest emitter (§9.4, ADR-0008)", () => {
	it("renders .test.ts files carrying each case's id and description in the test name", () => {
		const suite = planTestCases(makeContext());
		const files = emitSuite(suite, "vitest");

		expect(files.length).toBeGreaterThan(0);
		for (const file of files) {
			expect(file.path.endsWith(".test.ts")).toBe(true);
			expect(file.content.length).toBeGreaterThan(0);
		}
		for (const case_ of allCases(suite)) {
			const rendered = files.some(
				(file) =>
					file.content.includes(case_.id) &&
					file.content.includes(case_.description),
			);
			expect(rendered).toBe(true);
		}
	});

	it("emits a traceability comment per file referencing contract clause ids (§9.3)", () => {
		const suite = planTestCases(makeContext());
		const files = emitSuite(suite, "vitest");

		for (const file of files) {
			const traceLines = file.content
				.split("\n")
				.filter((line) => line.trim().startsWith("// traces:"));
			expect(traceLines.length).toBeGreaterThan(0);
			expect(
				traceLines.some((line) =>
					/AccountService\.(inv0|withdraw\.|setStatus\.)/.test(line),
				),
			).toBe(true);
		}
	});

	it("renders the throws rejection idiom as expect(() => ...).toThrow()", () => {
		const suite = planTestCases(makeContext());
		const files = emitSuite(suite, "vitest");

		const rejectCase = rejectCases(suite)[0];
		expect(rejectCase).toBeDefined();
		const file = files.find((candidate) =>
			candidate.content.includes(rejectCase.id),
		);
		expect(file).toBeDefined();
		expect(file?.content).toContain("expect(() =>");
		expect(file?.content).toContain("toThrow()");
	});

	it("renders the returns rejection idiom as expect(...).toBeNull() when configured", () => {
		const suite = planTestCases(makeContext("returns"));
		const files = emitSuite(suite, "vitest");

		const rejectCase = rejectCases(suite)[0];
		expect(rejectCase).toBeDefined();
		const file = files.find((candidate) =>
			candidate.content.includes(rejectCase.id),
		);
		expect(file).toBeDefined();
		expect(file?.content).toContain("toBeNull()");
		expect(file?.content).not.toContain("toThrow()");
	});

	it("renders every test call as a valid <component>.<operation>(...) — never a case-id-derived method (Center B1)", () => {
		const suite = planTestCases(makeContext());
		const files = emitSuite(suite, "vitest");
		const all = allCases(suite);

		for (const case_ of all) {
			const file = files.find((candidate) =>
				candidate.content.includes(case_.id),
			);
			expect(file).toBeDefined();
			// The emitter derives the operation from the id's <kind>-<n> tail,
			// not from a real operation for expected-rejection cases. No call
			// expression may be formed from the case-id suffix — the id
			// `<component>.<operation>.<kind>-<n>` must contain the real
			// operation in segment 1.
			const nonComponent = case_.id.split(".").slice(1).join(".");
			expect(file?.content).not.toContain(`.${nonComponent}(`);
		}

		// The fixture's expected-rejection case must call the real operation
		// `withdraw` — `AccountService.expected-rejection-0({...})` is invalid.
		const er = suite.invariantCases.find(
			(case_) => case_.kind === "expected-rejection",
		);
		expect(er).toBeDefined();
		const erFile = files.find((candidate) =>
			candidate.content.includes(er?.id),
		);
		expect(erFile).toBeDefined();
		expect(erFile?.content).toContain("AccountService.withdraw({");
		expect(erFile?.content).not.toContain("AccountService.expected-rejection");
	});

	it("emits a real invariant assertion for invariant cases — the subject field must be checked, not just toBeDefined() (Center W2)", () => {
		const suite = planTestCases(makeContext());
		const files = emitSuite(suite, "vitest");
		const inv = suite.invariantCases.find(
			(case_) => case_.kind === "invariant",
		);
		expect(inv).toBeDefined();
		const file = files.find((candidate) => candidate.content.includes(inv?.id));
		expect(file).toBeDefined();

		// Scope to the invariant case's own rendered it() block.
		const start = file?.content.indexOf(`it("${inv?.id}`);
		expect(start).toBeGreaterThan(-1);
		const end = file?.content.indexOf("\n\t});", start);
		const block = file?.content.slice(start, end);

		// The block must reference the invariant's subject field (balance) in
		// an assertion — and at least one such assertion must NOT be the
		// degenerate `expect(op(inputs)).toBeDefined()` accept render.
		const balanceAssertions = block
			.split("\n")
			.filter((line) => line.includes("expect(") && line.includes("balance"));
		expect(balanceAssertions.length).toBeGreaterThan(0);
		expect(
			balanceAssertions.some((line) => !line.includes("toBeDefined()")),
		).toBe(true);
	});
});

describe("emitSuite — idempotent full-file regeneration (§9.4)", () => {
	it("two emitSuite runs on the same suite produce byte-identical files", () => {
		const suite = planTestCases(makeContext());

		const first = emitSuite(suite, "vitest");
		const second = emitSuite(suite, "vitest");
		expect(second).toEqual(first);
		expect(second.map((file) => file.content)).toEqual(
			first.map((file) => file.content),
		);
	});
});

describe("emitSuite — identifier safety (Center W1: injection into generated files)", () => {
	// A hostile name that would terminate a string/statement if it flowed raw
	// into an import, describe title, method call, object key, or comment.
	const HOSTILE = 'Evil";globalThis.PWNED=1;//';

	function makeNamedContext(
		componentName: string,
		operationName: string,
		extraParamNames: string[],
	): VersaillesContext {
		const contracts: ContractsFile = {
			version: "1.0",
			contracts: {
				[componentName]: {
					invariants: [{ id: `${componentName}.inv0`, expr: "balance >= 0" }],
					operations: {
						[operationName]: {
							id: `${componentName}.${operationName}`,
							params: [
								{ name: "amount", type: "number" },
								...extraParamNames.map((name) => ({
									name,
									type: "string",
								})),
							],
							preconditions: [
								{
									id: `${componentName}.${operationName}.pre0`,
									expr: "amount >= 10",
								},
							],
							postconditions: [],
							effects: [{ field: "balance", kind: "mutate" }],
							sourceHash: "named-hash",
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
					[componentName]: {
						sourceHash: "man-named",
						fields: { balance: "number" },
					},
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

	it("throws when the component name is not a valid JS identifier — the raw hostile name never reaches a file (Center W1)", () => {
		const context = makeNamedContext(HOSTILE, "withdraw", []);
		// STRONGEST pinned behavior: emitSuite (or the planner) throws on an
		// invalid identifier instead of rendering it raw into the import
		// statement, describe title, call expression, object key, or path.
		expect(() => emitSuite(planTestCases(context), "vitest")).toThrow();
	});

	it("throws when the operation name is not a valid JS identifier (Center W1)", () => {
		const context = makeNamedContext("AccountService", HOSTILE, []);
		expect(() => emitSuite(planTestCases(context), "vitest")).toThrow();
	});

	it("throws when a param name is not a valid JS identifier — object-key injection (Center W1)", () => {
		const context = makeNamedContext("AccountService", "withdraw", [HOSTILE]);
		expect(() => emitSuite(planTestCases(context), "vitest")).toThrow();
	});

	it("never lets a hostile clause id break out of the traceability comment (Center W1)", () => {
		const context = makeContext();
		const contracts = context.contracts;
		if (contracts === null) {
			throw new Error("test precondition: contracts fixture must be present");
		}
		const withdraw = contracts.contracts[ACCOUNT].operations.withdraw;
		// A clause id with an embedded newline would terminate the `// traces:`
		// comment and inject an executable statement into the generated file.
		withdraw.preconditions = [
			{ id: "AccountService.withdraw.pre0\nPWNED();//", expr: "amount >= 10" },
			withdraw.preconditions[1],
		];
		context.parsedContracts = parseAll(contracts);

		const suite = planTestCases(context);
		let files: EmittedFile[];
		try {
			files = emitSuite(suite, "vitest");
		} catch {
			// Strongest behavior: invalid identifiers throw — no file is
			// generated, so no breakout can exist.
			return;
		}

		for (const file of files) {
			const traceLine = file.content
				.split("\n")
				.find((line) => line.trimStart().startsWith("// traces:"));
			expect(traceLine).toBeDefined();
			// The hostile payload may appear inside a JSON-stringified title,
			// but never as a standalone executable line (a comment breakout).
			const breakoutLines = file.content
				.split("\n")
				.filter((line) => line.trimStart().startsWith("PWNED();"));
			expect(breakoutLines).toEqual([]);
		}
	});
});

describe("emitSuite — output path configuration (Center W4)", () => {
	it("defaults to the config generatedDir and ../../src/ module paths when no options are passed", () => {
		const suite = planTestCases(makeContext());
		const files = emitSuite(suite, "vitest");

		const accountFile = files.find((file) =>
			file.path.endsWith("AccountService.test.ts"),
		);
		expect(accountFile).toBeDefined();
		expect(accountFile?.path.startsWith(".versailles/generated/")).toBe(true);
		expect(accountFile?.content).toContain(
			'import { AccountService } from "../../src/AccountService.js";',
		);
	});

	it("honors a custom generatedDir and module path mapping via the options argument (Center W4)", () => {
		const suite = planTestCases(makeContext());
		const files = emitSuite(suite, "vitest", {
			generatedDir: "custom/generated",
			modulePaths: { AccountService: "src/account/index.js" },
		});

		const accountFile = files.find((file) =>
			file.path.endsWith("AccountService.test.ts"),
		);
		expect(accountFile).toBeDefined();
		expect(accountFile?.path.startsWith("custom/generated/")).toBe(true);
		expect(accountFile?.content).toContain(
			'import { AccountService } from "src/account/index.js";',
		);
		expect(accountFile?.content).not.toContain(
			'from "../../src/AccountService.js"',
		);
	});
});
