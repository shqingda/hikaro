import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const from = process.argv[2];
if (!from) throw Error("Usage: node scripts/check-upgrade.mjs OLD_COMMIT");
// Resolve once to a commit; never interpolate a user-supplied ref into a shell.
const { stdout: resolved } = await exec(
  "git",
  ["rev-parse", "--verify", `${from}^{commit}`],
  { cwd: root },
);
const revision = resolved.trim();
const temporary = await mkdtemp(join(tmpdir(), "hikaro-upgrade-"));
const oldSource = join(temporary, "old-source");
const home = join(temporary, "data");
const backup = join(temporary, "backup");
const restored = join(temporary, "restored");
const workspace = join(temporary, "workspace");
const run = async (file, args, cwd = root) => {
  try {
    return await exec(file, args, {
      cwd,
      timeout: 240000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CI: "true" },
    });
  } catch (error) {
    process.stderr.write(error.stdout ?? "");
    process.stderr.write(error.stderr ?? "");
    throw error;
  }
};
const inspect = (directory, callback) => {
  const db = new DatabaseSync(join(directory, "sessions.sqlite"));
  try {
    return callback(db);
  } finally {
    db.close();
  }
};
try {
  await mkdir(oldSource);
  await mkdir(workspace);
  const archive = join(temporary, "old.tar");
  await run("git", [
    "archive",
    "--format=tar",
    `--output=${archive}`,
    revision,
  ]);
  await run("tar", ["-xf", archive, "-C", oldSource]);
  console.log(`Building old version ${revision}`);
  await run(
    "pnpm",
    ["install", "--frozen-lockfile", "--filter", "hikaro"],
    oldSource,
  );
  await run("pnpm", ["build"], oldSource);
  await run(process.execPath, [
    join(oldSource, "dist/hikaro.mjs"),
    "--demo",
    "--home",
    home,
    "--cwd",
    workspace,
    "--prompt",
    "upgrade-before-marker",
  ]);
  const session = inspect(
    home,
    (db) => db.prepare("SELECT id FROM sessions").get().id,
  );
  inspect(home, (db) =>
    db
      .prepare(
        "INSERT OR REPLACE INTO session_drafts(sessionId,text) VALUES (?,?)",
      )
      .run(session, "unsent draft 中文"),
  );
  // Every CLI has exited and every database handle is closed before backup.
  await cp(home, backup, { recursive: true });
  const before = inspect(home, (db) => ({
    events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
    model: db
      .prepare("SELECT * FROM session_models WHERE sessionId=?")
      .get(session),
  }));
  console.log("Opening old data with current built CLI");
  await run(process.execPath, [
    join(root, "dist/hikaro.mjs"),
    "--demo",
    "--session",
    session,
    "--home",
    home,
    "--cwd",
    workspace,
    "--prompt",
    "upgrade-after-marker",
  ]);
  inspect(home, (db) => {
    assert.deepEqual(
      db
        .prepare("SELECT * FROM events ORDER BY seq LIMIT ?")
        .all(before.events.length),
      before.events,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM session_models WHERE sessionId=?").get(session),
      before.model,
    );
    assert.equal(
      db
        .prepare("SELECT text FROM session_drafts WHERE sessionId=?")
        .get(session).text,
      "unsent draft 中文",
    );
    assert.ok(
      db
        .prepare("SELECT data FROM events")
        .all()
        .some((row) => row.data.includes("upgrade-after-marker")),
    );
    assert.equal(
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    for (const name of ["pending_prompts", "pending_questions"])
      assert.ok(
        db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name),
      );
  });
  // Rollback uses the untouched pre-upgrade backup, never the newer database.
  await cp(backup, restored, { recursive: true });
  inspect(restored, (db) =>
    assert.deepEqual(
      db.prepare("SELECT * FROM events ORDER BY seq").all(),
      before.events,
    ),
  );
  await run(process.execPath, [
    join(oldSource, "dist/hikaro.mjs"),
    "--demo",
    "--session",
    session,
    "--home",
    restored,
    "--cwd",
    workspace,
    "--prompt",
    "rollback-marker",
  ]);
  inspect(restored, (db) => {
    const events = db.prepare("SELECT data FROM events").all();
    assert.ok(events.some((row) => row.data.includes("upgrade-before-marker")));
    assert.ok(events.some((row) => row.data.includes("rollback-marker")));
    assert.ok(!events.some((row) => row.data.includes("upgrade-after-marker")));
    assert.equal(
      db
        .prepare("SELECT text FROM session_drafts WHERE sessionId=?")
        .get(session).text,
      "unsent draft 中文",
    );
    assert.equal(
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
  });
  console.log(
    `PASS: ${revision} -> current build preserves history/model/draft; backup -> old build resumes without upgraded writes`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
