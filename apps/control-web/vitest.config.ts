import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/bootstrap/**/*.test.ts"],
    pool: "forks",
    sequence: { concurrent: false },
  },
});
