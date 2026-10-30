import { expect, it, vi } from "vitest";
import { spawn } from "node-pty";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteStore } from "../packages/storage/src/index.ts";

it("keeps a rejected attachment draft, then sends file and image bytes through the real TUI", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-input-pty-"));
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1sAAAAASUVORK5CYII=";
  await writeFile(join(cwd, "code.ts"), "const attachmentProof = 42;");
  await writeFile(join(cwd, "screen shot.png"), Buffer.from(png, "base64"));
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({ id: "attachment", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { content: "ATTACHMENTS_OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing server port");
  const store = await SQLiteStore.open(join(home, "sessions.sqlite"));
  const session = await store.createSession(cwd, "Attachment test", undefined, {
    provider: "local",
    model: "fixture",
    settings: {},
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    // Undeclared endpoints refuse images before sending (5b940b0).
    endpointCapabilities: { images: true },
  });
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("packages/cli/src/index.ts"),
      "--home",
      home,
      "--cwd",
      cwd,
      "--session",
      session.id,
    ],
    {
      cols: 100,
      rows: 24,
      env: { ...process.env, HOME: home, TERM: "xterm-256color" },
    },
  );
  let output = "";
  let exited = false;
  child.onData((data) => {
    output = (output + data).slice(-100000);
  });
  const exit = new Promise<number>((done) =>
    child.onExit(({ exitCode }) => {
      exited = true;
      done(exitCode);
    }),
  );
  try {
    await vi.waitFor(() => expect(output).toContain("/help"), {
      timeout: 10000,
    });
    child.write("Review @missing.ts\r");
    await vi.waitFor(
      async () => {
        expect(await store.draft(session.id)).toBe("Review @missing.ts");
        expect(output).toContain("Error:");
      },
      { timeout: 5000 },
    );
    expect(await store.messages(session.id)).toHaveLength(0);
    expect(requests).toHaveLength(0);
    child.write('\x15Review @code.ts @"screen shot.png"\r');
    await vi.waitFor(() => expect(requests).toHaveLength(1), {
      timeout: 10000,
    });
    const user = requests[0].messages.find(
      (message: { role: string }) => message.role === "user",
    );
    expect(user.content[0].text).toContain("const attachmentProof = 42;");
    expect(user.content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${png}` },
    });
    await vi.waitFor(
      async () => {
        expect((await store.events(session.id)).at(-1)?.data.status).toBe(
          "completed",
        );
        expect(await store.draft(session.id)).toBe("");
      },
      { timeout: 10000 },
    );
    child.write("\x04");
    expect(await exit).toBe(0);
    expect((await store.messages(session.id))[0]?.images?.[0]?.data).toBe(png);
  } finally {
    if (!exited) child.kill("SIGKILL");
    await exit;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
