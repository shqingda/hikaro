import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Script checks use node:test; generated acceptance workspaces are not suites.
    include: ["tests/**/*.test.ts"],
  },
});
