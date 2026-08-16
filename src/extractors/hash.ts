/**
 * Structural sourceHash computation (build-spec §7, contract operation
 * compute_source_hash): FNV-1a digest over the SORTED (fieldName, typeRef)
 * pairs only — never the full source file, never per-field confidence.
 *
 * Body-only edits (method bodies) never change the hash; adding, removing, or
 * retyping a field always does. Serialization is unambiguous: each pair is
 * `name<US>typeRef` (US = unit separator) and pairs are joined with NUL —
 * neither byte can appear in a TypeScript identifier. The empty field set
 * still yields a defined, non-empty hash so empty components are comparable.
 *
 * fnv1aHex is the shared hash seam (predicate-registry reuses it for the
 * function-implementation hash without becoming manifest derivation).
 */
import type { FieldEntry } from "./types.js";

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a digest over the UTF-8 bytes of a string, 8 lowercase hex chars —
 * the exact algorithm pinned by build-spec §7/§3.4 and the predicate-registry
 * contract (offset basis 0x811c9dc5, prime 0x01000193). Non-empty even for
 * the empty input.
 */
export function fnv1aHex(input: string): string {
	let hash = FNV_OFFSET_BASIS >>> 0;
	for (const byte of Buffer.from(input, "utf8")) {
		hash ^= byte;
		hash = Math.imul(hash, FNV_PRIME) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

export function computeSourceHash(fields: FieldEntry[]): string {
	const serialized = [...fields]
		.map((field) => `${field.name}\x1f${field.typeRef}`)
		.sort()
		.join("\x00");

	return fnv1aHex(serialized);
}
