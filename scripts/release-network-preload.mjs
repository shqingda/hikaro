// Used only with `node --import` in the explicit installed-release acceptance.
import { appendFile, readFile } from "node:fs/promises";
import { faultFetch } from "./release-network-faults.mjs";
const file = process.env.HIKARO_ACCEPTANCE_FAULT_FILE;
if (!file) throw Error("Missing acceptance fault file");
globalThis.fetch = faultFetch(
  globalThis.fetch,
  async () => (await readFile(file, "utf8")).trim(),
  (entry) =>
    appendFile(file + ".trace", JSON.stringify(entry) + "\n", { mode: 0o600 }),
);
