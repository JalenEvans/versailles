/**
 * The deterministic generator core (build-spec §9, ADR-0002/0007/0008) —
 * public module surface.
 *
 * planTestCases is a pure function from a validated VersaillesContext to a
 * framework-agnostic PlannedSuite IR. coverageManifest maps every source
 * clause ID → the generated test IDs tracing it (§9.3). emitSuite dispatches
 * on the target framework through the emitter plugin seam (§9.4) across the
 * full v1 matrix (vitest | xunit | pytest, ADR-0009); an unknown framework is
 * rejected at the seam.
 */
import { emitPytest } from "./emitters/pytest.js";
import { emitVitest } from "./emitters/vitest.js";
import { emitXunit } from "./emitters/xunit.js";
import type {
	EmitOptions,
	EmittedFile,
	EmitterFramework,
	PlannedSuite,
} from "./ir.js";
import { coverageManifest, planTestCases } from "./planner.js";

export { planTestCases, coverageManifest };

/**
 * Renders a planned suite into full-file output for the target framework.
 * Dispatches across the v1 emitter matrix (vitest | xunit | pytest, ADR-0009);
 * an unknown framework is rejected at the emitter seam (ADR-0008/0009) rather
 * than silently producing wrong output. `options` lets callers override the
 * generated output directory and the per-component module import specifiers
 * (defaults stay backward-compatible: ".versailles/generated/" +
 * "../../src/<Component>.js" for vitest, and the per-framework component
 * namespace for xunit/pytest).
 */
export function emitSuite(
	suite: PlannedSuite,
	framework: EmitterFramework,
	options?: EmitOptions,
): EmittedFile[] {
	switch (framework) {
		case "vitest":
			return emitVitest(suite, options);
		case "xunit":
			return emitXunit(suite, options);
		case "pytest":
			return emitPytest(suite, options);
		default:
			throw new Error(
				`Emitter for framework "${framework}" is not implemented (v1 ships vitest, xunit, and pytest)`,
			);
	}
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
