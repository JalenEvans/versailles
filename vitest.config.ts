import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
		// Serialize test files so a dist build in one file never races a
		// CLI spawn (node bin/versailles → loads dist/) in another.
		fileParallelism: false,
		testTimeout: 60_000,
	},
});
