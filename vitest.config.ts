import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./packages/web/src", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
    reporters: ["default", ["junit", { addFileAttribute: true }]],
    outputFile: { junit: "reports/junit.xml" },
    // HTTP + Postgres cases create a database each; under load the 5s default flakes.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Most cases wait on Postgres, not on the CPU. On a 2-CPU gate sandbox the default (CPUs - 1) is a single
    // worker and the suite runs one file at a time.
    maxWorkers: Math.max(4, availableParallelism()),
  },
});
