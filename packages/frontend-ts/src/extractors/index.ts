/**
 * Manifest extractor module — public surface (build-spec §3.3, §7).
 *
 * `extractManifests` is SYNCHRONOUS and takes directory source roots (glob
 * expansion is a CLI concern) plus an optional projectRoot (the CLI's cwd)
 * that anchors covered entries' sourcePath project-root-relative
 * (VERSAILLES-24). Language-specific extraction lives behind the
 * ExtractorPlugin seam (ADR-0008), selected by config.language; the
 * TypeScript plugin is the v1 target (ADR-0009).
 */
import { computeSourceHash, fnv1aHex } from "./hash.js";
import { mergeManifests } from "./merge.js";
import type { ExtractorPlugin, ExtractorResult } from "./types.js";
import {
	ExtractorDependencyMissingError,
	resolveExportedFunction,
	typescriptExtractor,
} from "./typescript.js";
import type { ResolvedFunction } from "./typescript.js";

export { computeSourceHash, fnv1aHex } from "./hash.js";
export { mergeManifests } from "./merge.js";
export {
	ExtractorDependencyMissingError,
	resolveExportedFunction,
} from "./typescript.js";
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
} as const satisfies Record<string, ExtractorPlugin>;

/**
 * Plugin registry seam (ADR-0008): select the extractor by config.language.
 * Returns undefined for unregistered languages (csharp/python are sequenced
 * later per ADR-0009).
 */
export function getExtractorPlugin(
	language: string,
): ExtractorPlugin | undefined {
	return EXTRACTOR_PLUGINS[language as keyof typeof EXTRACTOR_PLUGINS];
}

/**
 * Synchronous manifest extraction for TypeScript source roots — the default
 * pipeline path, dispatched through the plugin seam.
 *
 * The public surface stays SYNCHRONOUS (VERSAILLES-190): the plugin's async
 * `extract` (dynamic `await import("typescript")`) is for await-capable
 * callers; `extractManifests` uses the plugin's synchronous extract path,
 * which lazy-loads the compiler API via createRequire and throws the
 * structured EXTRACTOR_DEPENDENCY_MISSING error when `typescript` is absent.
 *
 * @param sourceRoots Directory roots to scan (glob expansion is a CLI
 *   concern); files are scanned recursively under these roots only.
 * @param projectRoot Optional project root (the CLI's cwd). Anchors every
 *   covered entry's sourcePath to the PROJECT root with POSIX separators
 *   (VERSAILLES-24): a component at <projectRoot>/src/order.ts records
 *   "src/order.ts", never source-root-relative "order.ts" and never an
 *   absolute path — so the generator's join(cwd, sourcePath) resolves to the
 *   real file. When omitted, the extractor infers the project root as the
 *   common directory prefix of the source roots.
 */
export function extractManifests(
	sourceRoots: string[],
	projectRoot?: string,
): ExtractorResult {
	const plugin = getExtractorPlugin("typescript");
	if (plugin === undefined) {
		throw new Error("No extractor plugin registered for language 'typescript'");
	}
	return plugin.extractSync(sourceRoots, projectRoot);
}
