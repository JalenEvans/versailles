/**
 * The framework-agnostic test-case IR for the deterministic generator core
 * (build-spec §9, docs/specs/deterministic-generation.md, ADR-0002/0007/0008).
 *
 * The IR is the boundary contract between the planner (a pure function of a
 * validated VersaillesContext) and the emitter plugins (a pure function of the
 * IR). No framework strings live here — only the rejection idiom NAME
 * passthrough (ADR-0007), which emitters translate into real assertion syntax.
 *
 * PlannedSuite.warnings is a suite-level planning warning channel
 * (VERSAILLES-22 F3, deterministic-generation.contract.yaml): a predicate-call
 * precondition the planner genuinely cannot falsify surfaces a non-silent
 * PREDICATE_UNPLANNABLE warning here instead of silently emitting zero cases.
 * Same { code, field, detail } shape as LoaderWarning (ADR-0004 tier) — the
 * generate handler merges these into CliResult.warnings (non-blocking, exit 0).
 * Emitters ignore the field entirely.
 */
import type { LoaderWarning } from "../../../core/src/loader/workspace.js";
import type { StrategyMap } from "./strategy.js";

/** §9.1–§9.2 case kinds. */
export type CaseKind =
	| "boundary"
	| "partition"
	| "precondition-violation"
	| "postcondition-satisfaction"
	| "invariant"
	| "expected-rejection";

export type ExpectedOutcome = "accept" | "reject";

/**
 * A renderable assertion on the call result's subject field, derived from a
 * simple `field op literal` contract expression (e.g. the invariant
 * `balance >= 0`). The emitter translates `op` into a real vitest matcher
 * (`expect(result.balance).toBeGreaterThanOrEqual(0)`) so generated invariant
 * cases assert the subject field instead of a degenerate `toBeDefined()`.
 */
export type AssertionDescriptor = {
	/** Result field to assert (the expression's subject). */
	subject: string;
	/** Comparison operator against the literal. */
	op: ">=" | ">" | "<=" | "<" | "==" | "!=";
	/** The value compared against. */
	literal: unknown;
};

/**
 * A single planned test case. `inputs` carries the call arguments (param name
 * → value) PLUS the captured pre-call component state (manifest field name →
 * value) so the emitter can resolve `old(field)` and build the pre-state.
 */
export type PlannedCase = {
	/** Unique id, "<component>.<operation>.<kind>-<n>". */
	id: string;
	kind: CaseKind;
	/** Non-empty, embedded in the rendered test name. */
	description: string;
	inputs: Record<string, unknown>;
	expects: {
		outcome: ExpectedOutcome;
		/** Present on every reject case; read from config, default "throws". */
		rejectionIdiom?: string;
		/** Postcondition clause IDs a satisfaction/invariant case asserts. */
		postconditions?: string[];
		/**
		 * Real matcher assertions on the call result (§9.1/§9.2). The planner
		 * fills these from simple `field op literal` contract expressions so
		 * the emitter never reduces an invariant/postcondition check to a bare
		 * `expect(op(inputs)).toBeDefined()`.
		 */
		assertions?: AssertionDescriptor[];
	};
	/** Contract clause IDs the case covers (§9.3). */
	traces: string[];
};

/** §9.1 cases grouped per operation. */
export type OperationCaseGroup = {
	component: string;
	operation: string;
	cases: PlannedCase[];
};

/**
 * A planned suite. `clauseIds` carries the FULL source clause set so the
 * coverage manifest can expose zero-coverage clauses as empty arrays.
 * `warnings` (VERSAILLES-22 F3) carries non-blocking planning warnings — e.g.
 * PREDICATE_UNPLANNABLE for a predicate-call precondition the planner cannot
 * falsify — so a coverage gap is never silent. The generate handler merges
 * these into CliResult.warnings (same ADR-0004 tier as validationWarnings).
 */
export type PlannedSuite = {
	operations: OperationCaseGroup[];
	/** §9.2 invariant + expected-rejection cases. */
	invariantCases: PlannedCase[];
	clauseIds: string[];
	/**
	 * Suite-level planning warnings ({ code, field, detail } — the
	 * LoaderWarning shape). Absent/empty when planning is fully plannable.
	 */
	warnings?: LoaderWarning[];
};

/** A full-file output unit — ready for idempotent full-file regeneration. */
export type EmittedFile = { path: string; content: string };

/** Output configuration for emitSuite (Center W4). */
export type EmitOptions = {
	/** Overrides the default ".versailles/generated" output directory. */
	generatedDir?: string;
	/** Per-component import specifier overrides (component → module path). */
	modulePaths?: Record<string, string>;
	/**
	 * Per-component method metadata (component → method name → signature),
	 * threaded through the emitter seam exactly like modulePaths
	 * (VERSAILLES-20 F1, deterministic-generation.contract.yaml §9.4). When
	 * present for a component+operation the emitter renders shape-aware
	 * calls: instance → `new <Component>().<op>(<positional>)`, static →
	 * `<Component>.<op>(<positional>)`, params in declared order, and
	 * void-return accept cases carry no return-value assertion. When absent
	 * (legacy) the emitter keeps today's static options-object call with a
	 * toBeDefined assertion — byte-identical to pre-metadata output.
	 */
	methods?: Record<
		string,
		Record<string, { static: boolean; params: string[]; returnType?: string }>
	>;
	/**
	 * The property-block plan (ADR-0017, build-spec §9.6) computed by
	 * planPropertyBlocks(suite, context) in the generate pipeline. Absent or
	 * empty (config.propertyBased.enabled false) ⇒ the emitter renders nothing
	 * new — byte-identical to v1 output. Only the vitest emitter reads it;
	 * xunit/pytest ignore it (vitest + fast-check first, ADR-0017).
	 */
	propertyPlan?: PropertyPlan;
	/**
	 * config.propertyBased.numRuns threaded into every `fc.assert(prop, {
	 * seed, numRuns })` call. PropertyPlan does not carry it (Phase 4 pinned
	 * the plan shape), so it flows like rejection idiom / methods / modulePaths.
	 * Default 100 when absent (build-spec §9.6).
	 */
	propertyNumRuns?: number;
	/**
	 * The predicate import table (predicate name → module import specifier)
	 * threaded through the emitter seam exactly like modulePaths / methods
	 * (ADR-0017 GAP 2, build-spec §9.6). Derived by the generate handler from
	 * contracts.json's `predicates` map: a `<Module>.<function>` sourceRef
	 * resolves to the module path used for that component (co-located
	 * predicates → the component's own import path, respecting modulePaths
	 * overrides), a path-like source resolves verbatim. The vitest emitter
	 * imports every predicate a component's property clauses reference, after
	 * the component import and before the fast-check import; xunit/pytest
	 * ignore the field entirely.
	 */
	predicates?: Record<string, string>;
};

/** Maps every source clause ID → the test IDs tracing it (§9.3). */
export type CoverageManifest = { coverage: Record<string, string[]> };

/** Frameworks the emitter seam can dispatch to (ADR-0008/0009). */
export type EmitterFramework = "vitest" | "xunit" | "pytest";

// ── PBT IR (ADR-0017) ────────────────────────────────────────────────────────
//
// The property-based test IR: everything a property block needs to plan and
// emit, mirroring the PlannedCase conventions above (<component>.<operation>
// ids, ADR-0007 rejectionIdiom passthrough, §9.3 traces). Like the rest of the
// IR it is framework-agnostic — no framework strings, only the rejection idiom
// NAME passthrough that emitters translate into real assertion syntax.

/** The three planned property outcomes (ADR-0017). */
export type PropertyOutcome = "satisfies" | "rejects" | "invariant-preserving";

/**
 * Per-param arbitrary derivation inputs. `kind` selects the fast-check
 * arbitrary the emitter renders (number → fc.integer within `bounds` when
 * present, enum → fc.constantFrom over `members`, ...), `typeRef` carries the
 * raw source type reference for type-level mapping.
 */
export type ArbitrarySpec = {
	/** Operation param name. */
	param: string;
	/** Raw typeRef from ContractOperation.params[].type. */
	typeRef: string;
	kind: "number" | "string" | "boolean" | "enum";
	/** Numeric constraint bounds (planner-derived). */
	bounds?: { min: number; max: number };
	/** Enum members, when kind === "enum". */
	members?: unknown[];
	/**
	 * Deterministic default for container-typed params (ADR-0017): `[]` for a
	 * `list<X>` param, the inner type's default for an `optional<X>` param.
	 * The emitter renders a constant/default arbitrary for these.
	 */
	default?: unknown;
};

/** A codegen'd clause predicate — the oracle — paired with its source clause id. */
export type PropertyClause = {
	/** Source clause id — the coverage trace key (§9.3). */
	clauseId: string;
	/** Codegen'd predicate text (the oracle). */
	code: string;
};

/**
 * A planned property block. `params` carries the per-param arbitrary
 * derivation inputs, `clauses` the codegen'd clause predicates (the oracle),
 * `outcome` the expected result, `rejectionIdiom` the ADR-0007 passthrough on
 * rejects, and `traces` the clause ids for coverage mapping (§9.3).
 */
export type PropertyDescriptor = {
	/** Unique id, "<component>.<operation>.property-<kind>-<n>". */
	id: string;
	component: string;
	operation: string;
	params: ArbitrarySpec[];
	clauses: PropertyClause[];
	outcome: PropertyOutcome;
	/** ADR-0007 passthrough on rejects; read from config, default "throws". */
	rejectionIdiom?: string;
	/** Clause ids for coverage mapping (§9.3). */
	traces: string[];
	/**
	 * The reproducible fast-check seed literal the emitter passes to
	 * `fc.assert(prop, { seed, numRuns })` (ADR-0017): the explicit
	 * config.propertyBased.seed override, or the seed derived per-block from
	 * the descriptor's own covered clause ids + the grammar version
	 * (derivePropertySeed). Always a signed int32 (fast-check's `seed | 0`
	 * round-trip).
	 */
	seed: number;
};

/**
 * The property-block planning output (ADR-0017 build-spec §9.6): the planned
 * property descriptors (additive to the concrete cases — never planned when
 * config.propertyBased.enabled is false), the per-source-clause strategy
 * record (a total coverage map over suite.clauseIds), and the non-silent
 * unplannable-clause warnings (the same { code, field, detail } LoaderWarning
 * tier as PREDICATE_UNPLANNABLE, ADR-0004 — non-blocking, exit 0).
 */
export type PropertyPlan = {
	descriptors: PropertyDescriptor[];
	strategies: StrategyMap;
	warnings: LoaderWarning[];
};
