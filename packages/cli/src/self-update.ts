import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import metadata from "../../../package.json" with { type: "json" };

export const installerUrl =
  "https://github.com/shqingda/hikaro/releases/latest/download/install.sh";

/** The launcher from install.sh exports HIKARO_INSTALL_ROOT; nothing else can self-update. */
export async function updatePlan(env: NodeJS.ProcessEnv) {
  const root = env.HIKARO_INSTALL_ROOT;
  if (!root)
    throw Error(
      "hikaro update only updates copies installed by install.sh. For a source checkout run git pull, pnpm install and pnpm build.",
    );
  const saved = JSON.parse(await readFile(join(root, "install.json"), "utf8"));
  const base = String(env.HIKARO_DOWNLOAD_BASE ?? saved.base ?? "").replace(
    /\/$/,
    "",
  );
  return {
    url: base ? `${base}/install.sh` : installerUrl,
    env: {
      ...env,
      HIKARO_INSTALL_DIR: root,
      HIKARO_BIN_DIR: String(saved.binDir),
      ...(base ? { HIKARO_DOWNLOAD_BASE: base } : {}),
    },
  };
}

export async function selfUpdate(env = process.env) {
  const plan = await updatePlan(env);
  console.log(`hikaro ${metadata.version} · checking ${plan.url}`);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn("sh", ["-c", 'curl -fsSL "$1" | sh', "sh", plan.url], {
      stdio: "inherit",
      env: plan.env,
    });
    child.on("error", reject);
    child.on("exit", (status) => resolve(status ?? 1));
  });
  if (code)
    throw Error(
      `Update failed (exit ${code}); the installed version is unchanged.`,
    );
}
