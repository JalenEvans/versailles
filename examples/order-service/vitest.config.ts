import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [".versailles/generated/**/*.test.ts"],
		environment: "node",
	},
});
