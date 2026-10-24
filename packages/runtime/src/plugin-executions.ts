import { randomUUID } from "node:crypto";
import type {
  PluginHost,
  Session,
  PluginExecutionContext,
} from "../../core/src/index.ts";
import type { SQLiteStore } from "../../storage/src/index.ts";
import type { Planning } from "./planning.ts";

export type PluginInvocation = { invocationId?: string; scope?: string };

/** Owns plugin execution leases and durable result recording. */
export class PluginExecutions {
  private active = new Map<
    string,
    {
      invocationId: string;
      scope: string;
      controller: AbortController;
      name: string;
    }
  >();
  get busy() {
    return this.active.size > 0;
  }
  current(sessionId: string) {
    const run = this.active.get(sessionId);
    return (
      run && {
        invocationId: run.invocationId,
        name: run.name,
        state: run.controller.signal.aborted ? "cancelling" : "running",
      }
    );
  }
  cancel(sessionId: string, invocationId: string, scope = "local") {
    const run = this.active.get(sessionId);
    if (!run || run.invocationId !== invocationId || run.scope !== scope)
      throw Error("Plugin invocation not found for this owner and session");
    run.controller.abort(
      Error("Plugin cancelled; execution has not yet settled"),
    );
    return { accepted: true, invocationId };
  }
  close() {
    for (const run of this.active.values())
      run.controller.abort(Error("Runtime is closing"));
  }
  constructor(
    private store: SQLiteStore,
    private plugins: PluginHost,
    private planning: Planning,
    private idle: (session: Session) => Promise<void>,
  ) {}
  async invoke(
    session: Session,
    name: string,
    kind: "command" | "view",
    args: string,
    origin: PluginInvocation = {},
  ) {
    await this.idle(session);
    const lease = await this.store.acquireLease(session.id, randomUUID());
    if (!lease) throw Error("Session is running elsewhere");
    const invocationId = origin.invocationId ?? randomUUID();
    const controller = new AbortController();
    this.active.set(session.id, {
      invocationId,
      scope: origin.scope ?? "local",
      controller,
      name,
    });
    let lost = false;
    const checkpoint = async () => {
      controller.signal.throwIfAborted();
      if (lost || !(await this.store.renewLease(session.id, lease))) {
        lost = true;
        controller.abort(
          Error(
            "Plugin outcome unknown: session lease lost; inspect host before retrying",
          ),
        );
      }
      controller.signal.throwIfAborted();
    };
    const context: PluginExecutionContext = {
      invocationId,
      sessionId: session.id,
      cwd: session.cwd,
      signal: controller.signal,
      checkpoint,
    };
    const timer = setInterval(() => {
      void this.store.renewLease(session.id, lease).then(
        (ok) => {
          if (!ok) {
            lost = true;
            controller.abort(Error("Session lease lost"));
          }
        },
        () => {
          lost = true;
          controller.abort(Error("Session lease renewal failed"));
        },
      );
    }, 10000);
    timer.unref();
    try {
      await this.planning.load(session.id, true);
      if (this.planning.get(session.id).active)
        throw Error(
          "Plugin commands and views are unavailable in read-only Plan mode",
        );
      await checkpoint();
      await this.store.append(
        session.id,
        "plugin.start",
        { invocationId, name, kind },
        lease,
      );
      const command = this.plugins.commands.get(name);
      const view = this.plugins.views.get(name);
      if (kind === "command" ? !command : !view)
        throw Error(`Unknown plugin ${kind}: ${name}`);
      const text =
        kind === "command"
          ? await command!(args, context)
          : await view!(context);
      await checkpoint();
      if (lost)
        throw Error(
          "Plugin outcome unknown: session lease lost; inspect host before retrying",
        );
      await this.store.append(
        session.id,
        "message",
        {
          message: {
            role: "assistant",
            text: `Plugin ${kind} /${name} result:\n\n${text}`,
            timestamp: Date.now(),
          },
        },
        lease,
      );
      await this.store.append(
        session.id,
        "plugin.end",
        { invocationId, name, status: "completed" },
        lease,
      );
      return text.length > 60000
        ? text.slice(0, 60000) +
            "\n\n[Preview limited; full result is saved in session history and /export.]"
        : text;
    } catch (error) {
      if (!lost)
        await this.store.append(
          session.id,
          "plugin.end",
          {
            invocationId,
            name,
            status: controller.signal.aborted ? "cancelled" : "failed",
          },
          lease,
        );
      throw error;
    } finally {
      this.active.delete(session.id);
      clearInterval(timer);
      await this.store.releaseLease(session.id, lease);
    }
  }
}
