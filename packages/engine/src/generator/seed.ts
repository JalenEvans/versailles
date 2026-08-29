/**
 * Seeded property-based test emission — seed derivation (ADR-0017).
 *
 * derivePropertySeed is a pure function from the FULL ordered source
 * clause-id set plus the grammar version to a SIGNED 32-bit seed for
 * fast-check's `fc.assert(prop, { seed })`. Generation stays a pure function
 * of a validated VersaillesContext (ADR-0002, re-scoped to generation-time
 * only) while the emitted test is reproducible run-to-run.
 *
 * The seed is a DERIVED literal, never random, never time-based. The clause-id
 * stream is NOT sorted before hashing: reordering clauses is a real contract
 * edit, so it must reshuffle the exploration space (ADR-0017 consequence).
 * The empty clause set still yields a defined, deterministic seed.
 *
 * Returns an int32 (NOT uint32): fast-check's runner coerces the printed seed
 * with `seed | 0` (readSeed: `const seed32 = p.seed | 0`), so a uint32 literal
 * like 4294967295 would silently become -1 at run time and NOT reproduce. An
 * int32 round-trips exactly (`seed | 0 === seed`).
 */
import { fnv1aHex } from "../../../frontend-ts/src/extractors/hash.js";

/** Separates clause ids inside the hash input. */
const CLAUSE_ID_SEPARATOR = "\x1f";
/** Separates the clause-id group from the grammar version. */
const GROUP_SEPARATOR = "\x00";

export function derivePropertySeed(
	clauseIds: readonly string[],
	grammarVersion: string,
): number {
	// `clauseIds.join` preserves order (never sorted) and never mutates the
	// caller's array. Neither separator byte can appear in a clause id (a
	// dotted TypeScript identifier) or a grammar version, so the serialization
	// is unambiguous and the version is always delimited from the clause group.
	const serialized = `${clauseIds.join(CLAUSE_ID_SEPARATOR)}${GROUP_SEPARATOR}${grammarVersion}`;
	return Number.parseInt(fnv1aHex(serialized), 16) | 0;
}
