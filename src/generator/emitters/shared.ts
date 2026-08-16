/**
 * Shared pure helpers for the emitter plugins (ADR-0008/0009): identifier
 * safety (Center W1), case-id → method/function name sanitization, the
 * per-component grouping the vitest emitter already applies, and the operation
 * name derivation from a case id (Center B1). Every emitter renders the same
 * framework-agnostic IR, so these helpers are identical across targets — the
 * language/framework-specific rendering lives in each emitter plugin.
 */
import type { OperationCaseGroup, PlannedCase, PlannedSuite } from "../ir.js";

/** Tool-owned generated output directory (config default, build-spec §9.4). */
export const DEFAULT_GENERATED_DIR = ".versailles/generated";

/**
 * Valid identifier (Center W1): component / operation names and input keys
 * flow raw into file paths, class names, method calls and object keys — the
 * emitter refuses to render anything that could break out of the generated
 * surface. Mirrors the vitest emitter's assertion so all three emitters apply
 * the same policy at the seam.
 */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function assertIdentifier(name: string, what: string): void {
	if (!IDENTIFIER_RE.test(name)) {
		throw new Error(
			`Refusing to emit: ${what} "${name}" is not a valid identifier (must match /^[A-Za-z_$][A-Za-z0-9_$]*$/)`,
		);
	}
}

/**
 * Case id → language method/function name: every non [A-Za-z0-9_] char is
 * replaced by `_` (e.g. "AccountService.withdraw.boundary-0" →
 * "AccountService_withdraw_boundary_0"). Names are unique per file because the
 * planner ids are unique and the only non-identifier separators collapse to
 * the same underscore.
 */
export function sanitizeId(id: string): string {
	return id.replace(/[^A-Za-z0-9_]/g, "_");
}

export type ComponentGroup = {
	operations: OperationCaseGroup[];
	invariantCases: PlannedCase[];
};

/** Groups the suite's cases per component (operations + §9.2 invariant cases). */
export function groupByComponent(
	suite: PlannedSuite,
): Record<string, ComponentGroup> {
	const groups: Record<string, ComponentGroup> = {};
	for (const group of suite.operations) {
		const entry = groups[group.component] ?? {
			operations: [],
			invariantCases: [],
		};
		entry.operations.push(group);
		groups[group.component] = entry;
	}
	for (const case_ of suite.invariantCases) {
		const component = case_.id.split(".")[0];
		const entry = groups[component] ?? { operations: [], invariantCases: [] };
		entry.invariantCases.push(case_);
		groups[component] = entry;
	}
	return groups;
}

/**
 * The operation name is the second segment of "<component>.<operation>.<kind>-<n>".
 * With the id format pinned by Center B1 the segment is always present — a
 * malformed id is a hard error, never masked by a fallback.
 */
export function operationOf(case_: PlannedCase): string {
	const parts = case_.id.split(".");
	if (parts.length < 2 || parts[1].length === 0) {
		throw new Error(
			`Cannot derive the operation name from case id "${case_.id}" — expected "<component>.<operation>.<kind>-<n>"`,
		);
	}
	return parts[1];
}
