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
import type { EmittedFile, PlannedSuite } from "./ir.js";
import { coverageManifest, planTestCases } from "./planner.js";

export { planTestCases, coverageManifest };

/**
 * Renders a planned suite into full-file output for the target framework.
 * Only "vitest" is implemented in v1; any other framework is rejected at the
 * emitter seam (ADR-0008/0009) rather than silently producing wrong output.
 */
export function emitSuite(
	suite: PlannedSuite,
	framework: "vitest",
): EmittedFile[] {
	if (framework === "vitest") {
		return emitVitest(suite);
	}
	throw new Error(
		`Emitter for framework "${framework}" is not implemented (v1 ships vitest only)`,
	);
}

export type {
	CaseKind,
	CoverageManifest,
	EmittedFile,
	EmitterFramework,
	ExpectedOutcome,
	OperationCaseGroup,
	PlannedCase,
	PlannedSuite,
} from "./ir.js";
