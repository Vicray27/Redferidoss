import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // §16: "Cobertura mínima: 80 % en lib/ (tree, cycles, settings, authz,
      // money)". The threshold is enforced on lib/** as a whole; the listed
      // areas are the ones the F8 coverage work targeted.
      include: ["lib/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
