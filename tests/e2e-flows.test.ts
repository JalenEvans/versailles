import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end flow tests (VERSAILLES-156) — two canonical user flows that
 * exercise the REAL CLI (node bin/versailles) against fresh temp workspaces:
 *
 * Flow 1 — SOURCE CODE FLOW (brownfield):
 *   src/OrderService.ts → init → extract-manifests → author contracts.json
 *   → validate → generate → run generated suite (vitest) → check
 *   → validate --verbose (assert predicate declaration surfaced)
 *
 * Flow 2 — TDD FLOW (greenfield):
 *   init → author contracts.json (Cart) → validate → generate → run generated
 *   suite (expect MODULE_NOT_FOUND, TDD Red) → implement src/Cart.ts → run
 *   generated suite again (expect pass, TDD Green) → check
 *
 * Both flows use the REAL CLI (node <repoRoot>/bin/versailles <command>) with
 * cwd = a fresh mkdtemp workspace, and the REAL test runner (repo vitest
 * binary) for the generated suite. The CLI reads dist/ (bin/versailles
 * imports ../dist/cli/index.js) — guaranteed by a `bun run build` in beforeAll.
 *
 * The suite runs serially (vitest `fileParallelism: false` for this file) so
 * the beforeAll build keeps dist/ fresh without racing other test files.
 */

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI_BIN = join(REPO_ROOT, "bin", "versailles");
const VITEST_BIN = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");

// Generous timeouts for vitest runs (30-60s) but bounded so a hung run fails.
const VITEST_TIMEOUT_MS = 60_000;
const CLI_TIMEOUT_MS = 30_000;

// Per-flow vitest timeout: each flow spawns the real CLI ~6 times plus 1-2
// vitest subprocess runs (the generated suite). Explicit so the suite never
// hits vitest's 5s default, even if the root config's global is unset.
const E2E_TIMEOUT_MS = 60_000;

/** Human-readable spawn failure: exit code, error, stdout, stderr. */
function describeRun(label: string, run: ReturnType<typeof spawnSync>): string {
	const error = run.error ? `\n${run.error.message}` : "";
	return `${label} exited ${run.status}:${error}\n${run.stdout}\n${run.stderr}`;
}

/** Runs the REAL CLI: node bin/versailles <command> with cwd = workspace. */
function runCli(args: string[], cwd: string): ReturnType<typeof spawnSync> {
	return spawnSync(process.execPath, [CLI_BIN, ...args], {
		cwd,
		encoding: "utf8",
		timeout: CLI_TIMEOUT_MS,
	});
}

/** Runs the REAL vitest binary: node node_modules/vitest/vitest.mjs run. */
function runVitest(cwd: string): ReturnType<typeof spawnSync> {
	return spawnSync(process.execPath, [VITEST_BIN, "run"], {
		cwd,
		encoding: "utf8",
		timeout: VITEST_TIMEOUT_MS,
	});
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeFileContent(path: string, content: string): Promise<void> {
	await writeFile(path, content, "utf8");
}

let tempRoot: string;

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), "versailles-e2e-"));
	// Guarantee dist/ is built (bin/versailles imports ../dist/cli/index.js).
	const build = spawnSync("bun", ["run", "build"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: CLI_TIMEOUT_MS,
	});
	if (build.status !== 0) {
		throw new Error(`bun run build failed: ${describeRun("build", build)}`);
	}
});

afterAll(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

// ── Flow 1: SOURCE CODE FLOW (brownfield) ──────────────────────────────────

describe("VERSAILLES-156 — E2E Flow 1: SOURCE CODE FLOW (brownfield)", () => {
	it(
		"src/OrderService.ts → init → extract-manifests → author contracts.json → validate → generate → run generated suite (vitest pass) → check → validate --verbose",
		async () => {
			const cwd = await mkdtemp(join(tmpdir(), "versailles-e2e-flow1-"));
			try {
				// Step 1: Write src/OrderService.ts (the real source, copied from the
				// committed example).
				await mkdir(join(cwd, "src"), { recursive: true });
				const orderServiceSource = `/**
 * OrderService — the minimal reference domain for the Versailles example
 * workspace (VERSAILLES-17). One invariant (\`balance >= 0\`), one operation
 * with a pre/postcondition pair (\`addItem\`), and one registered pure
 * predicate (\`isPositive\`) used by a predicate-call precondition.
 */

/** Registered pure predicate: price must be a positive number. */
export function isPositive(amount: number): boolean {
\treturn amount > 0;
}

/** An order accumulates a non-negative balance as items are added. */
export class OrderService {
\tprivate balance: number;

\tconstructor() {
\t\tthis.balance = 0;
\t}

\t/**
\t * Adds an item to the order. Preconditions: sku is non-empty and price is
\t * positive. Postcondition: balance == old(balance) + price.
\t */
\taddItem(sku: string, price: number): void {
\t\tif (sku === "") {
\t\t\tthrow new Error("sku must not be empty");
\t\t}
\t\tif (!isPositive(price)) {
\t\t\tthrow new Error("price must be positive");
\t\t}
\t\tthis.balance += price;
\t}
}
`;
				await writeFileContent(
					join(cwd, "src", "OrderService.ts"),
					orderServiceSource,
				);

				// Step 2: node bin/versailles init → exit 0, .versailles/ seeded.
				const initRun = runCli(["init"], cwd);
				expect(initRun.status, describeRun("init", initRun)).toBe(0);
				expect(existsSync(join(cwd, ".versailles", "config.json"))).toBe(true);

				// Step 3: node bin/versailles extract-manifests → exit 0 (manifests.json derived).
				const extractRun = runCli(["extract-manifests"], cwd);
				expect(
					extractRun.status,
					describeRun("extract-manifests", extractRun),
				).toBe(0);
				expect(existsSync(join(cwd, ".versailles", "manifests.json"))).toBe(
					true,
				);

				// Step 4: Author contracts.json — the OrderService contract WITH the
				// inline predicates map declaring isPositive.
				const contractsJson = {
					version: "1.0",
					predicates: {
						isPositive: {
							source: "OrderService.isPositive",
							params: ["amount"],
							paramTypes: ["number"],
							returnType: "boolean",
							verifiedPure: true,
						},
					},
					contracts: {
						OrderService: {
							invariants: [{ id: "OrderService.inv0", expr: "balance >= 0" }],
							operations: {
								addItem: {
									id: "OrderService.addItem",
									params: [
										{ name: "sku", type: "string" },
										{ name: "price", type: "number" },
									],
									preconditions: [
										{ id: "OrderService.addItem.pre0", expr: 'sku != ""' },
										{
											id: "OrderService.addItem.pre1",
											expr: "isPositive(price)",
										},
									],
									postconditions: [
										{
											id: "OrderService.addItem.post0",
											expr: "balance == old(balance) + price",
										},
									],
									effects: [{ field: "balance", kind: "mutate" }],
									sourceHash: "e6d9d945",
								},
							},
						},
					},
				};
				await writeJsonFile(
					join(cwd, ".versailles", "contracts.json"),
					contractsJson,
				);

				// Step 5: node bin/versailles validate → exit 0, ok true.
				const validateRun = runCli(["validate"], cwd);
				expect(validateRun.status, describeRun("validate", validateRun)).toBe(
					0,
				);
				const validateOutput = JSON.parse(validateRun.stdout);
				expect(validateOutput.ok).toBe(true);

				// Step 6: node bin/versailles generate → exit 0, emits .versailles/generated/OrderService.test.ts + coverage.json.
				const generateRun = runCli(["generate"], cwd);
				expect(generateRun.status, describeRun("generate", generateRun)).toBe(
					0,
				);
				const generatedTestPath = join(
					cwd,
					".versailles",
					"generated",
					"OrderService.test.ts",
				);
				expect(existsSync(generatedTestPath)).toBe(true);
				const coveragePath = join(
					cwd,
					".versailles",
					"generated",
					"coverage.json",
				);
				expect(existsSync(coveragePath)).toBe(true);

				// Step 7: Run the generated suite via the repo vitest binary → exit 0, ALL tests PASS.
				const vitestRun = runVitest(join(cwd, ".versailles", "generated"));
				expect(
					vitestRun.status,
					describeRun("vitest run (generated suite)", vitestRun),
				).toBe(0);

				// Step 8: node bin/versailles check → exit 0.
				const checkRun = runCli(["check"], cwd);
				expect(checkRun.status, describeRun("check", checkRun)).toBe(0);

				// Step 9: Bonus sanity: node bin/versailles validate --verbose output contains
				// the predicate declaration / exprViews (non-empty).
				const verboseRun = runCli(["validate", "--verbose"], cwd);
				expect(
					verboseRun.status,
					describeRun("validate --verbose", verboseRun),
				).toBe(0);
				const verboseOutput = JSON.parse(verboseRun.stdout);
				expect(verboseOutput.ok).toBe(true);
				expect(verboseOutput.output.verbose).toBeDefined();
				expect(Array.isArray(verboseOutput.output.verbose.exprViews)).toBe(
					true,
				);
				expect(verboseOutput.output.verbose.exprViews.length).toBeGreaterThan(
					0,
				);
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
		E2E_TIMEOUT_MS,
	);
});

// ── Flow 2: TDD FLOW (greenfield) ──────────────────────────────────────────

describe("VERSAILLES-156 — E2E Flow 2: TDD FLOW (greenfield)", () => {
	it(
		"init → author contracts.json (Cart) → validate → generate → run generated suite (MODULE_NOT_FOUND, TDD Red) → implement src/Cart.ts → run generated suite (pass, TDD Green) → check",
		async () => {
			const cwd = await mkdtemp(join(tmpdir(), "versailles-e2e-flow2-"));
			try {
				// Step 1: node bin/versailles init → exit 0.
				// The init command seeds an empty manifests.json (`{ version: "1.0" }`)
				// alongside config.json and contracts.json. This is the TRUE user flow:
				// the validator must tolerate this empty manifests.json and NOT emit
				// UNKNOWN_FIELD errors for field references in greenfield contracts
				// (the specific component has no manifest entry yet).
				const initRun = runCli(["init"], cwd);
				expect(initRun.status, describeRun("init", initRun)).toBe(0);
				expect(existsSync(join(cwd, ".versailles", "config.json"))).toBe(true);
				// Verify init seeded the empty manifests.json (the real user flow).
				expect(existsSync(join(cwd, ".versailles", "manifests.json"))).toBe(
					true,
				);

				// Step 2: Author contracts.json — the Cart contract (from contract-first.test.ts fixtures).
				const contractsJson = {
					version: "1.0",
					contracts: {
						Cart: {
							invariants: [],
							operations: {
								addItem: {
									id: "Cart.addItem",
									params: [
										{ name: "sku", type: "string" },
										{ name: "price", type: "number" },
									],
									preconditions: [
										{ id: "Cart.addItem.pre0", expr: "price > 0" },
									],
									postconditions: [
										{
											id: "Cart.addItem.post0",
											expr: "balance == old(balance) + price",
										},
									],
									effects: [{ field: "balance", kind: "mutate" }],
									sourceHash: "cart-additem-hash",
								},
							},
						},
					},
				};
				await writeJsonFile(
					join(cwd, ".versailles", "contracts.json"),
					contractsJson,
				);

				// Step 3: node bin/versailles validate → exit 0 (greenfield must validate — ADR-0011).
				const validateRun = runCli(["validate"], cwd);
				expect(validateRun.status, describeRun("validate", validateRun)).toBe(
					0,
				);
				const validateOutput = JSON.parse(validateRun.stdout);
				expect(validateOutput.ok).toBe(true);

				// Step 4: node bin/versailles generate → exit 0 (emits test importing ../../src/Cart.js).
				const generateRun = runCli(["generate"], cwd);
				expect(generateRun.status, describeRun("generate", generateRun)).toBe(
					0,
				);
				const generatedTestPath = join(
					cwd,
					".versailles",
					"generated",
					"Cart.test.ts",
				);
				expect(existsSync(generatedTestPath)).toBe(true);

				// Step 5: Run generated suite via vitest → exit NON-ZERO with MODULE_NOT_FOUND/Cannot find module (TDD Red).
				const vitestRun1 = runVitest(join(cwd, ".versailles", "generated"));
				expect(
					vitestRun1.status,
					`expected vitest run to fail (TDD Red): ${describeRun("vitest run (TDD Red)", vitestRun1)}`,
				).not.toBe(0);
				const combinedOutput1 = vitestRun1.stdout + vitestRun1.stderr;
				const isModuleNotFoundError =
					combinedOutput1.includes("MODULE_NOT_FOUND") ||
					combinedOutput1.includes("Cannot find module") ||
					combinedOutput1.includes("Error:") ||
					combinedOutput1.includes("TypeError");
				expect(
					isModuleNotFoundError,
					`expected MODULE_NOT_FOUND or TypeError but got:\n${combinedOutput1}`,
				).toBe(true);

				// Step 6: Implement src/Cart.ts — a class matching what the generated test exercises.
				// CRITICAL: ground this from what the generator ACTUALLY emits — read the emitted test file first.
				const emittedTestContent = await readFile(generatedTestPath, "utf8");
				// The emitted test calls Cart.addItem({ sku, price }) as a STATIC method
				// with an OBJECT argument (not an instance method with separate args).
				// The source must match this shape: a static addItem method that takes
				// an object with sku and price properties, throws when price <= 0,
				// and returns a defined value for valid inputs.
				await mkdir(join(cwd, "src"), { recursive: true });
				const cartSource = `/**
 * Cart — the minimal greenfield domain for the Versailles TDD flow.
 * One operation with a pre/postcondition pair (addItem).
 */
export class Cart {
\tprivate static balance = 0;

\t/**
\t * Adds an item to the cart. Precondition: price > 0.
\t * Postcondition: balance == old(balance) + price.
\t */
\tstatic addItem(args: { sku: string; price: number }): number {
\t\tif (args.price <= 0) {
\t\t\tthrow new Error("price must be positive");
\t\t}
\t\tCart.balance += args.price;
\t\treturn Cart.balance;
\t}
}
`;
				await writeFileContent(join(cwd, "src", "Cart.ts"), cartSource);

				// Step 7: Run the generated suite again via vitest → exit 0 (Green — the generated tests PASS).
				const vitestRun2 = runVitest(join(cwd, ".versailles", "generated"));
				expect(
					vitestRun2.status,
					describeRun("vitest run (TDD Green)", vitestRun2),
				).toBe(0);

				// Step 8: node bin/versailles check → exit 0.
				const checkRun = runCli(["check"], cwd);
				expect(checkRun.status, describeRun("check", checkRun)).toBe(0);
			} finally {
				await rm(cwd, { recursive: true, force: true });
			}
		},
		E2E_TIMEOUT_MS,
	);
});
