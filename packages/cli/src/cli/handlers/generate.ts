/**
 * generate handler (build-spec §9, §12) — runs the deterministic generator
 * (planTestCases → emitSuite) and writes full-file output (vitest *.test.ts,
 * xUnit *.Tests.cs, pytest test_*.py per ADR-0009) under
 * config.generatedDir. Gated on context.isValid: an invalid context writes
 * ZERO files and surfaces structured errors with exit 1 (contract invariant 1,
 * build-spec §9). The rejection idiom comes from config.rejection.idiom
 * (default "throws", ADR-0007) and flows through the planner into every
 * reject case. Deterministic: same context in, byte-identical files out.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
	type ManifestsFile,
	type PredicatesFile,
	loadWorkspace,
} from "../../../../core/src/loader/workspace.js";
import {
	coverageManifest,
	emitSuite,
	planPropertyBlocks,
	planTestCases,
} from "../../../../engine/src/generator/index.js";
import type { EmitOptions } from "../../../../engine/src/generator/index.js";
import { contextErrors, contextWarnings, messageOf } from "../context.js";
import type { CliResult } from "../types.js";

export async function handleGenerate(cwd: string): Promise<CliResult> {
	const workspaceDir = join(cwd, ".versailles");
	const context = await loadWorkspace(workspaceDir);
	if (!context.isValid) {
		return {
			ok: false,
			errors: contextErrors(context),
			warnings: contextWarnings(context),
			exitCode: 1,
			output: { files: [] },
		};
	}
	if (context.config === null) {
		return {
			ok: false,
			errors: [
				{
					code: "CONFIG_INVALID",
					field: "config.json",
					detail: "Workspace config is missing — cannot determine generatedDir",
				},
			],
			warnings: [],
			exitCode: 1,
			output: { files: [] },
		};
	}

	try {
		const suite = planTestCases(context);
		// Seeded PBT emission (ADR-0017, build-spec §9.6): compute the
		// property-block plan over the already-planned suite and thread it —
		// plus the configured run count — into the emitSuite options seam.
		// When config.propertyBased.enabled is false/absent planPropertyBlocks
		// returns an EMPTY descriptors list, so the v1 output stays
		// byte-identical (the enabled=false backward-compat pin).
		const propertyPlan = planPropertyBlocks(suite, context);
		const files = emitSuite(suite, context.config.testFramework, {
			generatedDir: context.config.generatedDir,
			modulePaths: deriveModulePaths(
				cwd,
				context.config.generatedDir,
				context.manifests,
			),
			// Shape-aware call metadata (VERSAILLES-20 F1): pass each
			// component's manifest method metadata straight into the emitter.
			// Absent for legacy entries → the emitter keeps the options-object
			// static call (backward compatible).
			methods: deriveMethods(context.manifests),
			// GAP-2 predicate resolution (ADR-0017 §9.6): derive the predicate
			// import table (predicate name → module import specifier) from the
			// contracts predicates registry and thread it through the emitter
			// seam exactly like modulePaths / methods. The vitest emitter
			// imports every predicate a component's property clauses reference;
			// xunit/pytest ignore the field.
			predicates: derivePredicates(
				cwd,
				context.config.generatedDir,
				context.manifests,
				context.predicates,
			),
			propertyPlan,
			propertyNumRuns: context.config.propertyBased?.numRuns ?? 100,
		});
		for (const file of files) {
			const target = join(cwd, file.path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, file.content, "utf8");
		}
		// W4 (build-spec §9.3): the coverage artifact — every contract clause
		// id → the generated test ids tracing it (zero-coverage clauses as
		// empty arrays). Deterministic like the files, and part of the
		// machine-readable output, not a hidden file.
		const coveragePath = join(context.config.generatedDir, "coverage.json");
		const coverageTarget = join(cwd, coveragePath);
		await mkdir(dirname(coverageTarget), { recursive: true });
		await writeFile(
			coverageTarget,
			`${JSON.stringify(coverageManifest(suite), null, 2)}\n`,
			"utf8",
		);
		return {
			ok: true,
			errors: [],
			// Suite-level planning warnings (VERSAILLES-22 F3) ride the same
			// non-blocking tier as loader/extractor warnings (ADR-0004): a
			// PREDICATE_UNPLANNABLE warning surfaces here with exit 0 — the
			// coverage gap is visible, never silent. LoaderWarning is
			// structurally compatible with CliError ({ code, field, detail }).
			warnings: [...contextWarnings(context), ...(suite.warnings ?? [])],
			exitCode: 0,
			output: {
				files: [...files.map((file) => file.path), coveragePath],
			},
		};
	} catch (error) {
		// planTestCases throws on an invalid context (the isValid gate should
		// prevent it) and on unsafe identifiers — convert to structured output.
		return {
			ok: false,
			errors: [
				{
					code: "GENERATION_FAILED",
					detail: `Generation failed: ${messageOf(error)}`,
				},
			],
			warnings: [],
			exitCode: 1,
			output: { files: [] },
		};
	}
}

/**
 * Derives per-component emitter module paths from the loaded manifests store
 * (VERSAILLES-21 F2, deterministic-generation.contract.yaml §9.4): a covered
 * entry's sourcePath is root-relative (e.g. "src/order.ts"), and the generated
 * file lives under <cwd>/<generatedDir>/<Component>.test.ts — so the import
 * specifier is the node:path-relative path from the generated file's directory
 * to the source file, with POSIX separators and an explicit ./ prefix when the
 * target is not in a parent directory. The sourcePath extension is preserved
 * (the vitest convention already emits .ts imports; the legacy default
 * "../../src/<Component>.js" only applies when sourcePath is absent). Entries
 * lacking sourcePath (legacy) contribute no override — the emitter falls back
 * to its deterministic default, never an empty-string import.
 */
function deriveModulePaths(
	cwd: string,
	generatedDir: string,
	manifests: ManifestsFile | null,
): Record<string, string> {
	const modulePaths: Record<string, string> = {};
	for (const [component, entry] of Object.entries(manifests?.manifests ?? {})) {
		if (typeof entry.sourcePath !== "string" || entry.sourcePath.length === 0) {
			continue;
		}
		const from = join(cwd, generatedDir);
		const to = join(cwd, entry.sourcePath);
		let rel = relative(from, to).split(sep).join("/");
		if (!rel.startsWith(".")) {
			rel = `./${rel}`;
		}
		modulePaths[component] = rel;
	}
	return modulePaths;
}

/**
 * Per-component method metadata for the emitter seam (VERSAILLES-20 F1): the
 * manifest store already carries each covered entry's optional `methods`
 * (method name → { static, params, returnType? }) — the generate handler
 * maps them onto the emitSuite options shape exactly like modulePaths.
 * Components without a `methods` key contribute nothing, so the emitter's
 * legacy default applies for them.
 */
function deriveMethods(
	manifests: ManifestsFile | null,
): EmitOptions["methods"] {
	const methods: EmitOptions["methods"] = {};
	for (const [component, entry] of Object.entries(manifests?.manifests ?? {})) {
		if (entry.methods !== undefined) {
			methods[component] = entry.methods;
		}
	}
	return methods;
}

/**
 * The GAP-2 predicate import table (predicate name → module import specifier)
 * for the emitter seam (ADR-0017, build-spec §9.6), derived from the loaded
 * predicates registry. Mirrors the planner's predicatesImportMap resolution of
 * contracts.json predicate `source` refs:
 *
 * - a `<Module>.<function>` sourceRef (e.g. "OrderService.isPositive")
 *   resolves the `<Module>` part through the same module-path derivation the
 *   concrete cases use — the modulePaths override (derived from manifests
 *   sourcePath, extension preserved) when present, else the deterministic
 *   default prefix. A predicate whose module IS the component is CO-LOCATED,
 *   so its specifier is the component's module path (the committed example's
 *   evidence: predicates.isPositive.source = "OrderService.isPositive" with
 *   OrderService.sourcePath = "src/OrderService.ts" → the predicate imports
 *   from the component's own module, "../../src/OrderService.ts").
 * - a path-like source resolves verbatim.
 * - an absent source falls back to the conventional "./predicates.js"
 *   specifier (the planner's fallback).
 *
 * The pinned fixture (`tests/emitters-pbt.test.ts`) exercises the co-located
 * case with the default prefix; the pipeline's modulePaths override may carry
 * the `.ts` extension.
 */
function derivePredicates(
	cwd: string,
	generatedDir: string,
	manifests: ManifestsFile | null,
	predicates: PredicatesFile | null,
): EmitOptions["predicates"] {
	const modulePaths = deriveModulePaths(cwd, generatedDir, manifests);
	const map: EmitOptions["predicates"] = {};
	for (const [name, entry] of Object.entries(predicates?.predicates ?? {})) {
		const sourceRef = entry.sourceRef;
		if (!sourceRef) {
			map[name] = "./predicates.js";
			continue;
		}
		// `<Module>.<function>` sourceRef → resolve the module part like the
		// concrete-case module path derivation (modulePaths override, else the
		// emitter's deterministic default prefix).
		const parts = sourceRef.split(".");
		if (parts.length === 2 && parts[0].length > 0 && parts[1].length > 0) {
			const moduleName = parts[0];
			const override = modulePaths[moduleName];
			map[name] =
				typeof override === "string" && override.length > 0
					? override
					: `../../src/${moduleName}.js`;
			continue;
		}
		// A path-like source resolves verbatim.
		map[name] = sourceRef;
	}
	return map;
}
