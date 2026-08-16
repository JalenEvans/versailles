/**
 * Predicate registry CLI handlers (build-spec §13 milestone 8,
 * docs/contracts/predicate-registry.contract.yaml) — the registration CLI
 * (register-predicate), the post-lint purity flip (verify-purity), and the
 * purity-check reminder (remind-unverified).
 *
 *   register-predicate <name> --source <Module.functionName>
 *       [--params <csv>] [--paramTypes <csv>] [--sourceHash <hash>]
 *       [--verifiedPure]          → single-entry read-modify-write (ADR-0003)
 *   verify-purity <name>          → flips verifiedPure true; sourceRef/sourceHash
 *                                   never recomputed (verify_purity.ensures)
 *   remind-unverified             → reports unverified entries, never writes
 *
 * Writes are single-entry read-modify-writes of predicates.json (never a
 * full-file rewrite, ADR-0003) with no in-band approval metadata — git is the
 * audit trail. verifiedPure is a human-only gate (ADR-0006): it flips only via
 * --verifiedPure at registration or verify-purity, never by automated analysis.
 * Every failure is a structured result — never a throw (ADR-0010).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadWorkspace } from "../../loader/workspace.js";
import {
	type PredicateEntry,
	isValidPredicateName,
	listUnverified,
	resolvePredicateSource,
} from "../../predicates/index.js";
import {
	contextErrors,
	expandSourceRoots,
	messageOf,
	writeJsonFile,
} from "../context.js";
import type { CliResult } from "../types.js";

/** Parsed register-predicate arguments (flag parsing is a CLI-boundary concern). */
export type RegisterPredicateArgs = {
	name: string;
	source: string;
	params: string[];
	paramTypes: string[];
	sourceHash?: string;
	verifiedPure: boolean;
};

function predicateFailure(
	code: string,
	field: string,
	detail: string,
): CliResult {
	return {
		ok: false,
		errors: [{ code, field, detail }],
		warnings: [],
		exitCode: 1,
	};
}

/**
 * Reads predicates.json raw and returns its parsed top-level object plus the
 * predicates map (defaulting an absent key to {} so a bare { "version": "1.0" }
 * store is writable — init.ts seeds the same shape).
 */
async function readPredicatesRaw(workspaceDir: string): Promise<{
	parsed: Record<string, unknown>;
	predicates: Record<string, unknown>;
}> {
	const raw = await readFile(join(workspaceDir, "predicates.json"), "utf8");
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const predicates =
		parsed.predicates !== null &&
		typeof parsed.predicates === "object" &&
		!Array.isArray(parsed.predicates)
			? (parsed.predicates as Record<string, unknown>)
			: {};
	return { parsed, predicates };
}

export async function handleRegisterPredicate(
	cwd: string,
	args: RegisterPredicateArgs,
): Promise<CliResult> {
	const workspaceDir = join(cwd, ".versailles");

	// The §4.1 IDENT check is a pure CLI-boundary concern — refuse before any
	// read or write (nothing written on failure).
	if (!isValidPredicateName(args.name)) {
		return predicateFailure(
			"INVALID_PREDICATE_NAME",
			args.name,
			`"${args.name}" is not a valid predicate name — predicate_call IDENT is /^[A-Za-z_][A-Za-z0-9_]*$/ and not a reserved keyword (or and not in true false null old)`,
		);
	}

	const context = await loadWorkspace(workspaceDir);
	if (!context.isValid) {
		return {
			ok: false,
			errors: contextErrors(context),
			warnings: [],
			exitCode: 1,
		};
	}
	if (context.config === null) {
		return predicateFailure(
			"CONFIG_INVALID",
			"config.json",
			"Workspace config is missing — cannot determine sourceRoots",
		);
	}

	// Mechanically verify the sourceRef resolves under config.sourceRoots and
	// compute the implementation hash BEFORE anything is written (ADR-0005:
	// nothing invented).
	const roots = expandSourceRoots(context.config.sourceRoots ?? [], cwd);
	const resolved = resolvePredicateSource(roots, args.source);
	if (!resolved.ok) {
		return predicateFailure(
			"SOURCE_REF_UNRESOLVED",
			args.source,
			`sourceRef "${args.source}" does not resolve to an exported top-level function under config.sourceRoots`,
		);
	}
	if (
		args.sourceHash !== undefined &&
		args.sourceHash !== resolved.sourceHash
	) {
		return predicateFailure(
			"SOURCE_HASH_MISMATCH",
			"sourceHash",
			`provided --sourceHash "${args.sourceHash}" does not match the computed implementation hash "${resolved.sourceHash}"`,
		);
	}

	const entry: PredicateEntry = {
		params: args.params,
		paramTypes: args.paramTypes,
		returnType: "boolean",
		sourceRef: args.source,
		sourceHash: resolved.sourceHash,
		// ADR-0006: only a HUMAN's registration-time lint flag sets this — the
		// plain path persists false.
		verifiedPure: args.verifiedPure,
	};

	try {
		const { parsed, predicates } = await readPredicatesRaw(workspaceDir);
		predicates[args.name] = entry;
		parsed.predicates = predicates;
		await writeJsonFile(workspaceDir, "predicates.json", parsed);
	} catch (error) {
		return predicateFailure(
			"PREDICATES_WRITE_FAILED",
			"predicates.json",
			`Failed to write predicates.json: ${messageOf(error)}`,
		);
	}

	return {
		ok: true,
		errors: [],
		warnings: [],
		exitCode: 0,
		output: { registered: args.name, entry },
	};
}

export async function handleVerifyPurity(
	cwd: string,
	name: string,
): Promise<CliResult> {
	const workspaceDir = join(cwd, ".versailles");
	const context = await loadWorkspace(workspaceDir);
	if (!context.isValid) {
		return {
			ok: false,
			errors: contextErrors(context),
			warnings: [],
			exitCode: 1,
		};
	}

	const predicates = context.predicates?.predicates ?? {};
	const entry = predicates[name];
	if (entry === undefined) {
		return predicateFailure(
			"NOT_FOUND",
			name,
			`Predicate "${name}" is not registered in predicates.json`,
		);
	}

	try {
		// Single-entry read-modify-write: flip ONLY verifiedPure — sourceRef /
		// sourceHash are never recomputed or rewritten (verify_purity.ensures).
		const { parsed, predicates: map } = await readPredicatesRaw(workspaceDir);
		const current = map[name] as Record<string, unknown>;
		map[name] = { ...current, verifiedPure: true };
		parsed.predicates = map;
		await writeJsonFile(workspaceDir, "predicates.json", parsed);
	} catch (error) {
		return predicateFailure(
			"PREDICATES_WRITE_FAILED",
			"predicates.json",
			`Failed to write predicates.json: ${messageOf(error)}`,
		);
	}

	return {
		ok: true,
		errors: [],
		warnings: [],
		exitCode: 0,
		output: { verified: name, entry: { ...entry, verifiedPure: true } },
	};
}

export async function handleRemindUnverified(cwd: string): Promise<CliResult> {
	const workspaceDir = join(cwd, ".versailles");
	const context = await loadWorkspace(workspaceDir);
	if (!context.isValid) {
		return {
			ok: false,
			errors: contextErrors(context),
			warnings: [],
			exitCode: 1,
		};
	}

	// The reminder only REPORTS — it never writes verifiedPure (ADR-0006,
	// remind_unverified.ensures) and never touches the file.
	const unverified = listUnverified(context.predicates?.predicates ?? {});
	return {
		ok: true,
		errors: [],
		warnings: [],
		exitCode: 0,
		output: { unverified },
	};
}
