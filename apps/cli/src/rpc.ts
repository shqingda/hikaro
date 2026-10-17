import * as z from "zod";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  Runtime,
  type RuntimeOptions,
} from "../../../packages/runtime/src/index.ts";
import {
  Command,
  JsonLines,
  protocolVersion,
  publicEvent,
  isControlMethod,
} from "../../../packages/protocol/src/index.ts";
import type {
  Session,
  Agent,
  PermissionRequest,
} from "../../../packages/core/src/index.ts";
import {
  HelloParams,
  rpcCapabilities,
} from "../../../packages/protocol/src/contracts.ts";
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
type ScopeWork = {
  activeAgents: Map<Agent, number>;
  operations: Set<AbortController>;
};
type ScopeState = {
  revision: number;
  session?: Session;
  agent?: Agent;
  unsubscribe?: () => void;
  chain: Promise<void>;
  queued: number;
  bytes: number;
  generation: number;
  work: ScopeWork;
};
export async function serveRpc(
  options: Omit<RuntimeOptions, "approve">,
  transport: { input: Readable; output: Writable; error: Writable } = {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
  },
) {
  const approvals = new Map<
    string,
    {
      request: PermissionRequest;
      scope: string;
      finish: (allow: boolean) => void;
    }
  >();
  const scopes = new Map<string, ScopeState>();
  // Detaching a view may leave work running; revocation must still find it.
  const ownedWork = new Map<string, ScopeWork>();
  const owners = new Map<string, string>();
  let queued = 0;
  let queuedBytes = 0;
  let closed = false;
  let shuttingDown = false;
  const send = (message: unknown) => {
    if (closed) return;
    const line = JSON.stringify(message) + "\n";
    if (
      Buffer.byteLength(line) > 1_048_576 ||
      transport.output.writableLength > 2_000_000
    ) {
      transport.error.write(
        "RPC output capacity exceeded; inspect persisted session state before retrying.\n",
      );
      void shutdown();
      return;
    }
    transport.output.write(line);
  };
  const sendScoped = (message: {
    type: string;
    scope: string;
    [key: string]: unknown;
  }) => {
    const state = scopes.get(message.scope);
    // Detached views have no delivery revision; a later snapshot restores any
    // still-pending approval when that scope attaches again.
    if (!state) return;
    send({ ...message, revision: ++state.revision });
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
          sendScoped({
            type: "approval.resolved",
            scope,
            id: request.id,
            allow,
          });
          resolve(allow);
        };
        approvals.set(request.id, { request, scope, finish });
        signal.addEventListener("abort", abort, { once: true });
        sendScoped({ type: "approval", scope, request });
      }),
  });
  runtime.startJobs();
  const requireLive = (scope: string, state: ScopeState) => {
    if (shuttingDown || scopes.get(scope) !== state)
      throw Error("Client scope detached");
  };
  const bind = async (
    scope: string,
    state: ScopeState,
    next: Session,
    expected?: { sessionId: string; signal: AbortSignal },
  ) => {
    requireLive(scope, state);
    expected?.signal.throwIfAborted();
    if (state.session?.id === next.id && state.agent) return next;
    const agent = await runtime.agent(next);
    requireLive(scope, state);
    expected?.signal.throwIfAborted();
    if (expected && state.session?.id !== expected.sessionId) return next;
    state.unsubscribe?.();
    state.session = next;
    state.agent = agent;
    state.unsubscribe = state.agent.subscribe((event) =>
      sendScoped({ type: "event", scope, event: publicEvent(event) }),
    );
    return next;
  };
  const getScope = (scope: string) => {
    let state = scopes.get(scope);
    if (!state) {
      if (scopes.size >= 32) throw Error("Client scope limit reached");
      let work = ownedWork.get(scope);
      if (!work) {
        if (ownedWork.size >= 32) throw Error("Client scope limit reached");
        work = { activeAgents: new Map(), operations: new Set() };
        ownedWork.set(scope, work);
      }
      state = {
        revision: 0,
        chain: Promise.resolve(),
        queued: 0,
        bytes: 0,
        generation: 0,
        work,
      };
      scopes.set(scope, state);
    }
    return state;
  };
  const cancel = (state: ScopeState, includeSelected = true) => {
    state.generation++;
    for (const operation of state.work.operations) operation.abort();
    for (const agent of state.work.activeAgents.keys()) agent.cancel();
    if (includeSelected) state.agent?.cancel();
  };
  const releaseWork = (scope: string, work: ScopeWork, agent?: Agent) => {
    if (agent) {
      const remaining = (work.activeAgents.get(agent) ?? 1) - 1;
      if (remaining) work.activeAgents.set(agent, remaining);
      else work.activeAgents.delete(agent);
    }
    if (
      !work.activeAgents.size &&
      !work.operations.size &&
      scopes.get(scope)?.work !== work
    )
      ownedWork.delete(scope);
  };
  const ownAgent = (work: ScopeWork, agent: Agent) => {
    work.activeAgents.set(agent, (work.activeAgents.get(agent) ?? 0) + 1);
  };
  const handle = async (
    command: Command,
    state: ScopeState,
    generation = state.generation,
  ) => {
    const { id } = command;
    const scope = command.scope ?? "default";
    try {
      requireLive(scope, state);
      const requireUncancelled = () => {
        requireLive(scope, state);
        if (state.generation !== generation) throw Error("Request cancelled");
      };
      const p = command.params;
      let result: unknown;
      const selected = async () => {
        const id = p.sessionId ?? state.session?.id;
        if (typeof id !== "string") throw Error("No session selected");
        return runtime.session(id);
      };
      switch (command.method) {
        case "hello": {
          const { protocolVersions } = HelloParams.parse(p);
          if (protocolVersions && !protocolVersions.includes(protocolVersion))
            throw Error(
              `Unsupported protocol version; host supports ${protocolVersion}`,
            );
          result = rpcCapabilities();
          break;
        }
        case "session.current":
          result = {
            revision: state.revision,
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
          const agent = await runtime.agent(session);
          requireUncancelled();
          if (state.work.operations.size >= 8)
            throw Error("Client operation capacity exceeded");
          const operationId = randomUUID();
          const controller = new AbortController();
          state.work.operations.add(controller);
          ownAgent(state.work, agent);
          void runtime
            .compact(session, controller.signal)
            .then(async (next) => {
              controller.signal.throwIfAborted();
              // A completed summary must not change a newer selection.
              if (
                scopes.get(scope) === state &&
                state.session?.id === session.id
              )
                await bind(scope, state, next, {
                  sessionId: session.id,
                  signal: controller.signal,
                });
              if (scopes.get(scope) === state)
                send({
                  type: "operation.completed",
                  scope,
                  operationId,
                  method: command.method,
                  result: next,
                });
            })
            .catch((error) => {
              if (scopes.get(scope) === state)
                send({
                  type: "operation.failed",
                  scope,
                  operationId,
                  method: command.method,
                  error: error instanceof Error ? error.message : String(error),
                });
            })
            .finally(() => {
              state.work.operations.delete(controller);
              releaseWork(scope, state.work, agent);
            });
          result = { accepted: true, operationId };
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
          if (images?.length) {
            const { validateImageInputs } =
              await import("../../../packages/runtime/src/attachments.ts");
            validateImageInputs(images);
          }
          if (!text.trim() && !images?.length) throw Error("Prompt is empty");
          const { agent, session } = state;
          if (!(await runtime.store.claim(command.id, session.id))) {
            result = { duplicate: true };
            break;
          }
          requireUncancelled();
          owners.set(session.id, scope);
          ownAgent(state.work, agent);
          void agent
            .prompt(text, images, { scope, commandId: command.id })
            .catch((error) => {
              send({
                type: "error",
                scope,
                error: String(error),
                commandId: command.id,
              });
            })
            .finally(() => releaseWork(scope, state.work, agent));
          result = { accepted: true };
          break;
        }
        case "steer":
          if (!state.agent) throw Error("No session selected");
          state.agent.steer(z.string().min(1).max(100000).parse(p.text));
          result = {};
          break;
        case "cancel":
          cancel(state);
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
          if (p.cancel === true) cancel(state, false);
          state.unsubscribe?.();
          for (const approval of approvals.values())
            if (approval.scope === scope) approval.finish(false);
          scopes.delete(scope);
          releaseWork(scope, state.work);
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
    if (shuttingDown) return;
    let command: Command;
    try {
      command = Command.parse(raw);
      const scope = command.scope ?? "default";
      const state = getScope(scope);
      if (isControlMethod(command.method)) {
        void handle(command, state);
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(raw));
      if (
        queued >= 128 ||
        queuedBytes + bytes > 2_000_000 ||
        state.queued >= 32 ||
        state.bytes + bytes > 1_048_576
      )
        throw Error("RPC request queue capacity exceeded");
      queued++;
      queuedBytes += bytes;
      state.queued++;
      state.bytes += bytes;
      const generation = state.generation;
      state.chain = state.chain
        .then(() => handle(command, state, generation))
        .finally(() => {
          queued--;
          queuedBytes -= bytes;
          state.queued--;
          state.bytes -= bytes;
        });
    } catch (error) {
      const rawCommand =
        raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      send({
        id: rawCommand.id,
        type: "response",
        scope:
          typeof rawCommand.scope === "string" ? rawCommand.scope : "default",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  transport.input.on("data", (chunk) => {
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
    for (const state of scopes.values()) {
      cancel(state);
      state.unsubscribe?.();
    }
    for (const work of ownedWork.values())
      for (const operation of work.operations) operation.abort();
    await runtime.close();
    closed = true;
    transport.input.destroy();
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  const onSignal = () => void shutdown();
  transport.input.on("end", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  send({ type: "ready", protocolVersion });
  return { close: shutdown };
}
