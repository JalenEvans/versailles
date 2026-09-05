/**
 * VERSAILLES-188 test fixture — Node module loader hook.
 *
 * Registered via `node --import ./tests/fixtures/register-throw-runcli.mjs`,
 * this hook intercepts the load of the shipped dist module that
 * bin/versailles imports (../dist/packages/cli/src/cli/index.js) and
 * substitutes a stub whose runCli ALWAYS throws an unexpected error. That
 * forces the REAL bin/versailles shim to exercise its own top-level error
 * handling — the exact surface VERSAILLES-188 fixes — deterministically and
 * without touching production code. Every other module loads normally.
 */

// The dist module URL the bin statically imports (bin/versailles line 7).
const TARGET_SUFFIX = "/dist/packages/cli/src/cli/index.js";

// Marker the crash-safety test asserts is NEVER a raw unhandled crash on
// stderr — after the fix it lives only inside the structured envelope detail.
export const BOOM =
	"VERSAILLES-188 fixture: runCli threw before its internal catch";

export async function load(url, context, nextLoad) {
	const result = await nextLoad(url, context);
	if (url.endsWith(TARGET_SUFFIX)) {
		return {
			format: "module",
			source: `
				export async function runCli() {
					throw new Error("${BOOM}");
				}
			`,
			shortCircuit: true,
		};
	}
	return result;
}
