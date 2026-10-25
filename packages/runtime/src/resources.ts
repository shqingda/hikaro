import { realpath } from "node:fs/promises";
import { constants, homedir } from "node:os";
import { join, resolve } from "node:path";
import * as z from "zod";
import {
  readTextFile,
  replaceTextFile,
  SecureFileError,
} from "../../tools/src/secure-files.ts";

const object = z.record(z.string(), z.unknown());
const trustedPaths = z
  .array(
    z
      .object({
        path: z.string().min(1).max(32768),
        trusted: z.literal(true),
      })
      .passthrough(),
  )
  .max(100);
const resourceInstallSchema = z.object({
  kind: z.enum(["skill", "plugin"]),
  path: z.string().min(1).max(32768),
  trusted: z.literal(true),
});
export type ResourceInstall = z.infer<typeof resourceInstallSchema>;

export async function readResourceConfigText(
  home: string,
  signal: AbortSignal,
) {
  try {
    return await readTextFile(
      join(await realpath(home), "config.json"),
      signal,
      262144,
    );
  } catch (error) {
    if (
      (error instanceof SecureFileError &&
        error.errno === constants.errno.ENOENT) ||
      (error instanceof Error && error.message === "File does not exist")
    )
      return "{}";
    throw error;
  }
}
export function installedSkillDirectories(home: string, config: unknown) {
  const resources = object.parse(object.parse(config).resources ?? {});
  return trustedPaths
    .parse(resources.skills ?? [])
    .map((entry) => resolve(home, entry.path));
}

/** Register a local source in place. Supporting skill files stay beside SKILL.md;
 * plugin modules are only imported by the existing trusted startup loader. */
export async function installLocalResource(
  home: string,
  cwd: string,
  request: unknown,
  signal: AbortSignal,
  checkpoint: () => void,
) {
  const input = resourceInstallSchema.parse(request);
  const expanded =
    input.path === "~" || input.path.startsWith("~/")
      ? join(homedir(), input.path.slice(2))
      : input.path;
  const path = await realpath(resolve(cwd, expanded));
  await readTextFile(
    input.kind === "skill" ? join(path, "SKILL.md") : path,
    signal,
  );
  const configPath = join(await realpath(home), "config.json");
  await replaceTextFile(
    configPath,
    signal,
    (text) => {
      if (text !== undefined && Buffer.byteLength(text) > 262144)
        throw Error("Resource configuration exceeds 256 KiB");
      const config = object.parse(JSON.parse(text ?? "{}"));
      const group =
        input.kind === "skill" ? object.parse(config.resources ?? {}) : config;
      const key = input.kind === "skill" ? "skills" : "plugins";
      const entries = trustedPaths.parse(group[key] ?? []);
      if (!entries.some((entry) => resolve(home, entry.path) === path)) {
        if (entries.length >= 100)
          throw Error("Resource configuration exceeds 100 entries");
        entries.push({ path, trusted: true });
      }
      group[key] = entries;
      if (input.kind === "skill") config.resources = group;
      const next = JSON.stringify(config, null, 2) + "\n";
      if (Buffer.byteLength(next) > 262144)
        throw Error("Resource configuration exceeds 256 KiB");
      return next;
    },
    async () => checkpoint(),
  );
  return { kind: input.kind, path, restartRequired: input.kind === "plugin" };
}
