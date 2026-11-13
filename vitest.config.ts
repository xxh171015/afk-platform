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
  },
});
