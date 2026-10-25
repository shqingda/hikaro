import * as z from "zod";
import { RpcWorkflows } from "./rpc-workflows.ts";
import { planExecutionPrompt } from "../../../packages/runtime/src/planning.ts";
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
  rpcReadMethods,
  HelloParams,
  rpcCapabilities,
  RunCancelParams,
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
  role?: "owner" | "view" | "control";
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
export type SharedRpcOptions = {
  instanceId: string;
  store: import("../../../packages/storage/src/index.ts").SQLiteStore;
  localScope(scope: string): boolean;
  pairedDevice(scope: string): Promise<boolean>;
  beforeClose?(): Promise<void>;
};
export async function serveRpc(
  options: Omit<RuntimeOptions, "approve">,
  transport: { input: Readable; output: Writable; error: Writable } = {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
  },
  shared?: SharedRpcOptions,
) {
  const hostInstanceId = shared?.instanceId ?? randomUUID();
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
  const controlsApproval = (
    scope: string,
    state: ScopeState,
    sessionId: string,
  ) =>
    state.session?.id === sessionId &&
    (!shared ||
      shared.localScope(scope) ||
      state.role === "owner" ||
      state.role === "control");
  const approvalRecipients = (sessionId: string, origin: string) =>
    [...scopes].filter(([scope, state]) =>
      shared ? controlsApproval(scope, state, sessionId) : scope === origin,
    );
  let workflows: RpcWorkflows;
  const runtime = await Runtime.open(
    {
      ...options,
      askUser: (questions, signal, sessionId, scope) =>
        workflows.ask(questions, signal, sessionId, scope),
      approve: (request, signal) =>
        new Promise((resolve) => {
          if (signal.aborted) {
            resolve(false);
            return;
          }
          if (shared)
            request = {
              ...request,
              authoritySessionId: runtime.approvalAuthority(request.sessionId),
            };
          const scope =
            request.scope ?? owners.get(request.sessionId) ?? "default";
          const abort = () => finish(false);
          const finish = (allow: boolean) => {
            signal.removeEventListener("abort", abort);
            approvals.delete(request.id);
            for (const [recipient] of approvalRecipients(
              request.authoritySessionId ?? request.sessionId,
              scope,
            ))
              sendScoped({
                type: "approval.resolved",
                scope: recipient,
                id: request.id,
                allow,
              });
            resolve(allow);
          };
          approvals.set(request.id, { request, scope, finish });
          signal.addEventListener("abort", abort, { once: true });
          for (const [recipient] of approvalRecipients(
            request.authoritySessionId ?? request.sessionId,
            scope,
          ))
            sendScoped({ type: "approval", scope: recipient, request });
        }),
    },
    shared?.store,
  );
  workflows = new RpcWorkflows(runtime, hostInstanceId, !!shared);
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
    const role = shared
      ? await runtime.store.attachView(
          runtime.options.cwd,
          scope,
          next.id,
          shared.localScope(scope),
        )
      : null;
    requireLive(scope, state);
    expected?.signal.throwIfAborted();
    if (expected && state.session?.id !== expected.sessionId) return next;
    state.unsubscribe?.();
    state.session = next;
    state.role = role ?? undefined;
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
  const cancel = (
    state: ScopeState,
    includeSelected = true,
    revokedScope?: string,
    preserveRecovered = false,
  ) => {
    state.generation++;
    for (const operation of state.work.operations) operation.abort();
    for (const agent of state.work.activeAgents.keys()) {
      if (shared && revokedScope) agent.cancelScope(revokedScope);
      else agent.cancel(preserveRecovered);
    }
    if (includeSelected) state.agent?.cancel(preserveRecovered);
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
  const revokeClient = async (scope: string) => {
    if (!shared || shared.localScope(scope)) return;
    const state = scopes.get(scope);
    if (state) {
      cancel(state, false, scope);
      state.unsubscribe?.();
      state.unsubscribe = undefined;
      state.session = undefined;
      state.agent = undefined;
      state.role = undefined;
      for (const approval of approvals.values())
        if (approval.scope === scope) approval.finish(false);
      sendScoped({ type: "session.invalidated", scope });
    }
    await runtime.store.revokeScope(runtime.options.cwd, scope);
    if (state) {
      scopes.delete(scope);
      releaseWork(scope, state.work);
    }
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
      if (
        shared &&
        !shared.localScope(scope) &&
        command.method !== "client.detach" &&
        !(await shared.pairedDevice(scope))
      ) {
        await revokeClient(scope);
        throw Error("Device is not confirmed and paired");
      }
      const requireUncancelled = () => {
        requireLive(scope, state);
        if (state.generation !== generation) throw Error("Request cancelled");
      };
      const p = command.params;
      let result: unknown;
      const selected = async () => {
        const id = p.sessionId ?? state.session?.id;
        if (typeof id !== "string") throw Error("No session selected");
        const session = await runtime.session(id);
        if (shared && !shared.localScope(scope)) {
          const role = await runtime.store.sessionRole(
            runtime.options.cwd,
            session.id,
            scope,
          );
          const read =
            rpcReadMethods.has(command.method) ||
            command.method === "session.resume";
          if (!role || (!read && role === "view"))
            throw Error("Session access denied");
        }
        return session;
      };
      let requireSameSelection = () => {};
      if (shared) {
        if (
          [
            "session.access",
            "session.access.read",
            "model.default",
            "permissions.set",
            "providers.reload",
            "resources.list",
            "resources.reload",
            "resources.install",
            "storage.preview",
            "storage.cleanup",
            "plugins.list",
            "plugins.invoke",
            "plugins.cancel",
            "tool.manual",
            "session.export.file",
          ].includes(command.method) &&
          !shared.localScope(scope)
        )
          throw Error(
            "Only local owner clients can manage host access or defaults",
          );
        if (
          [
            "prompt",
            "steer",
            "cancel",
            "run.cancel",
            "plugins.cancel",
            "tool.manual",
            "plugins.invoke",
            "plugins.cancel",
          ].includes(command.method) ||
          /^(changes|execution|plan|questions|storage)\./.test(command.method)
        ) {
          const sessionId = state.session?.id,
            agent = state.agent;
          requireSameSelection = () => {
            if (
              state.session?.id !== sessionId ||
              state.agent !== agent ||
              (!shared.localScope(scope) &&
                !rpcReadMethods.has(command.method) &&
                state.role !== "owner" &&
                state.role !== "control")
            )
              throw Error(
                "Selection changed or session control revoked while command was pending",
              );
          };
          if (p.sessionId !== undefined && p.sessionId !== state.session?.id)
            throw Error("Command must target the selected session");
          await selected();
        }
      }
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
      // Controls bypass the ordinary per-scope queue. Receipt persistence can
      // yield to a resume or grant change; never act on the replacement view.
      requireSameSelection();
      switch (command.method) {
        case "session.export.file":
          result = {
            path: await runtime.exportSession(
              (await selected()).id,
              z.boolean().parse(p.includeThinking ?? false),
            ),
          };
          break;
        case "plugins.list":
          result = {
            items: [...runtime.plugins.commands.keys()]
              .map((name) => ({ name, kind: "command" }))
              .concat(
                [...runtime.plugins.views.keys()].map((name) => ({
                  name,
                  kind: "view",
                })),
              ),
          };
          if (Buffer.byteLength(JSON.stringify(result)) > 256000)
            throw Error("Plugin catalog exceeds display capacity");
          break;
        case "plugins.cancel": {
          const session = await selected();
          requireSameSelection();
          result = runtime.pluginRuns.cancel(
            session.id,
            z.string().min(1).max(128).parse(p.invocationId),
            scope,
          );
          break;
        }
        case "plugins.invoke": {
          const session = await selected();
          if (state.session?.id !== session.id) throw Error("Session changed");
          requireSameSelection();
          result = {
            text: await runtime.invokePlugin(
              session,
              z.string().min(1).max(256).parse(p.name),
              z
                .enum(["command", "view"])
                .parse(
                  p.kind ??
                    (runtime.plugins.commands.has(String(p.name))
                      ? "command"
                      : "view"),
                ),
              z
                .string()
                .max(100000)
                .parse(p.args ?? ""),
              {
                invocationId: z
                  .string()
                  .min(1)
                  .max(128)
                  .parse(p.invocationId ?? id),
                scope,
              },
            ),
          };
          break;
        }
        case "tool.manual": {
          const session = await selected();
          if (state.session?.id !== session.id || !state.agent)
            throw Error("Session changed");
          const agent = state.agent;
          const text = z.string().trim().min(1).max(100000).parse(p.command);
          requireSameSelection();
          owners.set(session.id, scope);
          ownAgent(state.work, agent);
          try {
            const outcome = await agent.executeTool(
              "shell",
              {
                command: text,
                unrestricted: z.boolean().parse(p.unrestricted ?? false),
              },
              "!" + text,
              { scope, commandId: id },
            );
            result = { isError: outcome.isError ?? false };
          } finally {
            releaseWork(scope, state.work, agent);
          }
          break;
        }

        case "changes.review.list":
        case "changes.review.diff":
        case "changes.list":
        case "changes.detail":
        case "changes.diff":
        case "changes.rollback":
        case "changes.redo":
        case "execution.hold":
        case "execution.release":
        case "execution.read":
        case "execution.history":
        case "execution.history.detail":
        case "execution.action":
        case "plan.history":
        case "plan.version":
        case "plan.evidence":
        case "plan.read":
        case "plan.set":
        case "questions.read":
        case "questions.draft.read":
        case "questions.draft.save":
        case "questions.respond": {
          const session = await selected();
          if (state.session?.id !== session.id || !state.agent)
            throw Error("Command must target the selected session");
          requireSameSelection();
          requireUncancelled();
          result = await workflows.handle(
            command.method,
            p,
            session,
            state.agent,
            scope,
          );
          break;
        }
        case "hello": {
          const { protocolVersions } = HelloParams.parse(p);
          if (protocolVersions && !protocolVersions.includes(protocolVersion))
            throw Error(
              `Unsupported protocol version; host supports ${protocolVersion}`,
            );
          result = { ...rpcCapabilities(!!shared), hostInstanceId };
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
          if (shared && !state.session) {
            const savedId = await runtime.store.clientView(
              runtime.options.cwd,
              scope,
            );
            if (savedId) {
              const role = await runtime.store.sessionRole(
                runtime.options.cwd,
                savedId,
                scope,
              );
              if (shared.localScope(scope) || role)
                await bind(scope, state, await runtime.session(savedId));
            }
          }
          const selectedId = state.session?.id;
          if (selectedId) {
            const saved = await runtime.session(selectedId);
            requireLive(scope, state);
            if (state.session?.id === selectedId) state.session = saved;
          }
          result = {
            hostInstanceId,
            sessionRole: state.session
              ? shared?.localScope(scope)
                ? "owner"
                : (state.role ?? "owner")
              : null,
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
              .filter((a) =>
                shared
                  ? controlsApproval(
                      scope,
                      state,
                      a.request.authoritySessionId ?? a.request.sessionId,
                    )
                  : a.scope === scope,
              )
              .map((a) => a.request),
          };
          break;
        }
        case "session.create": {
          const session = await runtime.session();
          if (shared)
            await runtime.store.setSessionAccess(
              runtime.options.cwd,
              session.id,
              scope,
              "owner",
            );
          result = publicSession(await bind(scope, state, session));
          break;
        }
        case "session.access.read": {
          if (!shared) throw Error("Shared host required");
          const session = await selected();
          result = await runtime.store.sessionAccess(
            runtime.options.cwd,
            session.id,
          );
          break;
        }
        case "session.access": {
          if (!shared) throw Error("Shared host required");
          const session = await selected();
          const device = z
            .string()
            .regex(/^[A-Za-z0-9_-]{43}$/)
            .parse(p.deviceId);
          const role = z.enum(["view", "control"]).nullable().parse(p.role);
          if (role && !(await shared.pairedDevice(device)))
            throw Error("Device is not confirmed and paired");
          await runtime.store.setSessionAccess(
            runtime.options.cwd,
            session.id,
            device,
            role,
          );
          const target = scopes.get(device);
          if (target?.session?.id === session.id) {
            target.role = role ?? undefined;
            if (!role) {
              target.unsubscribe?.();
              target.unsubscribe = undefined;
              target.session = undefined;
              target.agent = undefined;
            }
            sendScoped({ type: "session.invalidated", scope: device });
          }
          result = {};
          break;
        }
        case "session.list":
          result = (
            await runtime.store.sessions(
              integer(p.offset, 0),
              integer(p.limit, 50, 100),
              runtime.options.cwd,
              z.string().max(200).optional().parse(p.query),
              shared && !shared.localScope(scope) ? scope : undefined,
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
        case "providers.reload":
        case "permissions.set":
        case "resources.reload":
        case "resources.install":
        case "resources.list": {
          const { configurationRequest } =
            await import("./rpc-configuration.ts");
          result = await configurationRequest(runtime, command.method, p);
          break;
        }
        case "storage.preview":
        case "storage.cleanup": {
          const session = await selected();
          requireUncancelled();
          requireSameSelection();
          result =
            command.method === "storage.preview"
              ? await runtime.previewCleanup(session.id)
              : await runtime.cleanupStorage(
                  session.id,
                  z
                    .string()
                    .regex(/^[a-f0-9]{64}$/)
                    .parse(p.token),
                );
          break;
        }
        case "workspace.current":
        case "session.rename":
        case "session.export":
        case "draft.read":
        case "draft.save":
        case "models.list":
        case "model.capabilities":
        case "model.read":
        case "model.set":
        case "model.default":
        case "messages.content":
        case "messages.search":
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
          const next = await runtime.fork(session);
          if (shared)
            await runtime.store.setSessionAccess(
              runtime.options.cwd,
              next.id,
              scope,
              "owner",
            );
          result = publicSession(await bind(scope, state, next));
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
                if (shared)
                  await runtime.store.setSessionAccess(
                    runtime.options.cwd,
                    next.id,
                    scope,
                    "owner",
                  );
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
        case "plan.execute":
          if (!state.session || !state.agent)
            throw Error("No session selected");
          {
            const approved = await runtime.approvePlan(
              state.session,
              z.string().uuid().parse(p.id),
            );
            requireSameSelection();
            requireUncancelled();
            p.text = planExecutionPrompt(approved);
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
          let accepted: Awaited<ReturnType<Agent["enqueuePrompt"]>>;
          try {
            accepted = await agent.enqueuePrompt(text, images, {
              scope,
              commandId: command.id,
            });
          } catch (error) {
            stopRunTracking();
            releaseWork(scope, state.work, agent);
            throw error;
          }
          track(
            accepted.completion
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
          await state.agent.steer(
            z.string().min(1).max(100000).parse(p.text),
            scope,
          );
          result = {};
          break;
        case "cancel":
          cancel(state);
          result = {};
          break;
        case "run.cancel": {
          const { sessionId, runId } = RunCancelParams.parse(p);
          const agent = state.agent;
          if (!agent || state.session?.id !== sessionId)
            throw Error("Command must target the selected session");
          const current = agent.snapshot();
          if (
            !current.busy ||
            current.runStatus !== "running" ||
            current.runId !== runId
          )
            throw Error(
              "Run is no longer active; refresh before deciding again",
            );
          // Do not yield between checking the run and aborting it. Scope-wide
          // cancellation could also stop unrelated work in another session.
          agent.cancel();
          await finish("completed", { sessionId, runId });
          result = { accepted: true, runId };
          break;
        }
        case "approval.respond": {
          const approval = approvals.get(z.string().parse(p.id));
          if (!approval)
            throw Error("Approval expired or belongs to another client");
          if (shared) {
            const role = await runtime.store.sessionRole(
              runtime.options.cwd,
              approval.request.authoritySessionId ?? approval.request.sessionId,
              scope,
            );
            if (
              (!shared.localScope(scope) &&
                role !== "owner" &&
                role !== "control") ||
              state.session?.id !==
                (approval.request.authoritySessionId ??
                  approval.request.sessionId) ||
              approvals.get(approval.request.id) !== approval
            )
              throw Error("Approval expired or session control denied");
          } else if (approval.scope !== scope)
            throw Error("Approval expired or belongs to another client");
          approval.finish(z.boolean().parse(p.allow));
          result = {};
          break;
        }
        case "client.detach": {
          if (p.cancel === true) cancel(state, false, scope);
          state.unsubscribe?.();
          for (const approval of approvals.values())
            if (approval.scope === scope && (!shared || p.cancel === true))
              approval.finish(false);
          if (shared && p.cancel === true)
            await runtime.store.revokeScope(runtime.options.cwd, scope);
          scopes.delete(scope);
          releaseWork(scope, state.work);
          result = {};
          break;
        }
      }
      if (
        accepted &&
        !settled &&
        command.method !== "prompt" &&
        command.method !== "plan.execute" &&
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
          "run.cancel",
          "plugins.cancel",
          "approval.respond",
          "questions.respond",
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
    workflows.close();
    for (const a of approvals.values()) a.finish(false);
    for (const state of scopes.values()) {
      cancel(state, true, undefined, true);
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
      await shared?.beforeClose?.();
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
  return {
    close: shutdown,
    revokeClient,
    remoteScopes: () =>
      [...scopes.keys()].filter((scope) => !shared?.localScope(scope)),
  };
}
