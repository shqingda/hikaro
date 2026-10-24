import { expect, it, vi } from "vitest";
import {
  MobileSteering,
  type SteeringConnection,
} from "../apps/mobile/src/steering.ts";

const item = {
  id: "one",
  title: "1. original",
  state: "Pending next model turn",
  detail: "original",
  editText: "original",
  actions: ["edit", "first", "remove", "resume"].map((value) => ({
    value,
    label: value,
  })),
};
function fixture() {
  let timer: (() => void) | undefined;
  const cancel = vi.fn(() => {
    timer = undefined;
  });
  const state: SteeringConnection["state"] = {
    canAct: true,
    session: { id: "s1" },
    sessionRole: "control",
  };
  const request = vi.fn<SteeringConnection["request"]>(
    async (method, params, options) => {
      options?.beforeSend?.();
      if (method === "execution.hold") return { token: "hold" };
      if (method === "execution.read") return params?.id ? item : [item];
      return { completed: true };
    },
  );
  const client = { state, request };
  const manager = new MobileSteering(
    () => {},
    (fn) => {
      timer = fn;
      return cancel;
    },
  );
  manager.bind(client);
  return {
    manager,
    client,
    request,
    cancel,
    tick: () => {
      const fn = timer;
      timer = undefined;
      fn?.();
    },
  };
}
it("renews only an open manager and releases its hold on close", async () => {
  const f = fixture();
  await f.manager.open("s1");
  expect(f.manager.state.items).toHaveLength(1);
  const before = f.request.mock.calls.length;
  f.tick();
  await vi.waitFor(() =>
    expect(f.request.mock.calls.length).toBeGreaterThan(before),
  );
  await f.manager.close();
  expect(
    f.request.mock.calls.filter(([m]) => m === "execution.release"),
  ).toHaveLength(1);
  const after = f.request.mock.calls.length;
  f.tick();
  expect(f.request.mock.calls).toHaveLength(after);
  expect(f.manager.state.open).toBe(false);
});
it("releases a late hold without reopening after background or a task change", async () => {
  const f = fixture();
  let release!: (value: unknown) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const opening = f.manager.open("s1");
  await f.manager.close();
  release({ token: "late" });
  await opening;
  expect(f.manager.state.open).toBe(false);
  expect(
    f.request.mock.calls.some(
      ([m, p]) => m === "execution.release" && p?.token === "late",
    ),
  ).toBe(true);
  await f.manager.open("s1");
  await f.manager.inspect("one");
  f.client.state.session = { id: "s2" };
  await expect(f.manager.act("one", "remove")).rejects.toThrow(
    /changed|control/i,
  );
  expect(
    f.request.mock.calls.filter(([m]) => m === "execution.action"),
  ).toHaveLength(0);
  f.manager.bind(null);
});
it("retains failed edits, rejects stale authority after journal waits and never retries mutations", async () => {
  const f = fixture();
  await f.manager.open("s1");
  await f.manager.inspect("one");
  f.manager.edit("edited 中文");
  f.request.mockImplementationOnce(async (_method, _params, options) => {
    f.client.state.sessionRole = "view";
    options?.beforeSend?.();
    throw Error("must not reach transport");
  });
  await expect(f.manager.act("one", "edit")).rejects.toThrow(/control/i);
  expect(f.manager.state.editText).toBe("edited 中文");
  expect(f.manager.state.error).toBeTruthy();
  expect(
    f.request.mock.calls.filter(([m]) => m === "execution.action"),
  ).toHaveLength(1);
  f.manager.bind(null);
  f.tick();
  expect(
    f.request.mock.calls.filter(([m]) => m === "execution.action"),
  ).toHaveLength(1);
});
it("invalidates an expired hold without discarding local edits or acquiring another hold", async () => {
  const f = fixture();
  await f.manager.open("s1");
  await f.manager.inspect("one");
  f.manager.edit("尚未保存");
  f.request.mockRejectedValueOnce(Error("Queue hold expired"));
  await expect(f.manager.refresh()).rejects.toThrow("expired");
  expect(f.manager.state.holding).toBe(false);
  expect(f.manager.state.editText).toBe("尚未保存");
  await expect(f.manager.act("one", "edit")).rejects.toThrow(/hold/i);
  f.tick();
  expect(
    f.request.mock.calls.filter(([m]) => m === "execution.hold"),
  ).toHaveLength(1);
  await f.manager.close();
});
it("keeps the editor available while the automatic lease renewal is waiting", async () => {
  const f = fixture();
  await f.manager.open("s1");
  await f.manager.inspect("one");
  let release!: (result: unknown) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  f.tick();
  try {
    expect(f.manager.state.loading).toBe(false);
    f.manager.edit("续期期间继续输入");
    expect(f.manager.state.editText).toBe("续期期间继续输入");
  } finally {
    release([item]);
    await f.manager.close();
  }
});
