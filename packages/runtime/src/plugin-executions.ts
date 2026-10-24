import { randomUUID } from "node:crypto";
import type { PluginHost, Session } from "../../core/src/index.ts";
import type { SQLiteStore } from "../../storage/src/index.ts";
import type { Planning } from "./planning.ts";

/** Owns plugin execution leases and durable result recording. */
export class PluginExecutions {
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
  ) {
    await this.idle(session);
    const lease = await this.store.acquireLease(session.id, randomUUID());
    if (!lease) throw Error("Session is running elsewhere");
    let lost = false;
    const timer = setInterval(() => {
      void this.store.renewLease(session.id, lease).then(
        (ok) => {
          if (!ok) lost = true;
        },
        () => {
          lost = true;
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
      const run =
        kind === "command"
          ? this.plugins.commands.get(name)
          : this.plugins.views.get(name);
      if (!run) throw Error(`Unknown plugin ${kind}: ${name}`);
      const text = await run(args);
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
      return text.length > 60000
        ? text.slice(0, 60000) +
            "\n\n[Preview limited; full result is saved in session history and /export.]"
        : text;
    } finally {
      clearInterval(timer);
      await this.store.releaseLease(session.id, lease);
    }
  }
}
