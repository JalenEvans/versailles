/**
 * Structural sourceHash computation (build-spec §7, contract operation
 * compute_source_hash): FNV-1a digest over the SORTED (fieldName, typeRef)
 * pairs PLUS the sorted method-signature records (method name, static flag,
 * ordered param names, return type where determinable) — never the full
 * source file, never per-field confidence, and never method bodies.
 *
 * Body-only edits (method bodies) never change the hash; adding, removing, or
 * retyping a field, or adding/removing/changing a method signature (name,
 * static/instance, params, return type), always does. Serialization is
 * unambiguous: each record is `name<US>typeRef` (fields) or
 * `name<US>static<US>param1,param2<US>returnType` (methods), records are
 * joined with NUL, and the method group is empty when methods is `{}` — so a
 * component with no methods hashes byte-identically to the legacy fields-only
 * behavior (the second argument defaults to `{}`). Neither byte can appear in
 * a TypeScript identifier. The empty field set still yields a defined,
 * non-empty hash so empty components are comparable.
 *
 * fnv1aHex is the shared hash seam (predicate-registry reuses it for the
 * function-implementation hash without becoming manifest derivation).
 */
import type { FieldEntry, MethodMetadata } from "./types.js";

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

export function computeSourceHash(
	fields: FieldEntry[],
	methods: Record<string, MethodMetadata> = {},
): string {
	const fieldPairs = [...fields]
		.map((field) => `${field.name}\x1f${field.typeRef}`)
		.sort();

	// Signature record per method: name, static flag, ordered params, and the
	// return type ONLY when present (absent and "void" must stay distinct).
	const methodRecords = Object.entries(methods)
		.map(([name, method]) => {
			const parts = [name, String(method.static), method.params.join(",")];
			if (method.returnType !== undefined) {
				parts.push(method.returnType);
			}
			return parts.join("\x1f");
		})
		.sort();

	const serialized = [...fieldPairs, ...methodRecords].join("\x00");
	return fnv1aHex(serialized);
}
