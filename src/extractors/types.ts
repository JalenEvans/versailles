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

/**
 * Method metadata for one resolvable method (build-spec §7,
 * manifest-extraction.contract.yaml 2026-08-17): the signature record that
 * powers shape-aware emitter calls. returnType is present only where
 * determinable under the permissive policy (ADR-0004) — an unresolvable
 * signature is recorded without it, never dropped and never a hard error.
 */
export type MethodMetadata = {
	/** true for static methods; interface signatures are always instance. */
	static: boolean;
	/** Parameter names in DECLARED order. */
	params: string[];
	/** typeRef-grammar return type where determinable (void/number/...). */
	returnType?: string;
};

/** A flat manifest entry for one component (class or interface). */
export type ManifestEntry = {
	component: string;
	fields: FieldEntry[];
	/** Per-method signature metadata; `{}` when the component has no methods. */
	methods: Record<string, MethodMetadata>;
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
	/**
	 * @param sourceRoots Directory roots to scan (glob expansion is a CLI
	 *   concern). Files are scanned recursively under these roots only.
	 * @param projectRoot Optional project root (the CLI's cwd) anchoring
	 *   sourcePath values project-root-relative (VERSAILLES-24). When omitted
	 *   the plugin infers it from the source roots' common directory prefix.
	 */
	extract(sourceRoots: string[], projectRoot?: string): ExtractorResult;
}
