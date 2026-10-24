import { vi } from "vitest";
import {
  createIdentity,
  randomToken,
  SecureChannel,
} from "../../packages/crypto/src/index.ts";
import { rpcCapabilities } from "../../packages/protocol/src/contracts.ts";
import type {
  DraftRecord,
  DraftStore,
} from "../../apps/mobile/src/composer.ts";
export const clock = {
  id: randomToken,
  schedule: (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};
export function fixture(
  hooks?: {
    request(frame: any): Promise<unknown>;
    subscribe(fn: (frame: any) => void): () => void;
  },
  content?: (params: any) => Promise<unknown>,
  snapshotPatch: Record<string, unknown> = {},
  capabilities = rpcCapabilities(true),
) {
  const host = createIdentity(),
    device = createIdentity();
  const pairing = {
    v: 1 as const,
    relay: "wss://fixture.example",
    hostId: randomToken(),
    deviceId: randomToken(),
    token: randomToken(),
    identity: device,
    hostKey: host.publicKey,
    expires: Date.now() + 300000,
  };
  let credential: string | null = null,
    active: any,
    dropMethod = "";
  let nextList: (() => Promise<unknown>) | undefined;
  let messageItems: unknown[] | undefined;
  let planRead: ((params: any) => Promise<unknown>) | undefined;
  let executionRead: ((params: any) => Promise<unknown>) | undefined;
  const readList = () => {
    const read = nextList;
    nextList = undefined;
    return read ? read() : [session];
  };
  const intents: any[] = [];
  const draftRows = new Map<string, DraftRecord>();
  const snapshots = new Map<string, unknown>();
  const drafts: DraftStore = {
    load: vi.fn(async (scope, id) =>
      structuredClone(
        id
          ? (draftRows.get(scope + id) ?? null)
          : ([...draftRows.entries()]
              .filter(([key]) => key.startsWith(scope))
              .at(-1)?.[1] ?? null),
      ),
    ),
    save: vi.fn(async (scope, record) => {
      draftRows.set(scope + record.session.id, structuredClone(record));
    }),
  };
  const sent: any[] = [];
  const session = {
    id: "s1",
    title: "共享任务",
    cwd: "/workspace",
    createdAt: 1,
  };
  let selected: any = session,
    revision = 0;
  const store = {
    drafts,
    snapshots: {
      load: vi.fn(async (scope: string) =>
        structuredClone(snapshots.get(scope) ?? null),
      ),
      save: vi.fn(async (scope: string, value: unknown) => {
        snapshots.set(scope, structuredClone(value));
      }),
      clear: vi.fn(async (scope: string) => {
        snapshots.delete(scope);
      }),
    },
    read: vi.fn(async () => credential),
    write: vi.fn(async (value: string) => {
      credential = value;
    }),
    erase: vi.fn(async () => {
      credential = null;
      draftRows.clear();
      snapshots.clear();
    }),
    journal: () => ({
      load: async () => intents.slice(),
      save: async (value: any[]) => {
        intents.splice(0, intents.length, ...value);
      },
    }),
    clear: vi.fn(async () => {
      intents.length = 0;
      draftRows.clear();
      snapshots.clear();
    }),
  };
  const socket = () => {
    const channel = new SecureChannel("host", host, device.publicKey);
    let release = () => {};
    const ws: any = {
      readyState: 1,
      bufferedAmount: 0,
      send(text: string) {
        if (text === "ping") return;
        const result = channel.receive(text);
        if (result.reply)
          queueMicrotask(() => ws.onmessage?.({ data: result.reply }));
        if (result.data) {
          const frame = result.data as any;
          sent.push(frame);
          const rpcResult =
            frame.method === "messages.content" && content
              ? content(frame.params)
              : frame.method === "plan.read" && planRead
                ? planRead(frame.params)
                : frame.method === "execution.read" && executionRead
                  ? executionRead(frame.params)
                  : hooks
                    ? hooks.request(frame)
                    : frame.method === "hello"
                      ? capabilities
                      : frame.method === "session.current"
                        ? {
                            session: selected,
                            sessionRole: "view",
                            busy: false,
                            stream: "",
                            streamTruncated: false,
                            cursor: 2,
                            revision,
                            runId: "run1",
                            runStatus: "completed",
                            approvals: [],
                            ...snapshotPatch,
                          }
                        : frame.method === "session.list"
                          ? readList()
                          : frame.method === "messages.read"
                            ? {
                                items: messageItems ?? [
                                  {
                                    seq: 2,
                                    message: {
                                      role: "assistant",
                                      text: "已恢复的结果",
                                      timestamp: 1,
                                    },
                                  },
                                ],
                                hasOlder: false,
                                hasNewer: false,
                              }
                            : frame.method === "session.resume"
                              ? (selected = session)
                              : frame.method === "run.cancel"
                                ? { accepted: true, runId: frame.params.runId }
                                : frame.method === "push.register"
                                  ? { ok: true }
                                  : { receipt: null };
          void Promise.resolve(rpcResult).then(
            (result) => {
              if (dropMethod === frame.method) {
                dropMethod = "";
                ws.close(1006);
                return;
              }
              if (ws.readyState === 1)
                ws.onmessage?.({
                  data: channel.send({
                    type: "response",
                    scope: pairing.deviceId,
                    id: frame.id,
                    result,
                  }),
                });
            },
            (error) => {
              if (ws.readyState === 1)
                ws.onmessage?.({
                  data: channel.send({
                    type: "response",
                    scope: pairing.deviceId,
                    id: frame.id,
                    error: String(error),
                  }),
                });
            },
          );
        }
      },
      close(code: number) {
        if (ws.readyState !== 1) return;
        ws.readyState = 3;
        release();
        ws.onclose?.({ code });
      },
    };
    if (hooks)
      release = hooks.subscribe((frame) => {
        if (frame.scope === pairing.deviceId && ws.readyState === 1)
          ws.onmessage?.({ data: channel.send(frame) });
      });
    active = ws;
    queueMicrotask(() => {
      ws.onopen?.();
      ws.onmessage?.({ data: channel.hello() });
    });
    return ws;
  };
  return {
    pairing,
    host,
    store,
    sent,
    options: {
      ...clock,
      probe: async () => "ready" as const,
      socketOptions: { socket, reconnectMs: 1, heartbeatMs: 60000 },
    },
    delayNextList: (read: () => Promise<unknown>) => {
      nextList = read;
    },
    setMessages: (items: unknown[]) => {
      messageItems = items;
    },
    setPlanRead: (read: (params: any) => Promise<unknown>) => {
      planRead = read;
    },
    setExecutionRead: (read: (params: any) => Promise<unknown>) => {
      executionRead = read;
    },
    uri: () => "hikaro://pair#" + encodeURIComponent(JSON.stringify(pairing)),
    dropResume: () => {
      dropMethod = "session.resume";
    },
    dropReply: (method: string) => {
      dropMethod = method;
    },
    close: (code: number) => active.close(code),
    get credential() {
      return credential;
    },
  };
}
