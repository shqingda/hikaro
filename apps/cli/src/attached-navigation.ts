import type { ClientConnection } from "../../../packages/client-core/src/connection.ts";
import type { ClientFiles } from "../../../packages/host/src/client-files.ts";
import type { HikaroView } from "../../../packages/tui/src/index.ts";
import type {
  Session,
  ModelSelection,
  ModelSettings,
} from "../../../packages/core/src/types.ts";
import {
  rpcReadMethods,
  type DurableCommandReceipt,
  type RpcMethod,
} from "../../../packages/protocol/src/contracts.ts";
import { openSessions } from "../../../packages/tui/src/sessions.ts";
import { openModelPicker } from "../../../packages/tui/src/model-picker.ts";
import {
  openModelControl,
  parseModelControl,
} from "../../../packages/tui/src/model-settings.ts";
import { openGeneralSettings } from "../../../packages/tui/src/general-settings.ts";
import { openPermissions } from "../../../packages/tui/src/permissions.ts";
import {
  permissionModeSchema,
  type PermissionMode,
} from "../../../packages/runtime/src/permissions.ts";
import {
  parseTuiPreferences,
  type TuiPreferences,
} from "../../../packages/tui/src/preferences.ts";
import type {
  ProviderCatalog,
  ModelChoice,
} from "../../../packages/provider-pi/src/catalog.ts";
import type { ResourceEntry } from "./rpc-configuration.ts";

export class AttachedNavigation {
  private epoch = 0;
  disconnected() {
    this.epoch++;
  }
  constructor(
    private client: ClientConnection,
    private view: HikaroView,
    private files: ClientFiles,
    private preferences: TuiPreferences,
    private catalog: () => Promise<ProviderCatalog>,
    private flush: () => Promise<void>,
    private synchronize: () => Promise<void>,
  ) {}
  private async request<T>(
    method: RpcMethod,
    p: Record<string, unknown> = {},
  ): Promise<T> {
    const epoch = this.epoch;
    if (!this.client.state.canAct)
      throw Error("Host disconnected or synchronizing; reopen the menu");
    const result = await this.client.request(method, p);
    if (epoch !== this.epoch || !this.client.state.canAct)
      throw Error(
        "Connection changed; reopen the menu. No command was replayed.",
      );
    if (result && typeof result === "object" && "duplicate" in result)
      throw Error(
        "Command already received. Inspect current state before retrying.",
      );
    if (
      [
        "session.resume",
        "session.create",
        "session.rename",
        "session.delete",
        "model.set",
      ].includes(method)
    )
      await this.synchronize();
    return result as T;
  }
  private selected(id: string) {
    if (this.client.state.session?.id !== id || !this.client.state.canAct)
      throw Error("Session changed; reopen the menu");
  }
  private idle() {
    if (this.client.state.busy)
      throw Error(
        "Finish or cancel the active run before changing model or permissions",
      );
  }
  async command(command: string, arg = "") {
    const id = this.client.state.session?.id;
    if (command === "/recovery") {
      const { panel, signal, close } = this.view.openModelPanel();
      try {
        for (;;) {
          panel.progress("Checking operation receipts…");
          await this.client.reconcile();
          signal.throwIfAborted();
          const receipts = this.client.receipts
            .filter((r) => !rpcReadMethods.has(r.method))
            .sort(
              (a, b) =>
                Number(["completed", "failed"].includes(a.status)) -
                Number(["completed", "failed"].includes(b.status)),
            );
          const picked = await panel.choose(
            "Recovery · operation receipts",
            [
              ...receipts.map((r) => ({
                value: r.id,
                label: `${r.method} · ${r.status}`,
                description: r.id,
              })),
              { value: "refresh", label: "Refresh receipts" },
            ],
            "Unknown does not mean safe to retry. No operation is replayed here. Completed means handled; inspect the actual result.",
            undefined,
            { search: true },
          );
          if (picked.value === "refresh") continue;
          panel.progress("Reading operation outcome…");
          const { receipt } = await this.request<{
            receipt: DurableCommandReceipt | null;
          }>("command.receipt", { commandId: picked.value });
          signal.throwIfAborted();
          const choice = await panel.readDocument(
            "Operation outcome",
            receipt
              ? `Method: ${receipt.method}\nStatus: ${receipt.status}\nCommand: ${receipt.id}\nSession: ${receipt.sessionId ?? "unavailable"}\n${receipt.error ?? ""}\n\nUnknown/failed operations may have side effects. Inspect session history and files before deciding what to do. This panel never retries execution.`
              : "No durable receipt found. Outcome remains unknown; the request may not have reached this host. Inspect files before any new attempt. This panel never retries execution.",
            receipt?.sessionId
              ? [{ value: "session", label: "Open original session" }]
              : [],
          );
          if (choice.value === "session" && receipt?.sessionId) {
            await this.flush();
            await this.request("session.resume", {
              sessionId: receipt.sessionId,
            });
            this.view.notice(
              "Original session opened. Inspect history; no operation was replayed.",
            );
            return;
          }
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally {
        close();
      }
      return;
    }
    if (command === "/sessions" || command === "/resume") {
      if (command === "/resume" && arg) {
        await this.flush();
        await this.request("session.resume", { sessionId: arg });
        return;
      }
      await openSessions(
        this.view,
        () => this.client.state.session?.id ?? "",
        (offset, limit, query) =>
          this.request<Session[]>("session.list", { offset, limit, query }),
        async (sessionId) => {
          await this.flush();
          const opened = await this.request<Session>("session.resume", {
            sessionId,
          });
          this.view.notice(`Session opened: ${opened.title}.`);
        },
        async (sessionId) => {
          await this.flush();
          const current = this.client.state.session?.id === sessionId;
          const result = await this.request<{ cleanupError?: string }>(
            "session.delete",
            { sessionId },
          );
          if (current) await this.request("session.create");
          return result.cleanupError;
        },
        async (sessionId, title) => {
          await this.request("session.rename", { sessionId, title });
        },
        arg,
      );
      return;
    }
    if (command === "/settings") {
      if (arg)
        throw Error(
          "Use /context, /thinking, /speed or /permissions for host settings",
        );
      await openGeneralSettings(this.view, this.preferences, async (next) => {
        const saved = parseTuiPreferences(next);
        await this.files.savePreferences(saved);
        this.preferences = saved;
        this.view.setPreferences(saved);
        this.view.notice("Display preferences saved for this attached view.");
      });
      return;
    }
    if (command === "/resources") {
      await this.resources(arg);
      return;
    }
    if (!id) throw Error("No session selected");
    if (command === "/export") {
      const result = await this.request<{ path: string }>(
        "session.export.file",
        { sessionId: id, includeThinking: this.preferences.showThinking },
      );
      this.view.notice(
        `Exported: ${result.path}\nIf an .assets folder is present beside the Markdown, copy it together with the file.`,
      );
      return;
    }
    if (command === "/plugins") {
      const { panel, signal, close } = this.view.openModelPanel();
      try {
        panel.progress("Loading host plugins…");
        const { items } = await this.request<{
          items: Array<{ name: string; kind: "command" | "view" }>;
        }>("plugins.list");
        signal.throwIfAborted();
        for (;;) {
          const selected = await panel.choose(
            "Host plugins",
            items.map((item, i) => ({
              value: String(i),
              label: item.name,
              description: item.kind,
            })),
            "Trusted host plugins. Commands may change files. Plan mode refuses execution.",
            undefined,
            { search: true },
          );
          const item = items[Number(selected.value)];
          if (!item) continue;
          const args =
            item.kind === "command"
              ? await panel.prompt("Plugin arguments (optional)")
              : "";
          const confirmation = await panel.choose(
            `Run ${item.name}?`,
            [
              { value: "cancel", label: "Cancel" },
              { value: "run", label: "Run plugin" },
            ],
            "Runs trusted code on the host.",
          );
          if (confirmation.value !== "run") continue;
          this.selected(id);
          panel.progress("Running host plugin…");
          const result = await this.request<{ text: string }>(
            "plugins.invoke",
            { sessionId: id, ...item, args },
          );
          signal.throwIfAborted();
          await this.synchronize();
          await panel.readDocument(
            `Plugin result · ${item.name}`,
            result.text,
            [],
          );
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      } finally {
        close();
      }
      return;
    }
    this.idle();
    if (command === "/permissions") {
      const state = await this.request<{ permissionMode: PermissionMode }>(
        "workspace.current",
      );
      this.selected(id);
      const apply = async (mode: PermissionMode) => {
        this.selected(id);
        await this.request("permissions.set", { mode });
        this.view.notice(`Host workspace permissions saved: ${mode}.`);
      };
      if (arg) await apply(permissionModeSchema.parse(arg));
      else await openPermissions(this.view, state.permissionMode, apply);
      return;
    }
    if (command === "/model" || command === "/login") {
      const select = async (
        provider: string,
        model: string,
        makeDefault: boolean,
      ) => {
        this.selected(id);
        await this.request("model.set", { sessionId: id, provider, model });
        this.view.notice(`Active model: ${provider}/${model}.`);
        if (makeDefault) {
          this.selected(id);
          await this.request("model.default", { sessionId: id });
          this.view.notice("Model saved for new sessions.");
        }
      };
      if (command === "/model" && arg) {
        const slash = arg.indexOf("/");
        if (slash < 1) throw Error("Use /model provider/model");
        await select(arg.slice(0, slash), arg.slice(slash + 1), false);
        return;
      }
      const local = await this.catalog();
      this.selected(id);
      await openModelPicker(
        this.view,
        {
          providers: () => local.providers(),
          available: async (provider) => {
            const all: ModelChoice[] = [];
            for (let offset = 0; ;) {
              const page = await this.request<{
                items: ModelChoice[];
                hasMore: boolean;
              }>("models.list", {
                ...(provider ? { provider } : {}),
                offset,
                limit: 100,
              });
              all.push(...page.items);
              if (!page.hasMore) break;
              if (!page.items.length) throw Error("Incomplete model catalog");
              offset += page.items.length;
            }
            return all;
          },
          login: async (provider, type, interaction) => {
            this.selected(id);
            await local.login(provider, type, interaction);
            this.view.notice("Sign-in saved in the local credential store.");
            this.selected(id);
            await this.request("providers.reload");
          },
          refresh: async (provider, signal) => {
            const warning = await local.refresh(provider, signal);
            signal.throwIfAborted();
            await this.request("providers.reload");
            return warning;
          },
        },
        select,
        command === "/login",
        () => this.command("/settings"),
      );
      return;
    }
    if (
      command === "/context" ||
      command === "/thinking" ||
      command === "/speed"
    ) {
      const field = command.slice(1) as "context" | "thinking" | "speed";
      const parsed = parseModelControl(field, arg);
      const state = await this.request<{
        current: ModelSelection;
        default: ModelSelection;
      }>("model.read", { sessionId: id });
      this.selected(id);
      if (parsed.supplied) {
        const selection =
          parsed.scope === "active" ? state.current : state.default;
        await this.request(
          parsed.scope === "active" ? "model.set" : "model.default",
          {
            sessionId: id,
            provider: selection.provider,
            model: selection.model,
            settings: { ...selection.settings, [parsed.key]: parsed.value },
          },
        );
        this.view.notice(
          `${command}: ${parsed.scope === "active" ? "applied to this session" : "saved for new sessions"}.`,
        );
        return;
      }
      await openModelControl(
        this.view,
        {
          capabilities: (provider, model) =>
            this.request("model.capabilities", { provider, model }),
        },
        command.slice(1) as "context" | "thinking" | "speed",
        state.current,
        state.default,
        async (settings: ModelSettings) => {
          this.selected(id);
          await this.request("model.set", {
            sessionId: id,
            provider: state.current.provider,
            model: state.current.model,
            settings,
          });
        },
        async (selection) => {
          this.selected(id);
          await this.request("model.default", {
            sessionId: id,
            provider: selection.provider,
            model: selection.model,
            settings: selection.settings,
          });
        },
        parsed.scope,
      );
      return;
    }
    throw Error("Unknown configuration command");
  }
  private async resources(initialQuery: string) {
    const { panel, signal, close } = this.view.openModelPanel();
    let offset = 0,
      query = initialQuery;
    const previous: number[] = [];
    const load = () =>
      this.request<{ items: ResourceEntry[]; hasMore: boolean }>(
        "resources.list",
        { offset, query },
      );
    try {
      for (;;) {
        panel.progress("Loading host resources…");
        let page = await load();
        signal.throwIfAborted();
        const choices = () => [
          ...page.items.map((r, index) => ({
            value: String(index),
            label: r.name,
            description: r.kind,
          })),
          ...(offset ? [{ value: "prev", label: "Previous page" }] : []),
          ...(page.hasMore ? [{ value: "next", label: "Next page" }] : []),
        ];
        const picked = await panel.choose(
          "Host resources · search loaded entries",
          choices(),
          "Inventory only. Skills are used by the agent; use /plugins to run plugin commands/views. Restart host to reload configuration.",
          undefined,
          {
            search: true,
            searchQuery: query,
            loadItems: async (text) => {
              const next = await this.request<{
                items: ResourceEntry[];
                hasMore: boolean;
              }>("resources.list", { offset: 0, query: text });
              if (signal.aborted || text !== panel.searchQuery) return [];
              query = text;
              offset = 0;
              previous.length = 0;
              page = next;
              return choices();
            },
            enterAction: "inspect",
          },
        );
        if (picked.value === "prev") {
          offset = previous.pop() ?? 0;
          continue;
        }
        if (picked.value === "next") {
          previous.push(offset);
          offset += page.items.length;
          continue;
        }
        const item = page.items[Number(picked.value)];
        if (!item) continue;
        await panel.readDocument(
          `${item.kind} · ${item.name}`,
          [
            item.description,
            item.path ? `Path: ${item.path}` : "",
            item.kind === "Skill"
              ? "Ask the agent to use this skill. Listing a skill does not execute it."
              : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
          [],
        );
      }
    } catch (error) {
      if (!signal.aborted) this.view.setError(String(error));
    } finally {
      close();
    }
  }
}
