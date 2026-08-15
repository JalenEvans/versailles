/**
 * The deterministic generator core (build-spec §9, ADR-0002/0007/0008) —
 * public module surface.
 *
 * planTestCases is a pure function from a validated VersaillesContext to a
 * framework-agnostic PlannedSuite IR. coverageManifest maps every source
 * clause ID → the generated test IDs tracing it (§9.3). emitSuite dispatches
 * on the target framework through the emitter plugin seam (§9.4); vitest is
 * the only v1 emitter — xunit/pytest throw at the seam.
 */
import { emitVitest } from "./emitters/vitest.js";
import type { EmitOptions, EmittedFile, PlannedSuite } from "./ir.js";
import { coverageManifest, planTestCases } from "./planner.js";

export { planTestCases, coverageManifest };

/**
 * Renders a planned suite into full-file output for the target framework.
 * Only "vitest" is implemented in v1; any other framework is rejected at the
 * emitter seam (ADR-0008/0009) rather than silently producing wrong output.
 * `options` lets callers override the generated output directory and the
 * per-component module import specifiers (defaults stay backward-compatible:
 * ".versailles/generated/" + "../../src/<Component>.js").
 */
export function emitSuite(
	suite: PlannedSuite,
	framework: "vitest",
	options?: EmitOptions,
): EmittedFile[] {
	if (framework === "vitest") {
		return emitVitest(suite, options);
	}
	throw new Error(
		`Emitter for framework "${framework}" is not implemented (v1 ships vitest only)`,
	);
}

export type {
	AssertionDescriptor,
	CaseKind,
	CoverageManifest,
	EmitOptions,
	EmittedFile,
	EmitterFramework,
	ExpectedOutcome,
	OperationCaseGroup,
	PlannedCase,
	PlannedSuite,
} from "./ir.js";
