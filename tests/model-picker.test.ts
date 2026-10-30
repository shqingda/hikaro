import { it, expect, vi } from "vitest";
import { ModelPanel } from "../packages/tui/src/model-panel.ts";
import { ProviderCatalog } from "../packages/provider-pi/src/catalog.ts";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node-pty";
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
it("opens /model without arguments, then provider/auth selection, and cancels back to input", async () => {
  const home = await mkdtemp(join(tmpdir(), "hikaro-picker-"));
  try {
    await new Promise<void>((done, reject) => {
      const term = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("apps/cli/src/index.ts"),
          "--demo",
          "--home",
          home,
        ],
        {
          cols: 100,
          rows: 32,
          env: { ...process.env, TERM: "xterm-256color" },
        },
      );
      let output = "",
        phase = 0;
      const timeout = setTimeout(() => {
        term.kill();
        reject(Error("Model picker timeout: " + output.slice(-1200)));
      }, 10000);
      term.onData((chunk) => {
        output = (output + chunk).slice(-30000);
        if (phase === 0 && output.includes("/help")) {
          phase = 1;
          output = "";
          term.write("/model\r");
        } else if (
          phase === 1 &&
          (output.includes("Select provider to configure") ||
            output.includes("Select model"))
        ) {
          phase = 2;
          output = "";
          term.write("\x1b");
          setTimeout(() => term.write("/login\r"), 30);
        } else if (
          phase === 2 &&
          output.includes("Select provider to configure")
        ) {
          phase = 3;
          output = "";
          term.write("xAI\r");
        } else if (
          phase === 3 &&
          output.includes("Select authentication method")
        ) {
          expect(output).toContain("SuperGrok");
          phase = 4;
          term.write("\x1b");
          setTimeout(() => term.write("\x04"), 30);
        }
      });
      term.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        try {
          expect(phase).toBe(4);
          expect(exitCode).toBe(0);
          done();
        } catch (e) {
          reject(e);
        }
      });
    });
  } finally {
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
