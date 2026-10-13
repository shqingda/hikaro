import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { TUI, Component, OverlayOptions } from "@earendil-works/pi-tui";
import { ProcessClient } from "../../packages/protocol/src/client.ts";
import { PiBridgeView } from "../../packages/pi-bridge/src/view.ts";
import type { PiTransport } from "../../packages/pi-bridge/src/index.ts";

interface Context {
  mode: string;
  cwd: string;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    custom(
      factory: (
        tui: TUI,
        theme: unknown,
        keys: unknown,
        done: () => void,
      ) => Component,
      options?: { overlay?: boolean; overlayOptions?: OverlayOptions },
    ): Promise<unknown>;
  };
}
interface PiHost {
  registerFlag(
    name: string,
    options: { description: string; type: "boolean"; default: boolean },
  ): void;
  getFlag(name: string): boolean | string | undefined;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler(args: string, ctx: Context): Promise<void>;
    },
  ): void;
  on(
    event: string,
    handler: (event: unknown, ctx: Context) => void | Promise<void>,
  ): void;
}
interface BridgeState {
  opening: boolean;
  autoSeen: boolean;
  view?: PiBridgeView;
}
const stateKey = Symbol.for("hikaro.piBridge.state.v1");
const processState = globalThis as unknown as Record<
  symbol,
  BridgeState | undefined
>;

export function hikaroLaunch(env: NodeJS.ProcessEnv = process.env) {
  return {
    // Pi's distributed executable is not Node, even though it has process.execPath.
    command: env.HIKARO_NODE ?? "node",
    args: [
      fileURLToPath(new URL("../../dist/hikaro.mjs", import.meta.url)),
      "--rpc",
      ...(env.HIKARO_DEMO === "1" ? ["--demo"] : []),
    ],
  };
}

/** Configuration is user-scoped; HIKARO_HOME also makes tests and alternate profiles isolated. */
export function createPiExtension(
  options: {
    home?: string;
    state?: BridgeState;
    createClient?: (cwd: string) => PiTransport;
  } = {},
) {
  return (pi: PiHost) => {
    const home =
      options.home ?? process.env.HIKARO_HOME ?? join(homedir(), ".hikaro");
    const settings = join(home, "pi-bridge.json");
    const state =
      options.state ??
      (processState[stateKey] ??= { opening: false, autoSeen: false });
    const createClient =
      options.createClient ??
      ((cwd: string) => {
        const launch = hikaroLaunch();
        return new ProcessClient(launch.command, launch.args, { cwd });
      });
    pi.registerFlag("pi-native", {
      description: "Skip the default Hikaro bridge for this launch",
      type: "boolean",
      default: false,
    });
    const readSettings = async (): Promise<Record<string, unknown>> => {
      try {
        const value = JSON.parse(await readFile(settings, "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw Error("Invalid Pi bridge settings");
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
      }
    };
    const open = async (ctx: Context) => {
      if (ctx.mode !== "tui" || state.opening) return;
      state.opening = true;
      state.autoSeen = true;
      try {
        await ctx.ui.custom(
          (tui, _theme, _keys, done) => {
            const view = new PiBridgeView(tui, createClient(ctx.cwd), done);
            state.view = view;
            return view;
          },
          {
            overlay: true,
            overlayOptions: {
              width: "100%",
              maxHeight: "100%",
              margin: 0,
              row: 0,
              col: 0,
            },
          },
        );
      } catch (error) {
        ctx.ui.notify(`Hikaro bridge failed: ${String(error)}`, "error");
      } finally {
        state.view?.dispose();
        state.view = undefined;
        state.opening = false;
      }
    };
    pi.registerCommand("hikaro", {
      description: "Open Hikaro, or set default on/off",
      handler: async (input, ctx) => {
        const args = input.trim();
        if (args === "default on" || args === "default off") {
          const current = await readSettings();
          await mkdir(home, { recursive: true, mode: 0o700 });
          const temporary = `${settings}.${randomUUID()}.tmp`;
          try {
            await writeFile(
              temporary,
              JSON.stringify({ ...current, autoOpen: args === "default on" }) +
                "\n",
              { mode: 0o600 },
            );
            await rename(temporary, settings);
          } finally {
            await rm(temporary, { force: true });
          }
          ctx.ui.notify(
            `Hikaro default ${args === "default on" ? "on" : "off"}`,
            "info",
          );
        } else if (args)
          ctx.ui.notify(
            "Use /hikaro, /hikaro default on, or /hikaro default off.",
            "info",
          );
        else if (ctx.mode !== "tui")
          ctx.ui.notify(
            "Hikaro's dedicated view requires interactive Pi.",
            "info",
          );
        else await open(ctx);
      },
    });
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.mode !== "tui" || state.autoSeen) return;
      // Set this even when disabled: /new, /resume and /reload never reopen it unexpectedly.
      state.autoSeen = true;
      if (pi.getFlag("pi-native") || state.opening) return;
      try {
        if ((await readSettings()).autoOpen === true) {
          // Pi awaits session_start handlers. Do not await the lifetime of a persistent UI.
          void open(ctx);
        }
      } catch (error) {
        ctx.ui.notify(`Hikaro settings: ${String(error)}`, "error");
      }
    });
    pi.on("session_shutdown", () => {
      state.view?.exit();
    });
  };
}

export default createPiExtension();
