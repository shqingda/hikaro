import { expect, it, vi } from "vitest";
import { ClientConnection } from "../packages/client-core/src/connection.ts";
import { rpcCapabilities } from "../packages/protocol/src/contracts.ts";

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
  await client.connected();
  expect(await client.request("draft.save", { text: "saved" })).toEqual({
    saved: true,
  });
  expect(methods).not.toContain("command.receipt");
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
