import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve(__dirname, "test/vscode.mock.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "text-summary", "lcov"],
      thresholds: {
        lines: 40,
      },
    },
  },
});
