import { defineConfig } from "vitest/config";

const pty = ["tests/**/*-pty.test.ts", "tests/pty.test.ts"];

export default defineConfig({
  test: {
    globalSetup: ["tests/global-setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // Script checks use node:test; generated acceptance workspaces are not suites.
          include: ["tests/**/*.test.ts"],
          exclude: pty,
        },
      },
      {
        extends: true,
        test: {
          name: "pty",
          include: pty,
          // Real terminals compete for CPU with the child processes they drive.
          fileParallelism: false,
          testTimeout: 60_000,
        },
      },
    ],
  },
});
