import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export async function buildSecureFileHelper() {
  if (!["darwin", "linux"].includes(process.platform))
    throw Error("Secure file operations require macOS or Linux");
  await buildHelper("secure-file", "secure file");
}

async function buildHelper(name, description) {
  const source = fileURLToPath(
    new URL(`../packages/tools/native/${name}.c`, import.meta.url),
  );
  const output = fileURLToPath(
    new URL(`../packages/tools/src/${name}-helper`, import.meta.url),
  );
  const temporary = output + "." + randomUUID();
  try {
    await promisify(execFile)("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      source,
      "-o",
      temporary,
    ]);
    await rename(temporary, output);
  } catch (error) {
    throw new Error(
      `Cannot build the ${description} helper. Install a C11 compiler (Xcode Command Line Tools on macOS or build-essential on Linux).`,
      { cause: error },
    );
  } finally {
    await rm(temporary, { force: true });
  }
}
