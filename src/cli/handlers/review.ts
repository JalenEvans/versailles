/**
 * review handler — PR 2 scope: routing + argument validation only. The review
 * flow itself lands in PR 3, so every valid arg shape returns
 * REVIEW_NOT_AVAILABLE (exit 1) — never UNKNOWN_COMMAND.
 */
import type { CliResult } from "../types.js";

export async function handleReview(
	component: string,
	operation?: string,
): Promise<CliResult> {
	const target =
		operation === undefined ? component : `${component}.${operation}`;
	return {
		ok: false,
		errors: [
			{
				code: "REVIEW_NOT_AVAILABLE",
				field: target,
				detail: `Review of "${target}" is not available yet — the review flow lands in a later phase (PR 2 wires routing and argument validation only)`,
			},
		],
		warnings: [],
		exitCode: 1,
	};
}
