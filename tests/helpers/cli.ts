import { resolve } from "node:path";

/** The built CLI that PTY suites drive. `HIKARO_TEST_BIN` points at a packaged candidate. */
export const cliBin = () =>
  resolve(process.env.HIKARO_TEST_BIN ?? "dist/hikaro.mjs");
