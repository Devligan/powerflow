import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Removes the users each database suite creates. Registered here rather
    // than per-suite so a new suite cannot forget it.
    setupFiles: ["src/lib/testing/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});