import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import configSchema from "../config.schema.json";

/**
 * Pins config.schema.json machine-checkable validation: the ADR-0009 enum
 * matrix, the config.json shape (build-spec §3.1), and strict nested objects.
 *
 * Contract grounding:
 * - workspace-context.contract.yaml (validate_config): language accepts
 *   typescript | csharp | python; testFramework accepts vitest | xunit | pytest;
 *   jest and any value outside the matrix is rejected (ADR-0009).
 * - ADR-0007 / build-spec §3.1 + §9.1: rejection.idiom is configurable,
 *   default "throws", with the error-return alternative documented as "returns".
 * - build-spec §3.1: sourceRoots, language, testFramework, generatedDir,
 *   staleness.blockOnStale (boolean). ADR-0018 (VERSAILLES-170): the schema
 *   drops grammarVersion/schemaVersion from `required` and properties and
 *   allows an optional `$schema` pointer string.
 * - config.schema.json (JSON Schema draft-07, imported from the repo root):
 *   the nested staleness/rejection objects reject unknown keys via
 *   additionalProperties: false.
 * - ADR-0017 / build-spec §3.1: propertyBased is an optional top-level block
 *   { enabled: boolean (required), numRuns: positive integer (required),
 *   seed?: 32-bit integer (optional) }; absent propertyBased = v1 default
 *   (enabled false, numRuns 100, no seed override).
 */

const ajv = new Ajv({ allErrors: true });

// Compiles the schema once; ajv exposes the last run's errors on
// validateConfig.errors after each call.
const validateConfig = ajv.compile(configSchema);

function baseConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		sourceRoots: ["src/**/*.ts"],
		language: "typescript",
		testFramework: "vitest",
		generatedDir: ".versailles/generated",
		staleness: { blockOnStale: true },
		...overrides,
	};
}

function errorAt(instancePath: string) {
	return validateConfig.errors?.find(
		(error) => error.instancePath === instancePath,
	);
}

describe("config.schema.json — ADR-0009 testFramework enum gate", () => {
	it('accepts a valid config with testFramework "vitest"', () => {
		const config = baseConfig({ testFramework: "vitest" });
		expect(validateConfig(config)).toBe(true);
		expect(validateConfig.errors).toBeNull();
	});

	it('rejects testFramework "jest" outside the ADR-0009 matrix', () => {
		const config = baseConfig({ testFramework: "jest" });
		expect(validateConfig(config)).toBe(false);

		const error = errorAt("/testFramework");
		expect(error).toBeDefined();
		expect(error?.keyword).toBe("enum");
		expect(error?.params?.allowedValues).toEqual(
			expect.arrayContaining(["vitest", "xunit", "pytest"]),
		);
		expect(error?.message).toMatch(/allowed values/);
	});

	it.each(["vitest", "xunit", "pytest"])(
		"accepts every ADR-0009 testFramework value (%s)",
		(testFramework) => {
			const config = baseConfig({ testFramework });
			expect(validateConfig(config)).toBe(true);
		},
	);
});

describe("config.schema.json — ADR-0009 language enum gate", () => {
	it.each(["typescript", "csharp", "python"])(
		"accepts every ADR-0009 language (%s)",
		(language) => {
			const config = baseConfig({ language });
			expect(validateConfig(config)).toBe(true);
		},
	);

	it('rejects an unknown language ("ruby")', () => {
		const config = baseConfig({ language: "ruby" });
		expect(validateConfig(config)).toBe(false);

		const error = errorAt("/language");
		expect(error).toBeDefined();
		expect(error?.keyword).toBe("enum");
		expect(error?.params?.allowedValues).toEqual(
			expect.arrayContaining(["typescript", "csharp", "python"]),
		);
		expect(error?.message).toMatch(/allowed values/);
	});
});

describe("config.schema.json — rejection.idiom gate (ADR-0007)", () => {
	it.each(["throws", "returns"])('accepts rejection.idiom "%s"', (idiom) => {
		const config = baseConfig({ rejection: { idiom } });
		expect(validateConfig(config)).toBe(true);
	});

	it('rejects an unknown rejection.idiom ("explodes")', () => {
		const config = baseConfig({ rejection: { idiom: "explodes" } });
		expect(validateConfig(config)).toBe(false);

		const error = errorAt("/rejection/idiom");
		expect(error).toBeDefined();
		expect(error?.keyword).toBe("enum");
		expect(error?.params?.allowedValues).toEqual(
			expect.arrayContaining(["throws", "returns"]),
		);
		expect(error?.message).toMatch(/allowed values/);
	});
});

describe("config.schema.json — nested objects reject unknown keys", () => {
	it("rejects an unknown key inside staleness", () => {
		const config = baseConfig({
			staleness: { blockOnStale: true, rogueKey: true },
		});
		expect(validateConfig(config)).toBe(false);

		const error = errorAt("/staleness");
		expect(error).toBeDefined();
		expect(error?.keyword).toBe("additionalProperties");
		expect(error?.params?.additionalProperty).toBe("rogueKey");
	});

	it("rejects an unknown key inside rejection", () => {
		const config = baseConfig({
			rejection: { idiom: "throws", rogueKey: true },
		});
		expect(validateConfig(config)).toBe(false);

		const error = errorAt("/rejection");
		expect(error).toBeDefined();
		expect(error?.keyword).toBe("additionalProperties");
		expect(error?.params?.additionalProperty).toBe("rogueKey");
	});
});

describe("config.schema.json — required properties and type enforcement", () => {
	it("rejects a config missing the required testFramework field", () => {
		const config = {
			sourceRoots: ["src/**/*.ts"],
			language: "typescript",
			generatedDir: ".versailles/generated",
			staleness: { blockOnStale: true },
		};
		expect(validateConfig(config)).toBe(false);

		const requiredError = validateConfig.errors?.find(
			(error) =>
				error.keyword === "required" &&
				error.params?.missingProperty === "testFramework",
		);
		expect(requiredError).toBeDefined();
	});

	it("rejects a non-boolean staleness.blockOnStale", () => {
		const config = baseConfig({ staleness: { blockOnStale: "yes" } });
		expect(validateConfig(config)).toBe(false);

		const error = errorAt("/staleness/blockOnStale");
		expect(error).toBeDefined();
		expect(error?.keyword).toBe("type");
		expect(error?.params?.type).toBe("boolean");
	});
});

describe("config.schema.json — full-shape happy path", () => {
	it("accepts a complete build-spec §3.1 config with rejection idiom", () => {
		const config = baseConfig({
			rejection: { idiom: "throws" },
		});
		expect(validateConfig(config)).toBe(true);
		expect(validateConfig.errors).toBeNull();
	});

	it("accepts a config carrying a $schema pointer string (ADR-0018 — the version-ceremony replacement)", () => {
		const config = baseConfig({ $schema: "../../config.schema.json" });
		expect(validateConfig(config)).toBe(true);
		expect(validateConfig.errors).toBeNull();
	});
});

describe("config.schema.json — propertyBased block (ADR-0017)", () => {
	it("accepts a config WITHOUT propertyBased (v1 default, backward-compat)", () => {
		const config = baseConfig();
		expect(validateConfig(config)).toBe(true);
		expect(validateConfig.errors).toBeNull();
	});

	it.each([
		{ enabled: false, numRuns: 100 },
		{ enabled: true, numRuns: 100 },
	])(
		"accepts propertyBased %j (enabled+numRuns required, no seed)",
		(propertyBased) => {
			const config = baseConfig({ propertyBased });
			expect(validateConfig(config)).toBe(true);
			expect(validateConfig.errors).toBeNull();
		},
	);

	it("accepts propertyBased with an explicit 32-bit seed override", () => {
		const config = baseConfig({
			propertyBased: { enabled: true, numRuns: 100, seed: 12345 },
		});
		expect(validateConfig(config)).toBe(true);
		expect(validateConfig.errors).toBeNull();
	});

	it("accepts propertyBased with the int32 upper-bound seed (2147483647)", () => {
		const config = baseConfig({
			propertyBased: { enabled: true, numRuns: 100, seed: 2147483647 },
		});
		expect(validateConfig(config)).toBe(true);
	});

	it.each(["enabled", "numRuns"])(
		"rejects propertyBased missing the required %s field",
		(missingField) => {
			const propertyBased: Record<string, unknown> = {
				enabled: true,
				numRuns: 100,
			};
			delete propertyBased[missingField];
			const config = baseConfig({ propertyBased });
			expect(validateConfig(config)).toBe(false);

			const error = errorAt("/propertyBased");
			expect(error).toBeDefined();
			expect(error?.keyword).toBe("required");
			expect(error?.params?.missingProperty).toBe(missingField);
		},
	);

	it('rejects a non-boolean propertyBased.enabled ("yes")', () => {
		const config = baseConfig({
			propertyBased: { enabled: "yes", numRuns: 100 },
		});
		expect(validateConfig(config)).toBe(false);

		const error = errorAt("/propertyBased/enabled");
		expect(error).toBeDefined();
		expect(error?.keyword).toBe("type");
		expect(error?.params?.type).toBe("boolean");
	});

	it('rejects a non-number propertyBased.numRuns ("many")', () => {
		const config = baseConfig({
			propertyBased: { enabled: true, numRuns: "many" },
		});
		expect(validateConfig(config)).toBe(false);

		const error = errorAt("/propertyBased/numRuns");
		expect(error).toBeDefined();
		expect(error?.keyword).toBe("type");
	});

	it.each([0, -1])(
		"rejects non-positive propertyBased.numRuns (%d) — runs must be >= 1",
		(numRuns) => {
			const config = baseConfig({
				propertyBased: { enabled: true, numRuns },
			});
			expect(validateConfig(config)).toBe(false);

			const error = errorAt("/propertyBased/numRuns");
			expect(error).toBeDefined();
			// minimum / exclusiveMinimum both enforce positivity — either is a valid fix
			expect(error?.keyword).toMatch(/minimum/);
		},
	);

	it("rejects a fractional propertyBased.numRuns (2.5) — runs must be an integer", () => {
		const config = baseConfig({
			propertyBased: { enabled: true, numRuns: 2.5 },
		});
		expect(validateConfig(config)).toBe(false);

		const error = errorAt("/propertyBased/numRuns");
		expect(error).toBeDefined();
	});

	it.each(["abc", 3.14])(
		"rejects a non-32-bit-integer propertyBased.seed (%s)",
		(seed) => {
			const config = baseConfig({
				propertyBased: { enabled: true, numRuns: 100, seed },
			});
			expect(validateConfig(config)).toBe(false);

			const error = errorAt("/propertyBased/seed");
			expect(error).toBeDefined();
			expect(error?.keyword).toBe("type");
		},
	);

	it("rejects an out-of-32-bit-range propertyBased.seed (2^32)", () => {
		const config = baseConfig({
			propertyBased: { enabled: true, numRuns: 100, seed: 4294967296 },
		});
		expect(validateConfig(config)).toBe(false);

		const error = errorAt("/propertyBased/seed");
		expect(error).toBeDefined();
		expect(error?.keyword).toMatch(/max/);
	});

	it("rejects an unknown key inside propertyBased", () => {
		const config = baseConfig({
			propertyBased: { enabled: true, numRuns: 100, rogueKey: true },
		});
		expect(validateConfig(config)).toBe(false);

		const error = errorAt("/propertyBased");
		expect(error).toBeDefined();
		expect(error?.keyword).toBe("additionalProperties");
		expect(error?.params?.additionalProperty).toBe("rogueKey");
	});

	it("rejects a non-object propertyBased block", () => {
		const config = baseConfig({ propertyBased: true });
		expect(validateConfig(config)).toBe(false);

		const error = errorAt("/propertyBased");
		expect(error).toBeDefined();
		expect(error?.keyword).toBe("type");
	});
});
