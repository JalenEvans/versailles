/**
 * Manifest extractor module — public surface (build-spec §3.3, §7).
 *
 * `extractManifests` is SYNCHRONOUS and takes directory source roots (glob
 * expansion is a CLI concern). Language-specific extraction lives behind the
 * ExtractorPlugin seam (ADR-0008), selected by config.language; the
 * TypeScript plugin is the v1 target (ADR-0009).
 */
import { computeSourceHash, fnv1aHex } from "./hash.js";
import { mergeManifests } from "./merge.js";
import type { ExtractorResult } from "./types.js";
import { resolveExportedFunction, typescriptExtractor } from "./typescript.js";
import type { ResolvedFunction } from "./typescript.js";

export { computeSourceHash, fnv1aHex } from "./hash.js";
export { mergeManifests } from "./merge.js";
export { resolveExportedFunction } from "./typescript.js";
export type { ResolvedFunction } from "./typescript.js";
export type {
	Confidence,
	ExtractorPlugin,
	ExtractorResult,
	ExtractorWarning,
	FieldEntry,
	ManifestEntry,
	ManifestMap,
} from "./types.js";

const EXTRACTOR_PLUGINS = {
	typescript: typescriptExtractor,
} as const satisfies Record<
	string,
	{ language: string; extract: (sourceRoots: string[]) => ExtractorResult }
>;

/**
 * Plugin registry seam (ADR-0008): select the extractor by config.language.
 * Returns undefined for unregistered languages (csharp/python are sequenced
 * later per ADR-0009).
 */
export function getExtractorPlugin(
	language: string,
): (typeof EXTRACTOR_PLUGINS)[keyof typeof EXTRACTOR_PLUGINS] | undefined {
	return EXTRACTOR_PLUGINS[language as keyof typeof EXTRACTOR_PLUGINS];
}

/**
 * Synchronous manifest extraction for TypeScript source roots — the default
 * pipeline path, dispatched through the plugin seam.
 */
export function extractManifests(sourceRoots: string[]): ExtractorResult {
	const plugin = getExtractorPlugin("typescript");
	if (plugin === undefined) {
		throw new Error("No extractor plugin registered for language 'typescript'");
	}
	return plugin.extract(sourceRoots);
}
