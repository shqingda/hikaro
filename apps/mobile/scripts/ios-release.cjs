const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

if (!/^[A-Z0-9]{10}$/.test(process.env.HIKARO_APPLE_TEAM_ID ?? "")) {
  console.error(
    "Set HIKARO_APPLE_TEAM_ID to your chosen Apple development team.",
  );
  process.exit(1);
}
process.chdir(resolve(__dirname, ".."));
// Regenerate signing settings even when a development ios/ directory exists.
// No --clean: retain the existing native project and build caches.
for (const args of [
  ["exec", "expo", "prebuild", "--platform", "ios"],
  [
    "exec",
    "expo",
    "run:ios",
    "--configuration",
    "Release",
    "--device",
    ...process.argv.slice(2),
  ],
]) {
  const result = spawnSync("pnpm", args, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
