import { z } from "zod";
import {
  Runtime,
  type RuntimeOptions,
} from "../../../packages/runtime/src/index.ts";
import {
  Command,
  JsonLines,
  protocolVersion,
  publicEvent,
} from "../../../packages/protocol/src/index.ts";
import type {
  Session,
  Agent,
  PermissionRequest,
} from "../../../packages/core/src/index.ts";
const integer = (
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) =>
  z
    .number()
    .int()
    .min(0)
    .max(max)
    .parse(value ?? fallback);
type ScopeState = {
  session?: Session;
  agent?: Agent;
  unsubscribe?: () => void;
};
export async function serveRpc(options: Omit<RuntimeOptions, "approve">) {
  const approvals = new Map<
    string,
    {
      request: PermissionRequest;
      scope: string;
      finish: (allow: boolean) => void;
    }
  >();
  const scopes = new Map<string, ScopeState>();
  const owners = new Map<string, string>();
  let closed = false;
  let shuttingDown = false;
  const send = (message: unknown) => {
    if (closed) return;
    const line = JSON.stringify(message) + "\n";
    if (
      Buffer.byteLength(line) > 1_048_576 ||
      process.stdout.writableLength > 2_000_000
    ) {
      process.stderr.write(
        "RPC output capacity exceeded; inspect persisted session state before retrying.\n",
      );
      void shutdown();
      return;
    }
    process.stdout.write(line);
  };
  const runtime = await Runtime.open({
    ...options,
    approve: (request, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) {
          resolve(false);
          return;
        }
        const scope =
          request.scope ?? owners.get(request.sessionId) ?? "default";
        const abort = () => finish(false);
        const finish = (allow: boolean) => {
          signal.removeEventListener("abort", abort);
          approvals.delete(request.id);
          send({ type: "approval.resolved", scope, id: request.id, allow });
          resolve(allow);
        };
        approvals.set(request.id, { request, scope, finish });
        signal.addEventListener("abort", abort, { once: true });
        send({ type: "approval", scope, request });
      }),
  });
  runtime.startJobs();
  const bind = async (scope: string, state: ScopeState, next: Session) => {
    if (state.session?.id === next.id && state.agent) return next;
    state.unsubscribe?.();
    state.session = next;
    state.agent = await runtime.agent(next);
    state.unsubscribe = state.agent.subscribe((event) =>
      send({ type: "event", scope, event: publicEvent(event) }),
    );
    return next;
  };
  const getScope = (scope: string) => {
    let state = scopes.get(scope);
    if (!state) {
      if (scopes.size >= 32) throw Error("Client scope limit reached");
      state = {};
      scopes.set(scope, state);
    }
    return state;
  };
  let chain = Promise.resolve();
  const handle = async (raw: unknown) => {
    let id: unknown;
    let scope = "default";
    try {
      if (raw && typeof raw === "object" && "id" in raw) id = (raw as any).id;
      const command = Command.parse(raw);
      id = command.id;
      scope = command.scope ?? "default";
      const p = command.params;
      const state = getScope(scope);
      let result: unknown;
      const selected = async () => {
        const id = p.sessionId ?? state.session?.id;
        if (typeof id !== "string") throw Error("No session selected");
        return runtime.session(id);
      };
      switch (command.method) {
        case "session.current":
          result = {
            session: state.session ?? null,
            ...(state.agent?.snapshot() ?? {
              busy: false,
              stream: "",
              streamTruncated: false,
              cursor: 0,
            }),
            approvals: [...approvals.values()]
              .filter((a) => a.scope === scope)
              .map((a) => a.request),
          };
          break;
        case "session.create":
          result = await bind(scope, state, await runtime.session());
          break;
        case "session.list":
          result = await runtime.store.sessions(
            integer(p.offset, 0),
            integer(p.limit, 50, 100),
            runtime.options.cwd,
          );
          break;
        case "session.resume":
          result = await bind(scope, state, await selected());
          break;
        case "session.fork": {
          const session = await selected();
          if ((await runtime.agent(session)).busy)
            throw Error("Stop the run before forking");
          result = await bind(scope, state, await runtime.fork(session));
          break;
        }
        case "session.compact": {
          const session = await selected();
          result = await bind(scope, state, await runtime.compact(session));
          break;
        }
        case "messages.read": {
          const session = await selected();
          if (p.before !== undefined && p.after !== undefined)
            throw Error("Use before or after, not both");
          result = await runtime.store.messagePage(session.id, {
            before: p.before === undefined ? undefined : integer(p.before, 0),
            after: p.after === undefined ? undefined : integer(p.after, 0),
            limit: Math.max(1, integer(p.limit, 20, 100)),
          });
          break;
        }
        case "events.read": {
          const session = await selected();
          result = (
            await runtime.store.events(
              session.id,
              integer(p.after, 0),
              Math.max(1, integer(p.limit, 200, 1000)),
            )
          ).map(publicEvent);
          break;
        }
        case "prompt": {
          if (!state.agent || !state.session)
            throw Error("No session selected");
          const text = z.string().max(100000).parse(p.text);
          const images = z
            .array(
              z.object({
                mimeType: z.enum([
                  "image/png",
                  "image/jpeg",
                  "image/webp",
                  "image/gif",
                ]),
                data: z.string().max(900000),
              }),
            )
            .max(4)
            .optional()
            .parse(p.images);
          if (!text.trim() && !images?.length) throw Error("Prompt is empty");
          if (!(await runtime.store.claim(command.id, state.session.id))) {
            result = { duplicate: true };
            break;
          }
          owners.set(state.session.id, scope);
          void state.agent
            .prompt(text, images, { scope, commandId: command.id })
            .catch((error) => {
              send({
                type: "error",
                scope,
                error: String(error),
                commandId: command.id,
              });
            });
          result = { accepted: true };
          break;
        }
        case "steer":
          if (!state.agent) throw Error("No session selected");
          state.agent.steer(z.string().min(1).max(100000).parse(p.text));
          result = {};
          break;
        case "cancel":
          state.agent?.cancel();
          result = {};
          break;
        case "approval.respond": {
          const approval = approvals.get(z.string().parse(p.id));
          if (!approval || approval.scope !== scope)
            throw Error("Approval expired or belongs to another client");
          approval.finish(z.boolean().parse(p.allow));
          result = {};
          break;
        }
        case "client.detach": {
          if (p.cancel === true) state.agent?.cancel();
          state.unsubscribe?.();
          scopes.delete(scope);
          for (const approval of approvals.values())
            if (approval.scope === scope) approval.finish(false);
          result = {};
          break;
        }
      }
      send({ id, type: "response", scope, result });
    } catch (error) {
      send({
        id,
        type: "response",
        scope,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const parser = new JsonLines((raw) => {
    chain = chain.then(() => handle(raw));
  });
  process.stdin.on("data", (chunk) => {
    try {
      parser.push(chunk);
    } catch (error) {
      send({ type: "error", error: String(error) });
      void shutdown();
    }
  });
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const a of approvals.values()) a.finish(false);
    for (const state of scopes.values()) state.unsubscribe?.();
    await runtime.close();
    closed = true;
    process.stdin.destroy();
  }
  process.stdin.on("end", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  send({ type: "ready", protocolVersion });
}
