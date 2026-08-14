import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseExpression } from "../src/core/parser.js";
import type { Node } from "../src/core/parser.js";
// RED phase (VERSAILLES-6): src/generator/ does not exist yet — these value
// imports fail to resolve. That IS the expected Red state.
import {
	coverageManifest,
	emitSuite,
	planTestCases,
} from "../src/generator/index.js";
import type { PlannedCase, PlannedSuite } from "../src/generator/index.js";
import type { VersaillesContext } from "../src/loader/workspace.js";

/**
 * Deterministic generator core — property tests (ADR-0002, build-spec §9.4).
 *
 * The generator's central invariant is determinism: generation is a pure
 * function of the context — same context in, byte-identical suite out, with
 * no randomness, no timestamps, and no LLM (ADR-0002). Property tests extend
 * the deterministic battery in tests/generator.test.ts across randomly
 * generated contexts:
 *
 * 1. planTestCases(ctx) is a pure function: two calls on the same context
 *    return deep-equal suites.
 * 2. emitSuite is idempotent: two calls on the same suite return byte-identical
 *    files (§9.4 full-file regeneration).
 * 3. coverageManifest is a pure function of the suite (§9.3).
 * 4. Suite invariants hold across generated contexts: unique case ids,
 *    non-empty traces, and exactly three boundary cases per numeric
 *    comparison clause (boundary, boundary−1, boundary+1).
 *
 * Every property uses the standard fast-check-in-vitest pattern:
 * `fc.assert(fc.property(arb, fn), { numRuns })`, with numRuns 50.
 */

const COMPARE_OPS = fc.constantFrom(">=", ">", "<=", "<");
// NOTE (Power Forward, Green phase): the grammar has no unary minus (pinned in
// tests/parser.test.ts), so a negative boundary would make the fixture expr
// (e.g. "amount < -3") fail to parse in parseAst below. Bounding the arbitrary
// to non-negative values keeps the random-boundary intent and every assertion
// in this file unchanged.
const BOUNDARY = fc.integer({ min: 0, max: 50 });
// NOTE (Power Forward, Green phase): `fc.set` returns a Set (not an array)
// in the pinned fast-check ^4.9.0 (it is uniqueArray + Set conversion since
// 4.4.0), and the contextArb fixture calls `members.map(...)`. `uniqueArray`
// is the array-returning equivalent with identical uniqueness semantics —
// every assertion in this file is unchanged.
const MEMBERS = fc.uniqueArray(fc.constantFrom("A", "B", "C"), {
	minLength: 1,
	maxLength: 3,
});

function parseAst(
	expr: string,
	kind: "preconditions" | "postconditions" | "invariants",
	id: string,
): Node {
	const result = parseExpression(expr, kind, id);
	if (!result.ok) {
		throw new Error(
			`fixture parse failed for "${expr}": ${JSON.stringify(result.errors)}`,
		);
	}
	return result.ast;
}

/**
 * Builds a random but structurally valid, fully-loaded VersaillesContext
 * (isValid: true) whose withdraw operation carries two random numeric
 * comparison preconditions and one random in-clause precondition. The
 * postconditions and invariant are fixed and resolvable (balance is a
 * manifest field; amount/status are operation params).
 */
function makeGeneratedContext(
	pre0: string,
	pre1: string,
	pre2: string,
): VersaillesContext {
	return {
		config: {
			grammarVersion: "1.0",
			schemaVersion: "1.0",
			sourceRoots: ["src/**/*.ts"],
			language: "typescript",
			testFramework: "vitest",
			generatedDir: ".versailles/generated",
			staleness: { blockOnStale: false },
		},
		contracts: {
			version: "1.0",
			contracts: {
				Gen: {
					invariants: [{ id: "Gen.inv0", expr: "balance >= 0" }],
					operations: {
						withdraw: {
							id: "Gen.withdraw",
							params: [
								{ name: "amount", type: "number" },
								{ name: "status", type: "string" },
							],
							preconditions: [
								{ id: "Gen.withdraw.pre0", expr: pre0 },
								{ id: "Gen.withdraw.pre1", expr: pre1 },
								{ id: "Gen.withdraw.pre2", expr: pre2 },
							],
							postconditions: [
								{
									id: "Gen.withdraw.post0",
									expr: "old(balance) - amount == balance",
								},
								{
									id: "Gen.withdraw.post1",
									expr: "old(balance) >= balance",
								},
							],
							effects: [{ field: "balance", kind: "mutate" }],
							sourceHash: "gen-hash",
						},
					},
				},
			},
		},
		manifests: {
			version: "1.0",
			manifests: {
				Gen: { sourceHash: "man-gen", fields: { balance: "number" } },
			},
		},
		predicates: { version: "1.0", predicates: {} },
		parsedContracts: {
			"Gen.withdraw.pre0": parseAst(pre0, "preconditions", "Gen.withdraw.pre0"),
			"Gen.withdraw.pre1": parseAst(pre1, "preconditions", "Gen.withdraw.pre1"),
			"Gen.withdraw.pre2": parseAst(pre2, "preconditions", "Gen.withdraw.pre2"),
			"Gen.withdraw.post0": parseAst(
				"old(balance) - amount == balance",
				"postconditions",
				"Gen.withdraw.post0",
			),
			"Gen.withdraw.post1": parseAst(
				"old(balance) >= balance",
				"postconditions",
				"Gen.withdraw.post1",
			),
			"Gen.inv0": parseAst("balance >= 0", "invariants", "Gen.inv0"),
		},
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

const contextArb: fc.Arbitrary<VersaillesContext> = fc
	.tuple(COMPARE_OPS, BOUNDARY, COMPARE_OPS, BOUNDARY, MEMBERS)
	.map(([op0, boundary0, op1, boundary1, members]) =>
		makeGeneratedContext(
			`amount ${op0} ${boundary0}`,
			`amount ${op1} ${boundary1}`,
			`status in [${members.map((member) => `"${member}"`).join(", ")}]`,
		),
	);

function allCases(suite: PlannedSuite): PlannedCase[] {
	return [
		...suite.operations.flatMap((group) => group.cases),
		...suite.invariantCases,
	];
}

describe("planTestCases — determinism (ADR-0002)", () => {
	it("same context in → same planned suite out (no randomness, no timestamps)", () => {
		fc.assert(
			fc.property(contextArb, (context) => {
				const first = planTestCases(context);
				const second = planTestCases(context);
				expect(second).toEqual(first);
			}),
			{ numRuns: 50 },
		);
	});
});

describe("emitSuite — determinism (§9.4)", () => {
	it("same suite → byte-identical emitted files", () => {
		fc.assert(
			fc.property(contextArb, (context) => {
				const suite = planTestCases(context);
				expect(emitSuite(suite, "vitest")).toEqual(emitSuite(suite, "vitest"));
			}),
			{ numRuns: 50 },
		);
	});
});

describe("coverageManifest — determinism (§9.3)", () => {
	it("same suite → identical coverage manifest", () => {
		fc.assert(
			fc.property(contextArb, (context) => {
				const suite = planTestCases(context);
				expect(coverageManifest(suite)).toEqual(coverageManifest(suite));
			}),
			{ numRuns: 50 },
		);
	});
});

describe("planTestCases — suite invariants across generated contexts", () => {
	it("every planned case has a unique id and non-empty traces; each numeric clause gets exactly three boundary cases", () => {
		fc.assert(
			fc.property(contextArb, (context) => {
				const suite = planTestCases(context);
				const all = allCases(suite);
				expect(all.length).toBeGreaterThan(0);

				const ids = all.map((case_) => case_.id);
				expect(new Set(ids).size).toBe(ids.length);
				for (const case_ of all) {
					expect(case_.traces.length).toBeGreaterThan(0);
				}

				// §9.1: every numeric comparison precondition yields exactly
				// the boundary, boundary−1, and boundary+1 cases.
				for (const clauseId of ["Gen.withdraw.pre0", "Gen.withdraw.pre1"]) {
					const boundary = all.filter(
						(case_) =>
							case_.kind === "boundary" && case_.traces.includes(clauseId),
					);
					expect(boundary).toHaveLength(3);
				}
			}),
			{ numRuns: 50 },
		);
	});
});
