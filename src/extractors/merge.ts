/**
 * Pure manifest merge (build-spec §7 extract-manifests semantics):
 * covered entries are updated to reflect the fresh extraction, uncovered
 * entries are preserved unless the caller explicitly prunes — removal is
 * never implicit. Returns a NEW map and never mutates either input.
 */
import type { ManifestMap } from "./types.js";

export function mergeManifests(
	existing: ManifestMap,
	extracted: ManifestMap,
	options: { prune: boolean },
): ManifestMap {
	const merged: ManifestMap = {};

	for (const key of Object.keys(extracted)) {
		merged[key] = extracted[key];
	}

	if (!options.prune) {
		for (const key of Object.keys(existing)) {
			if (!(key in merged)) {
				merged[key] = existing[key];
			}
		}
	}

	return merged;
}
