// Human acceptance entry: keyboard composition cannot be proved by PTY injection.
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
if (!process.stdin.isTTY || !process.stdout.isTTY)
  throw Error(
    "Run this command in a physical terminal with a Chinese input method.",
  );
await mkdir(join(root, "artifacts"), { recursive: true });
const directory = await realpath(await mkdtemp(join(root, "artifacts/ime-")));
const home = join(directory, "data");
const cwd = join(directory, "workspace");
await mkdir(cwd);
const bin = join(root, "dist/hikaro.mjs");
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
const resume = [
  process.execPath,
  bin,
  "--demo",
  "--continue",
  "--home",
  home,
  "--cwd",
  cwd,
];
console.log(
  "Offline IME acceptance. No personal sessions or model credentials are used.",
);
console.log(
  "Keep this resume command for draft recovery:\n" +
    resume.map(quote).join(" "),
);
const child = spawn(
  process.execPath,
  [bin, "--demo", "--new", "--home", home, "--cwd", cwd],
  { stdio: "inherit", cwd },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
  console.log(
    "\nResume to check the unsent draft:\n" + resume.map(quote).join(" "),
  );
  console.log(
    "Report terminal/input-method versions and each check result; this launcher does not certify IME acceptance.",
  );
});
