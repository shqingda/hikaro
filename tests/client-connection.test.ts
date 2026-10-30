import { afterEach, expect, it, vi } from "vitest";
import { ClientConnection } from "../packages/client-core/src/connection.ts";
import { ClientState } from "../packages/client-core/src/index.ts";
import { rpcCapabilities } from "../packages/protocol/src/contracts.ts";

afterEach(() => vi.restoreAllMocks());

it("uses a caller command ID and rechecks authority after the durable journal commits", async () => {
  let receive!: (frame: unknown) => void;
  const sent: any[] = [];
  let release: (() => void) | undefined;
  let next = 0;
  const save = vi.fn((intents: unknown[]) =>
    intents.length === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          release = resolve;
        }),
  );
  const client = new ClientConnection(
    "device",
    {
      observe(fn) {
        receive = fn;
        return () => {};
      },
      send(frame) {
        sent.push(frame);
        const result =
          frame.method === "hello"
            ? {
                ...rpcCapabilities(),
                methods: [
                  "hello",
                  "session.current",
                  "approval.respond",
                  "command.receipt",
                ],
              }
            : frame.method === "approval.respond"
              ? { saved: true }
              : frame.method === "command.receipt"
                ? { receipt: null }
                : {
                    session: null,
                    busy: false,
                    stream: "",
                    streamTruncated: false,
                    cursor: 0,
                    revision: 0,
                    approvals: [],
                  };
        queueMicrotask(() =>
          receive({ type: "response", scope: "device", id: frame.id, result }),
        );
      },
    },
    {
      id: () => String(++next),
      schedule: () => () => {},
      intents: {
        load: async () => [],
        save,
      },
    },
  );
  // An already empty journal needs no write; mutations still wait for commit.
  await client.connected();
  expect(save).not.toHaveBeenCalled();
  let allowed = true;
  const guard = () => {
    if (!allowed) throw Error("selection changed");
  };
  const blocked = client.request(
    "approval.respond",
    { text: "old" },
    { id: "persisted-id", beforeSend: guard },
  );
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  allowed = false;
  release!();
  await expect(blocked).rejects.toThrow("selection changed");
  expect(sent.some((f) => f.id === "persisted-id")).toBe(false);
  await expect(
    client.request("approval.respond", {}, { id: "persisted-id" }),
  ).rejects.toThrow(/already used/);
  release = undefined;
  const success = client.request(
    "approval.respond",
    { text: "new" },
    { id: "new-id" },
  );
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  release!();
  await success;
  expect(sent.find((f) => f.id === "new-id")?.params).toEqual({ text: "new" });
  client.close();
});

it("retries failed journal writes and skips only successfully persisted identical intents", async () => {
  let receive!: (frame: unknown) => void;
  let next = 0;
  let completed = false;
  const sent: string[] = [];
  const save = vi.fn(async (_intents: unknown[]) => {});
  const client = new ClientConnection(
    "device",
    {
      observe(fn) {
        receive = fn;
        return () => {};
      },
      send(frame) {
        sent.push(frame.id);
        const result =
          frame.method === "hello"
            ? rpcCapabilities()
            : frame.method === "command.receipt"
              ? {
                  receipt: completed
                    ? {
                        id: "mutation",
                        scope: "device",
                        method: "approval.respond",
                        digest: "a".repeat(64),
                        hostInstanceId: "host",
                        sessionId: null,
                        status: "completed",
                        createdAt: 1,
                        updatedAt: 2,
                      }
                    : null,
                }
              : {
                  session: null,
                  busy: false,
                  stream: "",
                  streamTruncated: false,
                  cursor: 0,
                  revision: 0,
                  approvals: [],
                };
        queueMicrotask(() =>
          receive({ type: "response", scope: "device", id: frame.id, result }),
        );
      },
    },
    {
      id: () => String(++next),
      schedule: () => () => {},
      intents: { load: async () => [], save },
    },
  );
  try {
    await client.connected();
    expect(save).not.toHaveBeenCalled();
    save.mockRejectedValueOnce(Error("disk full"));
    await expect(
      client.request("approval.respond", {}, { id: "mutation" }),
    ).rejects.toThrow("disk full");
    expect(sent).not.toContain("mutation");
    await client.reconcile();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]![0]).toEqual(save.mock.calls[1]![0]);
    await client.reconcile();
    expect(save).toHaveBeenCalledTimes(2);
    completed = true;
    await client.reconcile();
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenLastCalledWith([]);
    await client.reconcile();
    expect(save).toHaveBeenCalledTimes(3);
  } finally {
    client.close();
  }
});

it("does not turn a successful mutation into a failure when an older host lacks receipt queries", async () => {
  let receive!: (frame: unknown) => void;
  const methods: string[] = [];
  let id = 0;
  const client = new ClientConnection(
    "device",
    {
      observe(fn) {
        receive = fn;
        return () => {};
      },
      send(frame) {
        methods.push(frame.method);
        const result =
          frame.method === "hello"
            ? {
                ...rpcCapabilities(),
                methods: ["hello", "session.current", "draft.save"],
              }
            : frame.method === "draft.save"
              ? { saved: true }
              : {
                  session: null,
                  busy: false,
                  stream: "",
                  streamTruncated: false,
                  cursor: 0,
                  revision: 0,
                  approvals: [],
                };
        queueMicrotask(() =>
          receive({ type: "response", scope: "device", id: frame.id, result }),
        );
      },
    },
    { id: () => String(++id), schedule: () => () => {} },
  );
  client.subscribe(() => {
    throw Error("broken view");
  });
  const snapshots = vi.spyOn(ClientState.prototype, "state", "get");
  await client.connected();
  expect(await client.request("draft.save", { text: "saved" })).toEqual({
    saved: true,
  });
  expect(methods).not.toContain("command.receipt");
  // Transport synchronization must not clone stream/history for boolean checks.
  expect(snapshots).not.toHaveBeenCalled();
  const snapshot = client.state;
  snapshot.canAct = false;
  snapshot.events.push({ seq: 999, type: "injected", timestamp: 0 });
  expect(client.state.canAct).toBe(true);
  expect(client.state.events).toEqual([]);
  client.close();
});

it("synchronizes a raw transport and fences interrupted commands without replay", async () => {
  let receive!: (frame: unknown) => void;
  const sent: any[] = [];
  let sequence = 0;
  const client = new ClientConnection(
    "device",
    {
      observe(fn) {
        receive = fn;
        return () => {};
      },
      send(frame) {
        sent.push(frame);
        if (frame.method === "prompt") return;
        queueMicrotask(() =>
          receive({
            type: "response",
            id: frame.id,
            scope: "device",
            result:
              frame.method === "hello"
                ? { ...rpcCapabilities(), hostInstanceId: "host" }
                : {
                    hostInstanceId: "host",
                    session: null,
                    busy: false,
                    stream: "",
                    streamTruncated: false,
                    cursor: 0,
                    revision: 0,
                    approvals: [],
                    runId: null,
                    runStatus: "idle",
                  },
          }),
        );
      },
    },
    { id: () => `command-${++sequence}`, schedule: () => () => {} },
  );
  await client.connected();
  expect(client.state.canAct).toBe(true);
  const pending = client.request("prompt", { text: "once" });
  const rejected = expect(pending).rejects.toThrow(/unknown/i);
  client.disconnected();
  await rejected;
  await client.connected();
  expect(sent.filter((f) => f.method === "prompt")).toHaveLength(1);
  expect(client.receipts.find((r) => r.method === "prompt")?.status).toBe(
    "unknown",
  );
  client.close();
});

it("durably records intent before send and fences a delayed write across connection epochs", async () => {
  let receive!: (frame: unknown) => void;
  const sent: any[] = [];
  let id = 0,
    commit!: () => void,
    block = false;
  const journal: Array<{ id: string; method: any }> = [];
  const client = new ClientConnection(
    "device",
    {
      observe(fn) {
        receive = fn;
        return () => {};
      },
      send(frame) {
        sent.push(frame);
        queueMicrotask(() =>
          receive({
            type: "response",
            scope: "device",
            id: frame.id,
            result:
              frame.method === "hello"
                ? rpcCapabilities()
                : frame.method === "command.receipt"
                  ? { receipt: null }
                  : {
                      session: null,
                      busy: false,
                      stream: "",
                      streamTruncated: false,
                      cursor: 0,
                      revision: 0,
                      approvals: [],
                    },
          }),
        );
      },
    },
    {
      id: () => String(++id),
      schedule: () => () => {},
      intents: {
        load: async () => [],
        async save(intents) {
          journal.splice(0, journal.length, ...intents);
          if (block)
            await new Promise<void>((done) => {
              commit = done;
            });
        },
      },
    },
  );
  await client.connected();
  block = true;
  const pending = client.request("prompt", { text: "must never be replayed" });
  const rejected = expect(pending).rejects.toThrow(/unknown/);
  await vi.waitFor(() => expect(commit).toBeTypeOf("function"));
  expect(journal).toEqual([{ id: expect.any(String), method: "prompt" }]);
  expect(sent.some((frame) => frame.method === "prompt")).toBe(false);
  client.disconnected();
  await rejected;
  block = false;
  const reconnect = client.connected();
  commit();
  await reconnect;
  expect(sent.some((frame) => frame.method === "prompt")).toBe(false);
  expect(
    client.receipts.find((receipt) => receipt.method === "prompt")?.status,
  ).toBe("unknown");
  client.close();
});

it("reclaims durable terminal receipts across more than 64 sequential runs", async () => {
  let receive!: (frame: unknown) => void;
  let id = 0;
  const durable = new Map<string, any>();
  const prompts: string[] = [];
  const client = new ClientConnection(
    "device",
    {
      observe(fn) {
        receive = fn;
        return () => {};
      },
      send(frame) {
        let result: unknown;
        if (frame.method === "hello") result = rpcCapabilities();
        else if (frame.method === "session.current")
          result = {
            session: null,
            busy: false,
            stream: "",
            streamTruncated: false,
            cursor: 0,
            revision: 0,
            approvals: [],
          };
        else if (frame.method === "prompt") {
          prompts.push(frame.id);
          durable.set(frame.id, {
            id: frame.id,
            scope: "device",
            method: "prompt",
            digest: "a".repeat(64),
            hostInstanceId: "host",
            sessionId: null,
            status: "accepted",
            createdAt: 1,
            updatedAt: 1,
          });
          result = { accepted: true };
        } else if (frame.method === "command.receipt") {
          result = {
            receipt: durable.get(String(frame.params.commandId)) ?? null,
          };
        }
        queueMicrotask(() =>
          receive({ type: "response", scope: "device", id: frame.id, result }),
        );
      },
    },
    { id: () => String(++id), schedule: () => () => {} },
  );
  try {
    await client.connected();
    for (let run = 0; run < 100; run++) {
      await client.request("prompt", { text: `run-${run}` });
      // The run finishes after the immediate acknowledgement receipt query.
      const receipt = durable.get(prompts.at(-1)!);
      receipt.status = run % 2 ? "failed" : "completed";
      receipt.updatedAt = 2;
    }
    expect(prompts).toHaveLength(100);
    expect(new Set(prompts).size).toBe(100);
    expect(client.receipts.length).toBeLessThanOrEqual(64);
  } finally {
    client.close();
  }
});
