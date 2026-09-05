/**
 * extract-manifests handler (build-spec §7, §12) — runs the manifest
 * extractor over config.sourceRoots and merges the result into
 * manifests.json: covered components are updated, uncovered components are
 * preserved unless --prune is passed (removal is never implicit).
 *
 * Output buckets (sorted for deterministic JSON, ADR-0002):
 *   updated   = components covered by the fresh extraction (added OR refreshed)
 *   preserved = components in the previous manifests.json the extraction did
 *               not cover, kept because --prune was not passed
 *   pruned    = components in the previous manifests.json the extraction did
 *               not cover, REMOVED because --prune was passed
 *
 * VERSAILLES-171: the workspace gate (requireValidWorkspace) runs first; its
 * failure-path output is the standardized {} (extract previously returned no
 * output key on invalid/config-null workspaces).
 */
import { join } from "node:path";

import {
	ExtractorDependencyMissingError,
	extractManifests,
	mergeManifests,
} from "../../../../frontend-ts/src/extractors/index.js";
import type {
	ExtractorResult,
	ManifestMap,
} from "../../../../frontend-ts/src/extractors/types.js";
import {
	expandSourceRoots,
	extractorWarnings,
	requireValidWorkspace,
	sourceRootsGuard,
	writeJsonFile,
} from "../context.js";
import type { CliResult } from "../types.js";

export async function handleExtractManifests(
	cwd: string,
	prune: boolean,
): Promise<CliResult> {
	const guard = await requireValidWorkspace(cwd);
	if (!guard.ok) {
		return guard.result;
	}
	const { context } = guard;
	const workspaceDir = join(cwd, ".versailles");

	const roots = expandSourceRoots(context.config.sourceRoots ?? [], cwd);
	const stored = context.manifests?.manifests ?? {};

	// Center W2: zero resolved roots with a non-empty store means the scan
	// covered nothing — with --prune the merge would silently delete every
	// stored entry. Refuse and leave manifests.json byte-identical.
	const zeroRoots = sourceRootsGuard(roots, stored);
	if (zeroRoots !== null) {
		return zeroRoots;
	}

	// The CLI's cwd is the PROJECT root (the dir containing .versailles/):
	// sourcePath values are anchored project-root-relative so the generator's
	// join(cwd, sourcePath) resolves to the real file (VERSAILLES-24).
	//
	// VERSAILLES-191 W1: the designed extractor dependency error must survive
	// the handler boundary as its own code (EXTRACTOR_DEPENDENCY_MISSING) —
	// never the generic INTERNAL mask from runCli's catch. Everything else
	// rethrows to that last-resort catch.
	let extracted: ExtractorResult;
	try {
		extracted = extractManifests(roots, cwd);
	} catch (error) {
		if (error instanceof ExtractorDependencyMissingError) {
			return {
				ok: false,
				errors: [{ code: error.code, detail: error.detail }],
				warnings: [],
				exitCode: 1,
				output: {},
			};
		}
		throw error;
	}
	const warnings = extractorWarnings(extracted.warnings);

	// The loader store format ({ sourceHash, fields: Record, sourcePath?,
	// methods? }) differs from the extractor ManifestMap ({ fields:
	// FieldEntry[], methods, sourcePath, confidence }); convert the stored
	// manifests so mergeManifests can operate on one shape. sourcePath and
	// methods are carried through from the store (VERSAILLES-21 F2 /
	// VERSAILLES-20 F1): a preserved legacy entry without them converts to ""
	// / {} internally and is omitted from the store write — never an invented
	// or empty persisted path.
	//
	// ADR-0021: per-field access/readonly (fieldAccess/fieldReadonly) flow
	// through the same conversion. Preserved entries that carry the keys in
	// the store surface them on their FieldEntry objects (defaulting to
	// public / not-readonly internally for the required shape), and the store
	// write round-trips the exact stored keys back for preserved entries —
	// never inventing them where the store lacked them. Covered entries always
	// write fresh fieldAccess/fieldReadonly from the extractor.
	const existing: ManifestMap = {};
	const existingAccess: Record<
		string,
		{
			fieldAccess?: Record<string, string>;
			fieldReadonly?: Record<string, boolean>;
		}
	> = {};
	for (const [component, entry] of Object.entries(stored)) {
		const storedAccess = entry.fieldAccess as
			| Record<string, string>
			| undefined;
		const storedReadonly = entry.fieldReadonly as
			| Record<string, boolean>
			| undefined;
		existing[component] = {
			component,
			fields: Object.entries(entry.fields).map(([name, typeRef]) => ({
				name,
				typeRef,
				confidence: "high",
				// ADR-0021 permissive default (internal shape requires the
				// fields): absent store access → "public", absent readonly →
				// false. The loader/emitter owns the real permissive default
				// for legacy entries; the store write below omits the keys for
				// preserved entries that never carried them.
				access:
					(storedAccess?.[name] as
						| "public"
						| "protected"
						| "private"
						| undefined) ?? "public",
				readonly: storedReadonly?.[name] ?? false,
			})),
			methods: entry.methods ?? {},
			sourceHash: entry.sourceHash,
			sourcePath: entry.sourcePath ?? "",
			confidence: "high",
		};
		// Preserve the exact stored access keys so the store write can
		// round-trip them byte-for-byte on preserved entries (never invented).
		if (entry.fieldAccess !== undefined || entry.fieldReadonly !== undefined) {
			existingAccess[component] = {
				fieldAccess: entry.fieldAccess as Record<string, string> | undefined,
				fieldReadonly: entry.fieldReadonly as
					| Record<string, boolean>
					| undefined,
			};
		}
	}

	const merged = mergeManifests(existing, extracted.manifests, { prune });

	// Output buckets derived from the input sets (sorted for determinism).
	const updated = Object.keys(extracted.manifests).sort();
	const preserved: string[] = [];
	const pruned: string[] = [];
	for (const component of Object.keys(existing)) {
		if (component in extracted.manifests) {
			continue;
		}
		if (prune) {
			pruned.push(component);
		} else {
			preserved.push(component);
		}
	}
	preserved.sort();
	pruned.sort();

	const mergedStore: Record<
		string,
		{
			sourceHash: string;
			fields: Record<string, string>;
			sourcePath?: string;
			methods?: Record<
				string,
				{ static: boolean; params: string[]; returnType?: string }
			>;
			fieldAccess?: Record<string, string>;
			fieldReadonly?: Record<string, boolean>;
		}
	> = {};
	for (const [component, entry] of Object.entries(merged)) {
		// W3 (workspace-context.contract.yaml, VERSAILLES-25 follow-up):
		// distinguish covered (added OR refreshed by this run) from preserved
		// legacy entries — only covered entries always carry the methods key.
		const covered = component in extracted.manifests;
		const storeEntry: {
			sourceHash: string;
			fields: Record<string, string>;
			sourcePath?: string;
			methods?: Record<
				string,
				{ static: boolean; params: string[]; returnType?: string }
			>;
			fieldAccess?: Record<string, string>;
			fieldReadonly?: Record<string, boolean>;
		} = {
			sourceHash: entry.sourceHash,
			fields: Object.fromEntries(
				entry.fields.map((field) => [field.name, field.typeRef]),
			),
		};
		// Covered entries carry the extractor's real sourcePath; preserved
		// legacy entries without one convert to "" and stay out of the store
		// (contract: never an empty or invented persisted sourcePath).
		if (entry.sourcePath.length > 0) {
			storeEntry.sourcePath = entry.sourcePath;
		}
		if (covered) {
			// A refreshed/covered entry ALWAYS carries the methods key — the
			// empty map {} is the first-class "we know this component has
			// zero methods" signal that distinguishes it from a preserved
			// legacy entry, so the planner's UNPLANNABLE_OPERATION guard
			// fires for every staged op instead of treating the component as
			// full-legacy and silently emitting a dead static call. Today the
			// key is dropped when the map is empty (the W3 hole).
			storeEntry.methods = entry.methods ?? {};
			// ADR-0021: covered entries always write per-field access/readonly
			// so the emitter can decide field reachability. The additive shape
			// keeps `fields` unchanged and adds fieldAccess/fieldReadonly.
			storeEntry.fieldAccess = Object.fromEntries(
				entry.fields.map((field) => [field.name, field.access]),
			);
			storeEntry.fieldReadonly = Object.fromEntries(
				entry.fields.map((field) => [field.name, field.readonly]),
			);
		} else if (Object.keys(entry.methods ?? {}).length > 0) {
			// Preserved legacy entries keep their stored shape exactly
			// (byte-compat): a methods map persists only when non-empty, so
			// an entry that never carried the key stays without it.
			storeEntry.methods = entry.methods;
		}
		// Preserved entries round-trip their exact stored access keys when
		// present (byte-compat); absent keys stay absent — never invented for
		// a legacy entry that predates ADR-0021.
		if (!covered && existingAccess[component] !== undefined) {
			storeEntry.fieldAccess = existingAccess[component].fieldAccess;
			storeEntry.fieldReadonly = existingAccess[component].fieldReadonly;
		}
		mergedStore[component] = storeEntry;
	}
	await writeJsonFile(workspaceDir, "manifests.json", {
		manifests: mergedStore,
	});

	return {
		ok: true,
		errors: [],
		warnings,
		exitCode: 0,
		output: { updated, preserved, pruned },
	};
}
