import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/rigging/**/*.test.ts", "tests/mcp/**/*.test.ts", "tests/image-production/**/*.test.ts"],
  },
});
