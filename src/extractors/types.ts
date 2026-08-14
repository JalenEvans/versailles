/**
 * Public types for the manifest extractor module.
 *
 * Grounding layer of the pipeline — manifests.json (build-spec §3.3, §7;
 * docs/specs/manifest-extraction.md; docs/contracts/manifest-extraction.contract.yaml).
 */

/** Per-field / per-entry confidence. Low = the type could only be inferred. */
export type Confidence = "high" | "low";

/** A single manifest field: name, typeRef-grammar type, extraction confidence. */
export type FieldEntry = {
	name: string;
	typeRef: string;
	confidence: "high" | "low";
};

/** A flat manifest entry for one component (class or interface). */
export type ManifestEntry = {
	component: string;
	fields: FieldEntry[];
	sourceHash: string;
	sourcePath: string;
	confidence: "high" | "low";
};

/** Flat component → entry map; nested/related types live in the same map. */
export type ManifestMap = Record<string, ManifestEntry>;

/** Non-blocking extraction warning (ADR-0004). */
export type ExtractorWarning = {
	code: string;
	component: string;
	field: string;
	detail: string;
};

/** Result of one extraction run: manifests plus non-blocking warnings. */
export type ExtractorResult = {
	manifests: ManifestMap;
	warnings: ExtractorWarning[];
};

/**
 * Extractor plugin seam (ADR-0008): one plugin per source language, selected
 * by config.language. All language-specific extraction lives behind this
 * interface — the core never forks per language.
 */
export interface ExtractorPlugin {
	readonly language: "typescript" | "csharp" | "python";
	extract(sourceRoots: string[]): ExtractorResult;
}
