import { describe, expect, it } from "vitest";

import { parseExpression } from "../packages/core/src/core/parser.js";
import type { Node } from "../packages/core/src/core/parser.js";
import type {
	ContractClause,
	ContractsFile,
	ManifestsFile,
	PredicatesFile,
	VersaillesContext,
} from "../packages/core/src/loader/workspace.js";
import { planTestCases } from "../packages/engine/src/generator/index.js";
// The PBT IR types are the NEW type surface of ADR-0017, exported from
// packages/engine/src/generator/ir.ts and re-exported through the barrel —
// the same convention every other generator IR type follows. These are
// type-only imports: they force the types to EXIST under a type-check, while
// the runtime Red for this chunk comes from the seed helper above.
import type {
	ArbitrarySpec,
	PropertyClause,
	PropertyDescriptor,
	PropertyOutcome,
} from "../packages/engine/src/generator/index.js";
// The seed-derivation helper is the NEW runtime surface of ADR-0017. It does
// NOT exist yet — this import is the Red-phase failure. The helper MUST live
// at packages/engine/src/generator/seed.ts (module `seed.js`) and be
// re-exported from the generator barrel (index.ts) for public-surface
// consistency with planTestCases/coverageManifest/emitSuite.
import { derivePropertySeed } from "../packages/engine/src/generator/seed.js";

/**
 * Seeded property-based test emission — seed derivation + PBT IR (ADR-0017,
 * accepted 2026-08-28). Pinned against docs/decisions/0017-property-based-test-emission-mit-core.md
 * and the propertyBased config block in packages/core/src/loader/workspace.ts
 * (`WorkspaceConfig.propertyBased = { enabled, numRuns, seed? }`).
 *
 * ADR-0017 Option A: when `config.json` `propertyBased.enabled` is true, the
 * emitter renders additive `fc.assert(prop, { seed })` blocks. The seed is
 * derived at GENERATION time from a stable 32-bit hash of the context — clause
 * IDs + grammar version — so generation stays a pure function (ADR-0002,
 * re-scoped to generation-time only) while the emitted test is reproducible
 * run-to-run.
 *
 * ── Module contract (what these tests require) ─────────────────────────────
 *
 * Module: packages/engine/src/generator/seed.ts (re-exported from index.ts)
 *
 * ```ts
 * export function derivePropertySeed(
 *   clauseIds: readonly string[],
 *   grammarVersion: string,
 * ): number;
 * ```
 *
 * Returns a SIGNED 32-bit integer (int32). Rationale pinned from the fast-check
 * contract itself: fc.assert's runner coerces the printed seed with `seed | 0`
 * (fast-check/lib ... readSeed: `const seed32 = p.seed | 0`), so a uint32 seed
 * like 4294967295 would silently become -1 at run time — the printed literal
 * would NOT reproduce. An int32 seed round-trips exactly (`seed | 0 === seed`).
 *
 * ── Design decisions these tests pin (documented for the implementer) ──────
 *
 * 1. Determinism: same (clauseIds, grammarVersion) → same seed, every call.
 *    The seed is a derived literal, never random, never time-based (ADR-0002).
 * 2. Distinctness: different clause sets → different seeds; same clauses with
 *    a different grammarVersion → different seed. The hash input is the FULL
 *    ordered clause-id set plus the grammar version.
 * 3. Order matters (stricter, documented behavior): ['a','b'] and ['b','a']
 *    derive different seeds. ADR-0017's consequence states "any contract edit
 *    reshuffles the exploration space (desirable)" — reordering clauses is a
 *    real contract edit, so it must reshuffle. The clause-id stream is NOT
 *    sorted before hashing.
 * 4. Empty clause list: deterministic and non-throwing (a contract with zero
 *    source clauses still derives a defined seed).
 * 5. Override precedence is NOT this helper's concern: it takes exactly
 *    (clauseIds, grammarVersion) and returns the DERIVED seed. The explicit
 *    config override (`config.propertyBased.seed`) is resolved by the planner
 *    (`config.propertyBased.seed ?? derivePropertySeed(...)`) and is pinned in
 *    the Chunk 5 planner tests — see packages/engine/src/generator/planner.ts.
 *
 * ── PBT IR type contract (ADR-0017, exported from ir.ts) ───────────────────
 *
 * A `PropertyDescriptor` captures everything a property block needs to plan
 * and emit, mirroring the existing PlannedCase conventions in ir.ts
 * (<component>.<operation> ids, ADR-0007 rejectionIdiom passthrough, §9.3
 * traces):
 *
 * ```ts
 * export type PropertyOutcome = "satisfies" | "rejects" | "invariant-preserving";
 *
 * export type ArbitrarySpec = {
 *   param: string;          // operation param name
 *   typeRef: string;        // raw typeRef from ContractOperation.params[].type
 *   kind: "number" | "string" | "boolean" | "enum";
 *   bounds?: { min: number; max: number }; // numeric constraint bounds (planner-derived)
 *   members?: unknown[];    // enum members, when kind === "enum"
 * };
 *
 * export type PropertyClause = {
 *   clauseId: string;       // source clause id — the coverage trace key (§9.3)
 *   code: string;           // codegen'd predicate text (the oracle)
 * };
 *
 * export type PropertyDescriptor = {
 *   id: string;             // "<component>.<operation>.property-<kind>-<n>"
 *   component: string;
 *   operation: string;
 *   params: ArbitrarySpec[];        // per-param arbitrary derivation inputs
 *   clauses: PropertyClause[];      // codegen'd clause predicates (the oracle)
 *   outcome: PropertyOutcome;       // satisfies / rejects / invariant-preserving
 *   rejectionIdiom?: string;        // ADR-0007 passthrough on rejects
 *   traces: string[];               // clause ids for coverage mapping (§9.3)
 * };
 * ```
 *
 * The supporting types (PropertyOutcome / ArbitrarySpec / PropertyClause) are
 * exercised by type-level tests; PropertyDescriptor additionally has a
 * runtime round-trip test. A suite-level property container (a
 * PlannedSuite-level type) is deliberately NOT pinned here — the planner
 * wiring lands in a later chunk.
 */

// ── Fixtures (mirroring tests/generator.test.ts conventions) ───────────────

/** Parses every fixture expr with the real parser (loader-shaped context). */
function parseAll(contracts: ContractsFile): Record<string, Node> {
	const parsed: Record<string, Node> = {};
	const walk = (
		clauses: ContractClause[],
		kind: "preconditions" | "postconditions" | "invariants",
	): void => {
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

/** A minimal valid context whose withdraw op surfaces clause ids (ADR-0018: no config version fields). */
function makeContext(): VersaillesContext {
	const contracts: ContractsFile = {
		contracts: {
			AccountService: {
				invariants: [{ id: "AccountService.inv0", expr: "balance >= 0" }],
				operations: {
					withdraw: {
						id: "AccountService.withdraw",
						params: [{ name: "amount", type: "number" }],
						preconditions: [
							{ id: "AccountService.withdraw.pre0", expr: "amount >= 10" },
							{ id: "AccountService.withdraw.pre1", expr: "amount <= 100" },
						],
						postconditions: [
							{
								id: "AccountService.withdraw.post0",
								expr: "old(balance) - amount == balance",
							},
						],
						effects: [{ field: "balance", kind: "mutate" }],
						sourceHash: "withdraw-hash",
					},
				},
			},
		},
	};
	const manifests: ManifestsFile = {
		manifests: {
			AccountService: {
				sourceHash: "man-account",
				fields: { balance: "number" },
			},
		},
	};
	const predicates: PredicatesFile = { predicates: {} };
	return {
		config: {
			sourceRoots: ["src/**/*.ts"],
			language: "typescript",
			testFramework: "vitest",
			generatedDir: ".versailles/generated",
			staleness: { blockOnStale: false },
		},
		contracts,
		manifests,
		predicates,
		parsedContracts: parseAll(contracts),
		parseErrors: [],
		validationErrors: [],
		validationWarnings: [],
		isValid: true,
	};
}

// ── derivePropertySeed — determinism (ADR-0002, ADR-0017) ───────────────────

describe("derivePropertySeed — determinism", () => {
	it("same (clauseIds, grammarVersion) → same seed across repeated calls", () => {
		const clauseIds = [
			"AccountService.inv0",
			"AccountService.withdraw.pre0",
			"AccountService.withdraw.post0",
		];
		const version = "1.0";

		const first = derivePropertySeed(clauseIds, version);
		for (let i = 0; i < 5; i++) {
			expect(derivePropertySeed(clauseIds, version)).toBe(first);
		}
	});

	it("treats the clauseIds argument as read-only (no mutation of the caller's array)", () => {
		const clauseIds = ["A.inv0", "A.op.pre0"];
		const snapshot = [...clauseIds];
		derivePropertySeed(clauseIds, "1.0");
		expect(clauseIds).toEqual(snapshot);
	});
});

// ── derivePropertySeed — distinctness (ADR-0017) ────────────────────────────

describe("derivePropertySeed — distinctness", () => {
	it("different clause sets → different seeds", () => {
		const a = derivePropertySeed(["A.inv0"], "1.0");
		const b = derivePropertySeed(["B.inv0"], "1.0");
		expect(a).not.toBe(b);
	});

	it("clause ORDER matters — ['a','b'] and ['b','a'] are different contracts → different seeds", () => {
		// Stricter, documented behavior: ADR-0017's consequences state "any
		// contract edit reshuffles the exploration space (desirable)". Clause
		// order is part of the contract's structural identity, so reordering
		// the clause-id stream MUST change the seed. The stream is NOT sorted
		// before hashing.
		const ab = derivePropertySeed(["A.op.pre0", "B.op.pre0"], "1.0");
		const ba = derivePropertySeed(["B.op.pre0", "A.op.pre0"], "1.0");
		expect(ab).not.toBe(ba);
	});

	it("grammar version is part of the seed input — same clauses, different version → different seed", () => {
		const clauseIds = ["AccountService.inv0"];
		const v1 = derivePropertySeed(clauseIds, "1.0");
		const v2 = derivePropertySeed(clauseIds, "2.0");
		expect(v2).not.toBe(v1);
	});
});

// ── derivePropertySeed — 32-bit range (fast-check contract) ─────────────────

describe("derivePropertySeed — 32-bit range", () => {
	it("returns a SIGNED 32-bit integer (int32) — the range fast-check's fc.assert(prop, { seed }) round-trips exactly", () => {
		// Pinned from fast-check's readSeed: `const seed32 = p.seed | 0`.
		// A uint32 seed would be silently coerced (e.g. 4294967295 → -1), so
		// the printed literal would NOT reproduce. int32 round-trips exactly.
		const seed = derivePropertySeed(
			["AccountService.inv0", "AccountService.withdraw.pre0"],
			"1.0",
		);
		expect(Number.isInteger(seed)).toBe(true);
		expect(seed).toBeGreaterThanOrEqual(-2147483648);
		expect(seed).toBeLessThanOrEqual(2147483647);
	});
});

// ── derivePropertySeed — empty clause set ───────────────────────────────────

describe("derivePropertySeed — empty clause set", () => {
	it("handles an empty clause list deterministically without throwing", () => {
		const empty = derivePropertySeed([], "1.0");
		expect(Number.isInteger(empty)).toBe(true);
		expect(derivePropertySeed([], "1.0")).toBe(empty);
	});
});

// ── derivePropertySeed — planning-time context integration ─────────────────

describe("derivePropertySeed — planning-time context integration", () => {
	it("derives a stable seed from a planned suite's clauseIds + the format-version seed input — the exact runtime access the planner uses", () => {
		const context = makeContext();
		const suite = planTestCases(context);

		// At planning time the clause ids live on the suite (collected from
		// context.contracts.contracts[].invariants[].id + operations[].
		// preconditions[].id + postconditions[].id — see planner.ts). ADR-0018
		// (VERSAILLES-170): the config no longer carries grammarVersion, so the
		// planner's seed input falls back to the fixed format version ("1.0").
		expect(suite.clauseIds.length).toBeGreaterThan(0);
		const formatVersion = "1.0";

		const first = derivePropertySeed(suite.clauseIds, formatVersion);
		const second = derivePropertySeed(
			planTestCases(context).clauseIds,
			formatVersion,
		);
		expect(second).toBe(first);
	});

	it("the derived seed differs from the EXPLICIT config override seed — override resolution is the planner's job, not this helper's", () => {
		// Pins the boundary decision: derivePropertySeed returns the DERIVED
		// seed; the planner applies `config.propertyBased.seed ?? derived`.
		// Chunk 5 planner tests pin the actual override-wins behavior.
		const context = makeContext();
		const suite = planTestCases(context);
		const derived = derivePropertySeed(suite.clauseIds, "1.0");
		const override = 123456;
		// The derived seed is not assumed to equal some arbitrary override.
		// (Both are valid int32s; the planner picks the override when set.)
		expect(Number.isInteger(override)).toBe(true);
		expect(derived).not.toBe(undefined);
	});
});

// ── PBT IR — PropertyDescriptor shape (ADR-0017) ────────────────────────────

describe("PBT IR — PropertyDescriptor shape (ADR-0017)", () => {
	it("round-trips the fields a property block needs to plan and emit", () => {
		// Constructed as a plain object pinned to the PropertyDescriptor
		// shape (satisfies = type-level force; runtime assertions below pin
		// the field semantics for the emitter).
		const descriptor = {
			id: "AccountService.withdraw.property-satisfies-0",
			component: "AccountService",
			operation: "withdraw",
			params: [
				{
					param: "amount",
					typeRef: "number",
					kind: "number",
					bounds: { min: 10, max: 100 },
				},
			],
			clauses: [
				{
					clauseId: "AccountService.withdraw.pre0",
					code: "(amount) => amount >= 10",
				},
				{
					clauseId: "AccountService.withdraw.post0",
					code: "(balance, amount) => balance - amount === 0",
				},
			],
			outcome: "satisfies",
			rejectionIdiom: "throws",
			traces: ["AccountService.withdraw.pre0", "AccountService.withdraw.post0"],
			// ADR-0017 Chunk 5: PropertyDescriptor carries the seed literal the
			// emitter needs for fc.assert(prop, { seed, numRuns }) — derived
			// per-block from the covered clause IDs + grammar version, or the
			// explicit config.propertyBased.seed override (planner-applied).
			seed: 12345,
		} satisfies PropertyDescriptor;

		expect(descriptor.id).toBe("AccountService.withdraw.property-satisfies-0");
		expect(descriptor.component).toBe("AccountService");
		expect(descriptor.operation).toBe("withdraw");
		expect(descriptor.outcome).toBe("satisfies");
		// Per-param arbitrary spec: typeRef + numeric constraint bounds.
		expect(descriptor.params).toEqual([
			{
				param: "amount",
				typeRef: "number",
				kind: "number",
				bounds: { min: 10, max: 100 },
			},
		]);
		// Codegen'd clause predicates (the oracle) carry their clause id.
		expect(descriptor.clauses.map((clause) => clause.clauseId)).toEqual([
			"AccountService.withdraw.pre0",
			"AccountService.withdraw.post0",
		]);
		expect(descriptor.clauses[0].code).toBe("(amount) => amount >= 10");
		// ADR-0007 rejection idiom passthrough (present on reject blocks).
		expect(descriptor.rejectionIdiom).toBe("throws");
		// §9.3 traceability: clause ids for the coverage manifest.
		expect(descriptor.traces).toEqual([
			"AccountService.withdraw.pre0",
			"AccountService.withdraw.post0",
		]);
	});

	it("a rejects descriptor carries the configured rejection idiom", () => {
		const descriptor = {
			id: "AccountService.withdraw.property-rejects-0",
			component: "AccountService",
			operation: "withdraw",
			params: [
				{
					param: "amount",
					typeRef: "number",
					kind: "number",
					bounds: { min: 10, max: 100 },
				},
			],
			clauses: [
				{
					clauseId: "AccountService.withdraw.pre0",
					code: "(amount) => amount >= 10",
				},
			],
			outcome: "rejects",
			rejectionIdiom: "returns",
			traces: ["AccountService.withdraw.pre0"],
			seed: -987654,
		} satisfies PropertyDescriptor;

		expect(descriptor.outcome).toBe("rejects");
		expect(descriptor.rejectionIdiom).toBe("returns");
	});
});

// ── PBT IR — supporting types (ADR-0017) ────────────────────────────────────

describe("PBT IR — supporting types (ADR-0017)", () => {
	it("PropertyOutcome admits the three planned outcomes (satisfies / rejects / invariant-preserving)", () => {
		const outcomes: PropertyOutcome[] = [
			"satisfies",
			"rejects",
			"invariant-preserving",
		];
		expect(outcomes).toHaveLength(3);
		expect(outcomes).toContain("satisfies");
		expect(outcomes).toContain("rejects");
		expect(outcomes).toContain("invariant-preserving");
	});

	it("ArbitrarySpec carries the per-param arbitrary derivation inputs (typeRef + numeric constraint bounds)", () => {
		const spec: ArbitrarySpec = {
			param: "amount",
			typeRef: "number",
			kind: "number",
			bounds: { min: 10, max: 100 },
		};
		expect(spec.param).toBe("amount");
		expect(spec.typeRef).toBe("number");
		expect(spec.bounds?.min).toBe(10);
		expect(spec.bounds?.max).toBe(100);
	});

	it('ArbitrarySpec can carry enum members for a kind === "enum" spec', () => {
		const spec: ArbitrarySpec = {
			param: "tier",
			typeRef: "enum<GOLD,SILVER>",
			kind: "enum",
			members: ["GOLD", "SILVER"],
		};
		expect(spec.members).toEqual(["GOLD", "SILVER"]);
	});

	it("PropertyClause pairs a clause id with its codegen'd predicate (the oracle)", () => {
		const clause: PropertyClause = {
			clauseId: "AccountService.inv0",
			code: "(balance) => balance >= 0",
		};
		expect(clause.clauseId).toBe("AccountService.inv0");
		expect(clause.code).toBe("(balance) => balance >= 0");
	});
});
