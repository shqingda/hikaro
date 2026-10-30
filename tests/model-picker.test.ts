import { it, expect, vi } from "vitest";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import { ProviderCatalog } from "../packages/provider-pi/src/catalog.ts";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node-pty";
import { stripVTControlCharacters } from "node:util";
it("browses models and providers without reading secrets, then reads only the used provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-catalog-"));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("xai", async () => ({
    type: "api_key",
    key: "test-key",
  }));
  const read = vi
    .spyOn(credentials, "read")
    .mockRejectedValue(Error("Keychain denied"));
  try {
    const catalog = new ProviderCatalog(home, credentials);
    const choices = await catalog.available();
    expect(choices.some((m) => m.provider === "xai")).toBe(true);
    expect(choices.some((m) => m.provider === "openai")).toBe(true);
    const providers = await catalog.providers();
    expect(providers.find((p) => p.id === "xai")).toMatchObject({
      stored: true,
      configured: true,
    });
    await catalog.capabilities({
      provider: choices[0]!.provider,
      model: choices[0]!.id,
    });
    expect(read).not.toHaveBeenCalled();
    await expect((await catalog.collection()).getAuth("xai")).rejects.toThrow(
      "Credential store read failed for xai",
    );
    expect(read.mock.calls.map(([id]) => id)).toEqual(["xai"]);
    read.mockRestore();
    expect(await (await catalog.collection()).getAuth("xai")).toMatchObject({
      auth: { apiKey: "test-key" },
    });
  } finally {
    read.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
});
it("renders picker errors before options and never displays secret input", async () => {
  const abort = new AbortController();
  const panel = new ModelPanel(abort.signal, () => {});
  const choice = panel.choose(
    "Select model",
    [{ value: "a", label: "Model A" }],
    "Could not refresh; using cached models",
  );
  const output = panel.render(80).join("\n");
  expect(output.indexOf("Could not refresh")).toBeLessThan(
    output.indexOf("Model A"),
  );
  expect(output.indexOf("Could not refresh")).toBeLessThan(
    output.indexOf("Enter confirm"),
  );
  panel.handleInput("\r");
  expect((await choice).value).toBe("a");
  const secret = panel.prompt("API key", true);
  panel.handleInput("private-token-123");
  expect(panel.render(80).join("\n")).not.toContain("private-token");
  panel.handleInput("\r");
  expect(await secret).toBe("private-token-123");
});
it("uses supported provider authentication methods", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-catalog-"));
  try {
    const catalog = new ProviderCatalog(home, new InMemoryCredentialStore());
    const providers = await catalog.providers();
    expect(
      providers
        .find((p) => p.id === "xai")
        ?.methods.some((m) => m.id === "oauth"),
    ).toBe(true);
    expect(
      providers
        .find((p) => p.id === "openai")
        ?.methods.some((m) => m.id === "oauth"),
    ).toBe(true);
    expect(
      providers.find((p) => p.id === "opencode-go")?.methods.map((m) => m.id),
    ).toEqual(["api_key"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it("opens provider authentication from the model center and cancels back to input", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-picker-"));
  const term = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("packages/cli/src/index.ts"),
      "--demo",
      "--home",
      home,
    ],
    { cols: 100, rows: 32, env: { ...process.env, TERM: "xterm-256color" } },
  );
  let output = "";
  const watchers = new Set<() => void>();
  const exited = new Promise<number>((resolve) =>
    term.onExit(({ exitCode }) => resolve(exitCode)),
  );
  term.onData((chunk) => {
    output += chunk;
    for (const check of watchers) check();
  });
  const send = (text: string) => {
    const offset = output.length;
    term.write(text);
    return offset;
  };
  const wait = (text: string, offset = 0) =>
    new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!stripVTControlCharacters(output.slice(offset)).includes(text))
          return;
        clearTimeout(timer);
        watchers.delete(check);
        resolve();
      };
      const timer = setTimeout(() => {
        watchers.delete(check);
        reject(
          Error(
            `Missing ${text}: ${stripVTControlCharacters(output.slice(-2000))}`,
          ),
        );
      }, 4000);
      watchers.add(check);
      check();
    });
  try {
    await wait("Enter send");
    await wait("Select model", send("/model\r"));
    await wait("Select provider to configure", send("\t"));
    await wait("xAI", send("xai"));
    await wait("Connect", send("\r"));
    await wait("Select authentication method", send("\x1b[B\r"));
    expect(stripVTControlCharacters(output)).toContain("SuperGrok");
    await wait("Connect", send("\x1b"));
    await wait("Select provider to configure", send("\x1b"));
    await wait("Enter send", send("\x1b"));
    await wait("Select authentication method", send("/login xai\r"));
    await wait("Select provider to configure", send("\x1b"));
    await wait("Enter send", send("\x1b"));
    send("\x04");
    expect(await exited).toBe(0);
  } finally {
    term.kill();
    await exited;
    await rm(home, { recursive: true, force: true });
  }
}, 15000);

it("moves one row for press+release, while accepting intentional repeat events", async () => {
  const panel = new ModelPanel(new AbortController().signal, () => {});
  const selected = panel.choose("Models", [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
    { value: "c", label: "C" },
  ]);
  panel.handleInput("\x1b[B");
  panel.handleInput("\x1b[1;1:3B");
  panel.handleInput("\r");
  expect((await selected).value).toBe("b");
});
