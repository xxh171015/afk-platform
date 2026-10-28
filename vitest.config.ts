import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    reporters: ["default", "junit"],
    outputFile: { junit: "reports/junit.xml" },
  },
});
