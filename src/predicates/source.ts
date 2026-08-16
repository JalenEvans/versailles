/**
 * Predicate source resolution (build-spec §3.4, §13 milestone 8) — traces a
 * `Module.functionName` sourceRef to a real exported function under the
 * source roots and derives its implementation hash. Reuses the extractor's
 * static-analysis seam (resolveExportedFunction) and the shared FNV-1a hash
 * seam (fnv1aHex) — this is NOT manifest derivation (manifest-extraction owns
 * that; contract limits) and nothing is ever invented (ADR-0005).
 */
import { fnv1aHex, resolveExportedFunction } from "../extractors/index.js";

/**
 * Parses a `Module.functionName` sourceRef. Module = file basename without
 * `.ts`; function = exported top-level function name. Exactly two dot-free
 * parts are required.
 */
export function parseSourceRef(
	sourceRef: string,
): { ok: true; moduleName: string; functionName: string } | { ok: false } {
	const parts = sourceRef.split(".");
	if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
		return { ok: false };
	}
	return { ok: true, moduleName: parts[0], functionName: parts[1] };
}

/**
 * sourceHash(predicate) = FNV-1a over the UTF-8 bytes of the function
 * declaration's source text exactly as the TS seam returns it
 * (node.getText(): `export`/`function` through the closing brace).
 */
export function computePredicateSourceHash(sourceText: string): string {
	return fnv1aHex(sourceText);
}

/**
 * Mechanically verifies a sourceRef under the given source roots: resolves
 * the exported function and returns the computed implementation hash, or
 * { ok: false } when the ref does not resolve.
 */
export function resolvePredicateSource(
	roots: string[],
	sourceRef: string,
): { ok: true; sourceHash: string } | { ok: false } {
	const parsed = parseSourceRef(sourceRef);
	if (!parsed.ok) {
		return { ok: false };
	}
	const resolved = resolveExportedFunction(
		roots,
		parsed.moduleName,
		parsed.functionName,
	);
	if (!resolved.ok) {
		return { ok: false };
	}
	return {
		ok: true,
		sourceHash: computePredicateSourceHash(resolved.sourceText),
	};
}
