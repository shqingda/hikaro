import { afterEach, expect, it, vi } from "vitest";
import { ClientConnection } from "../packages/client-core/src/connection.ts";
import { ClientState } from "../packages/client-core/src/index.ts";
import { rpcCapabilities } from "../packages/protocol/src/contracts.ts";

afterEach(() => vi.restoreAllMocks());

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
