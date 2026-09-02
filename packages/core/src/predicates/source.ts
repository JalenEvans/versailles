/**
 * Predicate source resolution (build-spec §3.4, §13 milestone 8) — traces a
 * `Module.functionName` sourceRef to a real exported function under the
 * source roots. Reuses the extractor's static-analysis seam
 * (resolveExportedFunction) — this is NOT manifest derivation
 * (manifest-extraction owns that; contract limits) and nothing is ever
 * invented (ADR-0005).
 *
 * ADR-0013/0019: the per-predicate sourceHash is dropped (the declaration no
 * longer carries it and no hash is computed) — resolution only confirms the
 * exported function exists.
 */
import { resolveExportedFunction } from "../../../frontend-ts/src/extractors/index.js";

/**
 * Parses a `Module.functionName` sourceRef. Module = file basename without
 * `.ts`; function = exported top-level function name. Exactly two dot-free
 * parts are required. Module-private: only `resolvePredicateSource` uses it.
 */
function parseSourceRef(
	sourceRef: string,
): { ok: true; moduleName: string; functionName: string } | { ok: false } {
	const parts = sourceRef.split(".");
	if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
		return { ok: false };
	}
	return { ok: true, moduleName: parts[0], functionName: parts[1] };
}

/**
 * Mechanically verifies a sourceRef under the given source roots: resolves
 * the exported function, or { ok: false } when the ref does not resolve.
 * ADR-0019: existence/shape is the attestation — no sourceHash is computed.
 */
export function resolvePredicateSource(
	roots: string[],
	sourceRef: string,
): { ok: true } | { ok: false } {
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
	return { ok: true };
}
