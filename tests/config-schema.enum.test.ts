import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import configSchema from "../config.schema.json";

/**
 * Red-phase gate for chunk 1.3: config.schema.json machine-checkable validation
 * against the ADR-0009 enum matrix and the config.json shape (build-spec §3.1).
 *
 * Contract grounding:
 * - workspace-context.contract.yaml (validate_config): language accepts
 *   typescript | csharp | python; testFramework accepts vitest | xunit | pytest;
 *   jest and any value outside the matrix is rejected (ADR-0009).
 * - ADR-0007 / build-spec §3.1 + §9.1: rejection.idiom is configurable,
 *   default "throws", with the error-return alternative documented as "returns".
 * - build-spec §3.1: grammarVersion, schemaVersion, sourceRoots, language,
 *   testFramework, generatedDir, staleness.blockOnStale (boolean).
 *
 * Assumption: the schema lives at <repo root>/config.schema.json (JSON Schema
 * draft-07) and is imported directly. Until the Sixth Man authors that file, this
 * module cannot even load — that import failure IS the Red.
 */

const ajv = new Ajv({ allErrors: true });

// Compiles the schema once; ajv exposes the last run's errors on
// validateConfig.errors after each call.
const validateConfig = ajv.compile(configSchema);

function baseConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		grammarVersion: "1.0",
		schemaVersion: "1.0",
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

describe("config.schema.json — required properties and type enforcement", () => {
	it("rejects a config missing the required testFramework field", () => {
		const config = {
			grammarVersion: "1.0",
			schemaVersion: "1.0",
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
});
