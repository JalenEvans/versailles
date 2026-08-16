/**
 * Predicate registry core (build-spec §3.4, §13 milestone 8,
 * docs/contracts/predicate-registry.contract.yaml) — pure registry data
 * logic: predicate-name validation against the §4.1 IDENT rule, the §3.4
 * entry shape, and the purity-check reminder listing. Framework-agnostic:
 * no CLI surface, no file IO, no TS static analysis (that lives in
 * src/predicates/source.ts through the extractor seam). verifiedPure is a
 * human-only gate (ADR-0006, build-spec §14 default) — no code path here
 * ever auto-sets it.
 */

/** The build-spec §3.4 schema for one registered predicate. */
export type PredicateEntry = {
	params: string[];
	paramTypes: string[];
	returnType: string;
	sourceRef: string;
	sourceHash: string;
	verifiedPure: boolean;
};

/**
 * Reserved keywords of the contract expression grammar (build-spec §4.1)
 * that cannot be predicate names: the boolean/and/or/not operators, the
 * null literal, `in`, and the `old()` reference form.
 */
const RESERVED_KEYWORDS = new Set([
	"or",
	"and",
	"not",
	"in",
	"true",
	"false",
	"null",
	"old",
]);

/**
 * predicate_call IDENT validation (build-spec §4.1): /^[A-Za-z_][A-Za-z0-9_]*$/
 * and not a reserved keyword.
 */
export function isValidPredicateName(name: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED_KEYWORDS.has(name);
}

/**
 * The purity-check reminder (build-spec §13 milestone 8): every entry with
 * verifiedPure missing or false, each with its sourceRef, sorted by name
 * (ADR-0002 determinism). Only reports — never writes (ADR-0006).
 */
export function listUnverified(
	predicates: Record<string, PredicateEntry>,
): { name: string; sourceRef: string }[] {
	const unverified: { name: string; sourceRef: string }[] = [];
	for (const [name, entry] of Object.entries(predicates)) {
		if (entry.verifiedPure !== true) {
			unverified.push({ name, sourceRef: entry.sourceRef });
		}
	}
	return unverified.sort((a, b) => a.name.localeCompare(b.name));
}
