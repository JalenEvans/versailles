/**
 * VERSAILLES-188 test fixture — `--import` preload that registers
 * ./throw-runcli-loader.mjs as the module loader for a spawned bin.
 *
 * The crash-safety test spawns the REAL bin with this preload:
 *   node --import ./tests/fixtures/register-throw-runcli.mjs bin/versailles <cmd>
 * so the bin's static import of ../dist/packages/cli/src/cli/index.js is
 * resolved through the loader hook, which swaps in a runCli that throws.
 */
import { register } from "node:module";

register("./throw-runcli-loader.mjs", import.meta.url);
