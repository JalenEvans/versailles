/**
 * Shared oracle-parameter parsing (ADR-0020): the ONE canonical implementation
 * of `oracleParamsOf` used by both the property-block planner
 * (property-planning.ts) and the vitest emitter (emitters/vitest.ts). The
 * function was previously duplicated byte-identically in planner.ts and
 * emitters/vitest.ts; the split consolidates it here so every consumer parses
 * the codegen'd `(<params>) => <expr>` head the same way.
 */

/**
 * Parses the codegen'd clause predicate's parameter list from its byte-pinned
 * `(<params>) => <expr>` form — the SAME parsing the vitest emitter's
 * oracleParamsOf applies to the GAP-3 guard set. codegen.ts output never
 * mangles the head — split at the first `) => `, then the params on ", ".
 * A guard oracle with >1 callback params can never be an arbitrary
 * `.filter(...)` (fast-check filter passes exactly ONE value), so the planner
 * uses this count to mark multi-param-oracle operations PROPERTY_UNPLANNABLE.
 */
export function oracleParamsOf(code: string): string[] {
	const arrow = code.indexOf(") => ");
	if (arrow === -1) {
		return [];
	}
	const head = code.slice(1, arrow);
	if (head.trim() === "") {
		return [];
	}
	return head.split(", ").map((param) => param.trim());
}
