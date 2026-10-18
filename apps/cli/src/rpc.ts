import * as z from "zod";
import { commandDigest, isMutation } from "./rpc-receipts.ts";
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
  publicSession,
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
  controlQueued: number;
  controlBytes: number;
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
  const hostInstanceId = randomUUID();
  const pendingEffects = new Set<Promise<unknown>>();
  const track = (task: Promise<unknown>) => {
    pendingEffects.add(task);
    void task.finally(() => pendingEffects.delete(task)).catch(() => {});
  };
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
  let controlQueued = 0;
  let controlBytes = 0;
  let queued = 0;
  let queuedBytes = 0;
  let closed = false;
  let shuttingDown = false;
  const send = (message: Record<string, unknown>) => {
    if (closed) return;
    const line = JSON.stringify({ ...message, hostInstanceId }) + "\n";
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
    if (state.session?.id === next.id && state.agent) {
      state.session = next;
      return next;
    }
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
        controlQueued: 0,
        controlBytes: 0,
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
    const receiptKey = {
      workspace: runtime.options.cwd,
      scope,
      id,
      hostInstanceId,
    };
    const operationId =
      command.method === "session.compact" ? randomUUID() : undefined;
    let accepted = false;
    let settled = false;
    const finish = async (
      status: "completed" | "failed",
      fields: { sessionId?: string; runId?: string; error?: string } = {},
    ) => {
      await runtime.store.finishCommand({
        ...receiptKey,
        status,
        operationId,
        ...fields,
      });
      settled = true;
    };
    const uncertain = (error: unknown) => {
      transport.error.write(
        "Could not persist RPC command outcome; query receipt before any new attempt.\n",
      );
      send({
        type: "error",
        scope,
        commandId: id,
        error: `Command outcome unknown: ${String(error).slice(0, 4096)}`,
      });
    };
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
      if (isMutation(command.method)) {
        const claim = await runtime.store.acceptCommand({
          ...receiptKey,
          method: command.method,
          digest: commandDigest(command),
          sessionId:
            command.method === "session.create"
              ? null
              : typeof p.sessionId === "string"
                ? p.sessionId
                : (state.session?.id ?? null),
          operationId,
        });
        if (!claim.inserted) {
          send({
            id,
            type: "response",
            scope,
            result: { duplicate: true, receipt: claim.receipt },
          });
          return;
        }
        accepted = true;
        requireUncancelled();
      }
      switch (command.method) {
        case "hello": {
          const { protocolVersions } = HelloParams.parse(p);
          if (protocolVersions && !protocolVersions.includes(protocolVersion))
            throw Error(
              `Unsupported protocol version; host supports ${protocolVersion}`,
            );
          result = { ...rpcCapabilities(), hostInstanceId };
          break;
        }
        case "command.receipt":
          result = {
            receipt: await runtime.store.commandReceipt({
              ...receiptKey,
              id: z.string().min(1).max(128).parse(p.commandId),
            }),
          };
          break;
        case "session.current": {
          const selectedId = state.session?.id;
          if (selectedId) {
            const saved = await runtime.session(selectedId);
            requireLive(scope, state);
            if (state.session?.id === selectedId) state.session = saved;
          }
          result = {
            hostInstanceId,
            revision: state.revision,
            session: state.session ? publicSession(state.session) : null,
            ...(state.agent?.snapshot() ?? {
              busy: false,
              stream: "",
              streamTruncated: false,
              cursor: 0,
              runId: null,
              runStatus: "idle",
            }),
            approvals: [...approvals.values()]
              .filter((a) => a.scope === scope)
              .map((a) => a.request),
          };
          break;
        }
        case "session.create":
          result = publicSession(
            await bind(scope, state, await runtime.session()),
          );
          break;
        case "session.list":
          result = (
            await runtime.store.sessions(
              integer(p.offset, 0),
              integer(p.limit, 50, 100),
              runtime.options.cwd,
              z.string().max(200).optional().parse(p.query),
            )
          ).map(publicSession);
          break;
        case "session.delete": {
          const session = await selected();
          result = await runtime.deleteSession(session.id);
          for (const [clientScope, view] of scopes) {
            if (view.session?.id !== session.id) continue;
            view.unsubscribe?.();
            view.unsubscribe = undefined;
            view.session = undefined;
            view.agent = undefined;
            sendScoped({ type: "session.invalidated", scope: clientScope });
          }
          break;
        }
        case "workspace.current":
        case "session.rename":
        case "session.export":
        case "draft.read":
        case "draft.save":
        case "models.list":
        case "model.read":
        case "model.set":
        case "model.default":
        case "messages.content":
        case "artifact.read": {
          const { libraryRequest } = await import("./rpc-library.ts");
          result = await libraryRequest(runtime, command.method, p, selected);
          if (["session.rename", "model.set"].includes(command.method)) {
            const updated = await selected();
            for (const [clientScope, view] of scopes)
              if (view.session?.id === updated.id) {
                view.session = updated;
                sendScoped({ type: "session.invalidated", scope: clientScope });
              }
          }
          break;
        }
        case "session.resume":
          result = publicSession(await bind(scope, state, await selected()));
          break;
        case "session.fork": {
          const session = await selected();
          if ((await runtime.agent(session)).busy)
            throw Error("Stop the run before forking");
          result = publicSession(
            await bind(scope, state, await runtime.fork(session)),
          );
          break;
        }
        case "session.compact": {
          const session = await selected();
          const agent = await runtime.agent(session);
          requireUncancelled();
          if (state.work.operations.size >= 8)
            throw Error("Client operation capacity exceeded");
          const controller = new AbortController();
          let runId: string | undefined;
          const stopRunTracking = agent.subscribe((event) => {
            if (
              event.type === "run.start" &&
              event.data.operation === "compact" &&
              event.data.commandId === id &&
              event.data.scope === scope
            )
              runId = String(event.data.runId);
          });
          state.work.operations.add(controller);
          ownAgent(state.work, agent);
          track(
            runtime
              .compact(session, controller.signal, { scope, commandId: id })
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
                await finish("completed", {
                  sessionId: next.id,
                  runId,
                });
                if (scopes.get(scope) === state)
                  send({
                    type: "operation.completed",
                    scope,
                    operationId,
                    method: command.method,
                    result: publicSession(next),
                  });
              })
              .catch(async (error) => {
                try {
                  if (!settled)
                    await finish("failed", {
                      error: String(error).slice(0, 4096),
                      runId,
                    });
                } catch (storageError) {
                  uncertain(storageError);
                  return;
                }
                if (scopes.get(scope) === state)
                  send({
                    type: "operation.failed",
                    scope,
                    operationId,
                    method: command.method,
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
              })
              .finally(() => {
                stopRunTracking();
                state.work.operations.delete(controller);
                releaseWork(scope, state.work, agent);
              }),
          );
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
            bounded: true,
          });
          break;
        }
        case "events.read": {
          const session = await selected();
          const events = (
            await runtime.store.events(
              session.id,
              integer(p.after, 0),
              Math.max(1, integer(p.limit, 200, 1000)),
            )
          ).map(publicEvent);
          const page = [];
          let bytes = 2;
          for (const event of events) {
            const size = Buffer.byteLength(JSON.stringify(event)) + 1;
            if (bytes + size > 500000) {
              if (!page.length)
                throw Error(
                  "Event exceeds page capacity; use bounded message/artifact content APIs",
                );
              break;
            }
            page.push(event);
            bytes += size;
          }
          result = page;
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
          requireUncancelled();
          owners.set(session.id, scope);
          let runId: string | undefined;
          const stopRunTracking = agent.subscribe((event) => {
            if (
              event.type === "run.start" &&
              event.data.commandId === id &&
              event.data.scope === scope
            )
              runId = String(event.data.runId);
          });
          ownAgent(state.work, agent);
          track(
            agent
              .prompt(text, images, { scope, commandId: command.id })
              .then(async () => {
                await finish("completed", {
                  sessionId: session.id,
                  runId,
                });
              })
              .catch(async (error) => {
                try {
                  if (!settled)
                    await finish("failed", {
                      error: String(error).slice(0, 4096),
                      runId,
                    });
                } catch (storageError) {
                  uncertain(storageError);
                  return;
                }
                send({
                  type: "error",
                  scope,
                  error: String(error),
                  commandId: command.id,
                });
              })
              .finally(() => {
                stopRunTracking();
                releaseWork(scope, state.work, agent);
              }),
          );
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
      if (
        accepted &&
        command.method !== "prompt" &&
        command.method !== "session.compact"
      )
        await finish("completed", { sessionId: state.session?.id });
      send({ id, type: "response", scope, result });
    } catch (error) {
      if (accepted && !settled) {
        try {
          await finish("failed", { error: String(error).slice(0, 4096) });
        } catch (storageError) {
          uncertain(storageError);
        }
      }
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
      const bytes = Buffer.byteLength(JSON.stringify(raw));
      if (isControlMethod(command.method)) {
        // Durable controls can wait on SQLite. Bound that waiting work while
        // reserving space for cancellation, approval and detach replies.
        const critical = [
          "cancel",
          "approval.respond",
          "client.detach",
        ].includes(command.method);
        if (
          controlQueued >= (critical ? 80 : 64) ||
          state.controlQueued >= (critical ? 12 : 8) ||
          controlBytes + bytes > (critical ? 2_000_000 : 1_500_000) ||
          state.controlBytes + bytes > (critical ? 1_048_576 : 786_432)
        )
          throw Error("RPC control capacity exceeded");
        controlQueued++;
        controlBytes += bytes;
        state.controlQueued++;
        state.controlBytes += bytes;
        track(
          handle(command, state).finally(() => {
            controlQueued--;
            controlBytes -= bytes;
            state.controlQueued--;
            state.controlBytes -= bytes;
          }),
        );
        return;
      }
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
    await runtime.close(async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([
          ...pendingEffects,
          ...[...scopes.values()].map((state) => state.chain),
        ]),
        new Promise<void>((done) => {
          deadline = setTimeout(done, 5000);
        }),
      ]);
      clearTimeout(deadline);
    });
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
