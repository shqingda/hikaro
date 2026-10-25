import { execFile } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PiBackend } from "./index.ts";
import { readPiSettings, setPiAutoOpen, writePiFile } from "./settings.ts";

const execute = promisify(execFile);
const ownership = "// Managed by Hikaro Pi bridge v1\n";

/** Pi owns registration. Only this small, owned entry stores the selected Hikaro home. */
export async function installPi(
  options: {
    command?: string;
    home?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    extensionPath?: string;
  } = {},
) {
  const command = options.command ?? "pi";
  const env = options.env ?? process.env;
  const home = resolve(
    options.home ?? env.HIKARO_HOME ?? join(homedir(), ".hikaro"),
  );
  const extension = resolve(
    options.extensionPath ??
      fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "../../../dist/pi-extension.mjs"
            : "./pi-extension.mjs",
          import.meta.url,
        ),
      ),
  );
  if (!(await lstat(extension)).isFile())
    throw Error("Build Hikaro before installing the Pi extension");
  const path = join(home, "pi-extension.mjs");
  let previous: string | undefined;
  try {
    const stat = await lstat(path);
    if (!stat.isFile())
      throw Error(
        `Refusing to overwrite a Pi entry not owned by Hikaro: ${path}`,
      );
    previous = await readFile(path, "utf8");
    if (!previous.startsWith(ownership))
      throw Error(
        `Refusing to overwrite a Pi entry not owned by Hikaro: ${path}`,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Validate both settings and the selected executable before changing registration.
  await readPiSettings(home);
  const backend = await PiBackend.connect(
    command,
    options.cwd ?? process.cwd(),
    {
      env,
      args: [
        "--offline",
        "--no-session",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
      ],
    },
  );
  await backend.close();
  await writePiFile(
    path,
    ownership +
      `import { createPiExtension } from ${JSON.stringify(pathToFileURL(extension).href)};\n` +
      `export default createPiExtension(${JSON.stringify({ home })});\n`,
  );
  try {
    await execute(command, ["install", path], {
      cwd: options.cwd,
      env,
      timeout: 30_000,
      maxBuffer: 65_536,
    });
  } catch (error) {
    if (previous === undefined) await rm(path, { force: true });
    else await writePiFile(path, previous);
    throw error;
  }
  await setPiAutoOpen(home, true);
  return { path, home };
}
