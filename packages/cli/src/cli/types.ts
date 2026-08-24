/**
 * Machine-readable CLI result types (build-spec §10, docs/contracts/versailles.contract.yaml).
 *
 * Every command path resolves to a CliResult envelope — never a raw throw. The
 * envelope carries the exit code (0 clean · 1 parse/validation/usage · 2 blocking
 * staleness ONLY) plus per-command machine-readable output for agent iteration.
 */

export type CliError = {
	/** Machine-readable error code (UNKNOWN_COMMAND, USAGE, PARSE_ERROR, STALE, ...). */
	code: string;
	/** File / path / clause index the error is about. */
	field?: string;
	/** Human-readable, agent-consumable detail. */
	detail: string;
	/** Present on STALE errors: the stale entry IDs (build-spec §8). */
	ids?: string[];
};

export type CliResult = {
	ok: boolean;
	/** Hard errors → exitCode 1 or 2. */
	errors: CliError[];
	/** Non-blocking signals → exitCode 0. */
	warnings: CliError[];
	/** 0 clean · 1 parse/validation/usage · 2 blocking staleness (build-spec §8). */
	exitCode: 0 | 1 | 2;
	/** Per-command machine-readable payload. */
	output?: unknown;
};
