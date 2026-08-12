import { describe, expect, it } from "vitest";

import { packageName } from "../src/index.js";

describe("package entry (smoke)", () => {
	it("exports the package identity marker", () => {
		expect(packageName).toBe("versailles-dbc");
	});
});
