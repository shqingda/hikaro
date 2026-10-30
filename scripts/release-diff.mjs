import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

// Seed private persisted data; parsing, pagination and rendering run entirely
// inside the installed application, without importing source runtime/diff code.
export async function verifyReleaseDiff({
  client,
  terminal,
  session,
  home,
  workspace,
}) {
  const hello = await client.request("hello");
  assert.ok(
    hello.methods.includes("changes.diff"),
    "Installed host must advertise changes.diff",
  );
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const before = "before release diff\n";
  const lines = Array.from({ length: 1500 }, (_, i) => `line-${i} 中文😀`);
  lines.push("release-diff-tail 😀");
  const after = lines.join("\n");
  const file = join(workspace, "release-diff.txt");
  const folder = join(home, "changes", hash(session.id));
  const entry = {
    id: randomUUID(),
    path: file,
    timestamp: Date.now(),
    before: hash(before),
    after: hash(after),
    state: "committed",
  };
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(file, after);
  await writeFile(join(folder, `${entry.before}.txt`), before, { mode: 0o600 });
  await writeFile(join(folder, `${entry.after}.txt`), after, { mode: 0o600 });
  await writeFile(join(folder, `${entry.id}.json`), JSON.stringify(entry), {
    mode: 0o600,
  });
  const listed = await client.request("changes.list", {
    sessionId: session.id,
  });
  assert.deepEqual(listed.items, [entry]);
  const pages = [];
  let total;
  for (let offset = 0; ;) {
    const page = await client.request("changes.diff", {
      sessionId: session.id,
      id: entry.id,
      offset,
      limit: 1024,
    });
    assert.deepEqual(page.entry, entry);
    assert.equal(page.encoding, "utf16");
    assert.equal(page.total, total ?? page.total);
    assert.ok(page.total > offset && page.total < 100000);
    total = page.total;
    const end = Math.min(total, offset + 1024);
    assert.equal(page.data.length, end - offset);
    assert.equal(page.nextOffset, end < total ? end : null);
    pages.push(page.data);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.ok(pages.length > 1);
  assert.equal(
    pages.join(""),
    [
      `--- ${file}`,
      `+++ ${file}`,
      `@@ -1,1 +1,1501 @@`,
      "-before release diff",
      ...lines.map((line) => `+${line}`),
      "\\ No newline at end of file",
    ].join("\n"),
  );
  await terminal.text("Review changed files", terminal.send("/changes\r"));
  await terminal.text("Next part", terminal.send("\r"));
  await terminal.text("Part 2 · final", terminal.send("1"));
  await terminal.text("release-diff-tail", terminal.send("\x1b[6~".repeat(60)));
  await terminal.text("No newline at end of file");
  await terminal.text("Search commands and actions", terminal.send("\x10"));
  await terminal.text("Open Conversation", terminal.send("Open Conversation"));
  await terminal.text("Enter send", terminal.send("\r"));
  assert.equal(
    await readFile(file, "utf8"),
    after,
    "Reading must not change the file",
  );
  return [
    "installed host advertises and serves complete paged Unicode diffs",
    "installed attached TUI opens the same record and reads its final page without changing the file",
  ];
}
