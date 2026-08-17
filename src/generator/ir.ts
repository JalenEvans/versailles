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
import type { LoaderWarning } from "../loader/workspace.js";

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
};

/** Maps every source clause ID → the test IDs tracing it (§9.3). */
export type CoverageManifest = { coverage: Record<string, string[]> };

/** Frameworks the emitter seam can dispatch to (ADR-0008/0009). */
export type EmitterFramework = "vitest" | "xunit" | "pytest";
