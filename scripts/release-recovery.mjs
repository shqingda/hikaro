import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { SharedHostClient } from "../packages/host/src/client.ts";
import { verifyReleaseDiff } from "./release-diff.mjs";

// The source client is only the observer transport. Every app process uses bin
// from the actual installation, including its worker and native dependencies.
export async function verifyReleaseRecovery({ bin, spawn, home, workspace }) {
  const processes = [],
    terminals = [];
  let client, observer;
  const wait = async (check, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(25);
    }
    throw Error(`Installed recovery timeout: ${label}`);
  };
  const common = ["--home", home, "--cwd", workspace];
  const terminal = (args) => {
    const process = spawn(bin, [...args, ...common], {
      cwd: workspace,
      cols: 110,
      rows: 38,
      env: { ...globalThis.process.env, TERM: "xterm-256color" },
    });
    const item = { process, output: "", exit: undefined };
    terminals.push(item);
    process.onData((data) => {
      item.output = (item.output + data).slice(-1024 * 1024);
    });
    process.onExit(({ exitCode }) => {
      item.exit = exitCode;
    });
    return {
      send(text) {
        const offset = item.output.length;
        process.write(text);
        return offset;
      },
      async text(text, offset = 0) {
        await wait(() => {
          assert.equal(
            item.exit,
            undefined,
            "Installed TUI exited before expected output",
          );
          return stripVTControlCharacters(item.output.slice(offset)).includes(
            text,
          );
        }, `TUI ${text}`);
      },
      async exited() {
        await wait(() => item.exit !== undefined, "TUI exit");
        assert.equal(
          item.exit,
          0,
          stripVTControlCharacters(item.output).slice(-2000),
        );
      },
    };
  };
  const startHost = async () => {
    const process = spawnProcess(bin, ["--host", "--demo", ...common], {
      cwd: workspace,
    });
    const item = { process, output: "", exited: false, error: undefined };
    processes.push(item);
    process.stdout.on("data", (data) => {
      item.output = (item.output + data).slice(-16000);
    });
    process.stderr.on("data", (data) => {
      item.output = (item.output + data).slice(-16000);
    });
    process.on("exit", () => {
      item.exited = true;
    });
    process.on("error", (error) => {
      item.error = error;
      item.exited = true;
    });
    await wait(() => {
      if (item.error) throw item.error;
      assert.equal(item.exited, false, "Installed host exited: " + item.output);
      return item.output.includes("shared host ready");
    }, "host ready");
    return item;
  };
  const connect = async (clientId) => {
    const client = await SharedHostClient.connect({
      home,
      cwd: workspace,
      clientId,
    });
    try {
      await client.request("hello");
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  };
  try {
    const draft = "release draft 中文 😀\nsecond line";
    const first = terminal(["--demo", "--new"]);
    await first.text("Enter send");
    // No debounce delay: quitting must flush the last input before exiting.
    first.send("\x1b[200~" + draft + "\x1b[201~\x04");
    await first.exited();
    const reopened = terminal(["--demo", "--continue"]);
    await reopened.text("release draft 中文 😀");
    await reopened.text("second line");
    reopened.send("\x04");
    await reopened.exited();

    const crashed = await startHost();
    client = await connect("release-recovery-owner");
    const session = await client.request("session.create");
    for (const text of ["confirmed recovery instruction", "leave unconfirmed"])
      await client.request("steer", { sessionId: session.id, text });
    crashed.process.kill("SIGKILL");
    await wait(() => crashed.exited, "SIGKILL host exit");
    await client.close();
    client = undefined;
    await startHost();
    observer = await connect("release-recovery-observer");
    await observer.request("session.resume", { sessionId: session.id });
    const pending = () =>
      observer.request("execution.read", {
        sessionId: session.id,
        kind: "steering",
      });
    const recovered = await pending();
    assert.deepEqual(
      recovered.map((item) => item.title),
      ["1. confirmed recovery instruction", "2. leave unconfirmed"],
    );
    assert.ok(
      recovered.every(
        (item) => item.state === "Recovered · confirmation required",
      ),
    );
    const events = () =>
      observer.request("events.read", { sessionId: session.id });
    assert.equal(
      (await events()).filter((event) => event.type === "run.start").length,
      0,
    );
    const attached = terminal([
      "--attach",
      "--client-id",
      "release-recovery-owner",
      "--session",
      session.id,
    ]);
    await attached.text("Attached to shared host");
    await attached.text(
      "Running tasks, queued messages and recent runs",
      attached.send("/tasks\r"),
    );
    await attached.text("Add to message", attached.send("\r"));
    await attached.text("Apply recovered steering", attached.send("\t"));
    await attached.text(
      "This permits the recovered message",
      attached.send("2"),
    );
    await attached.text("Pending next model turn", attached.send("\x1b[B\r"));
    await attached.text("Search commands and actions", attached.send("\x10"));
    await attached.text(
      "Open Conversation",
      attached.send("Open Conversation"),
    );
    await attached.text("Enter send", attached.send("\r"));
    assert.equal(
      (await events()).filter((event) => event.type === "run.start").length,
      0,
      "Confirmation must not start a task",
    );
    attached.send("explicit release continuation\r");
    await wait(async () => {
      const end = (await events())
        .filter((event) => event.type === "run.end")
        .at(-1);
      if (!end) return false;
      assert.equal(end.data.status, "completed");
      return true;
    }, "explicit continuation completed");
    const users = (await events())
      .filter((event) => event.type === "message")
      .map((event) => event.data.message)
      .filter((message) => message.role === "user");
    assert.deepEqual(
      users.map((message) => message.text),
      ["explicit release continuation", "confirmed recovery instruction"],
    );
    const remaining = await pending();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].title, "1. leave unconfirmed");
    assert.equal(remaining[0].state, "Recovered · confirmation required");
    const diff = await verifyReleaseDiff({
      client: observer,
      terminal: attached,
      session,
      home,
      workspace,
    });
    attached.send("\x04");
    await attached.exited();
    return [
      "installed TUI immediate Ctrl+D flush and --continue multiline draft recovery",
      "installed host SIGKILL and pending steering persistence",
      "installed attached TUI explicit recovery confirmation without starting a task",
      "installed provider receives confirmed steering once and leaves unconfirmed text pending",
      ...diff,
    ];
  } finally {
    for (const item of terminals)
      if (item.exit === undefined) item.process.kill();
    await client?.close();
    await observer?.close();
    for (const item of processes)
      if (!item.exited) item.process.kill("SIGTERM");
    try {
      await wait(
        () =>
          processes.every((item) => item.exited) &&
          terminals.every((item) => item.exit !== undefined),
        "owned process cleanup",
      );
    } catch (error) {
      for (const item of processes)
        if (!item.exited) item.process.kill("SIGKILL");
      await wait(
        () => processes.every((item) => item.exited),
        "forced host cleanup",
      );
      throw error;
    }
  }
}
