import { expect, it, vi } from "vitest";
import {
  MobileInspection,
  MAX_IMAGE_CHARS,
} from "../apps/mobile/src/inspection.ts";
import { CONTENT_STEP } from "../apps/mobile/src/content.ts";

const entry = {
  id: "a7d1e421-312b-492c-bd51-823dbeeddddc",
  path: "/workspace/demo.ts",
  timestamp: 1,
  before: "a".repeat(64),
  after: "b".repeat(64),
  state: "committed",
};
function fixture() {
  const request = vi.fn();
  const client = {
    state: { canAct: true, session: { id: "one" } },
    request,
    supports: (method: string) => !method.startsWith("changes.review."),
  };
  const reader = new MobileInspection(() => {});
  reader.bind(client);
  return { reader, client, request };
}
const imagePage = (data: string, offset = 0) => ({
  data: data.slice(offset, offset + 65536),
  total: data.length,
  nextOffset: offset + 65536 < data.length ? offset + 65536 : null,
  encoding: "base64",
  mimeType: "image/png",
});

it("keeps image reading available on older hosts while refusing unsupported diff requests", async () => {
  const f = fixture();
  const legacy = {
    ...f.client,
    supports: (method: string) =>
      !method.startsWith("changes.review.") && method !== "changes.diff",
  };
  f.reader.bind(legacy);
  expect(f.reader.state.canImages).toBe(true);
  expect(f.reader.state.canChanges).toBe(false);
  await expect(f.reader.readDiff(entry.id)).rejects.toThrow(/尚不支持/);
  expect(f.request).not.toHaveBeenCalled();
});

it("assembles one bounded image on demand, without fetching another image", async () => {
  const f = fixture(),
    data = "YWJj".repeat(20000);
  f.request.mockImplementation(async (_m, p) => imagePage(data, p.offset));
  await f.reader.readImage(7, 1, 3);
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.request.mock.calls[0]![1]).toEqual({
    sessionId: "one",
    seq: 7,
    image: 1,
    field: "image",
    offset: 0,
    limit: 65536,
  });
  expect(f.reader.state.image?.uri).toBe("data:image/png;base64," + data);
  f.reader.close();
  expect(f.reader.state.image).toBeNull();
});

it("rejects malformed, oversized and inconsistent image pages instead of displaying partial data", async () => {
  for (const bad of [
    { ...imagePage("YWJj"), mimeType: "image/svg+xml" },
    { ...imagePage("YWJj"), data: "http" + "://elsewhere" },
    { ...imagePage("YWJj"), total: MAX_IMAGE_CHARS + 4 },
    { ...imagePage("YWJj"), nextOffset: 0 },
    { ...imagePage("YWJj"), data: "" },
  ]) {
    const f = fixture();
    f.request.mockResolvedValue(bad);
    await expect(f.reader.readImage(7, 0, 1)).rejects.toThrow();
    expect(f.reader.state.image?.uri).toBeNull();
    expect(f.reader.state.error).toBeTruthy();
  }
  const f = fixture(),
    data = "YWJj".repeat(20000);
  f.request.mockImplementation(async (_m, p) => ({
    ...imagePage(data, p.offset),
    mimeType: p.offset ? "image/jpeg" : "image/png",
  }));
  await expect(f.reader.readImage(7, 0, 1)).rejects.toThrow();
  expect(f.reader.state.image?.uri).toBeNull();
  await expect(f.reader.readImage(7, 2, 2)).rejects.toThrow();
});

it("fences late reads after closing, losing authority or switching tasks", async () => {
  for (const invalidate of ["close", "revoke", "switch"] as const) {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    f.request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = f.reader.readImage(7, 0, 1);
    if (invalidate === "close") f.reader.close();
    if (invalidate === "revoke") {
      f.client.state.canAct = false;
      f.reader.bind(null);
    }
    if (invalidate === "switch") {
      f.client.state.session = { id: "two" };
      f.reader.bind(f.client);
    }
    resolve(imagePage("YWJj"));
    await expect(pending).rejects.toThrow();
    expect(f.reader.state.image).toBeNull();
    expect(f.request).toHaveBeenCalledTimes(1);
  }
});

it("rechecks live access after an awaited read even before rebinding notifications arrive", async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.request.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const pending = f.reader.readImage(7, 0, 1);
  f.client.state.canAct = false;
  resolve(imagePage("YWJj"));
  await expect(pending).rejects.toThrow(/changed/);
  expect(f.reader.state.image?.uri).toBeNull();
});

it("reads paged changes and Unicode-safe diff sections and rejects changed snapshot identities", async () => {
  const f = fixture(),
    diff = "x".repeat(CONTENT_STEP - 1) + "😀\n+中文";
  f.request.mockImplementation(async (m, p) =>
    m === "changes.list"
      ? { items: [entry], more: false }
      : {
          entry,
          data: diff.slice(p.offset, p.offset + 8192),
          total: diff.length,
          encoding: "utf16",
          nextOffset: p.offset + 8192 < diff.length ? p.offset + 8192 : null,
        },
  );
  await f.reader.listChanges();
  expect(f.reader.state.changes?.items[0]?.id).toBe(entry.id);
  await f.reader.readDiff(entry.id);
  const first = f.reader.state.diff?.page?.data;
  await f.reader.readDiff(entry.id, CONTENT_STEP);
  expect(first + f.reader.state.diff!.page!.data).toBe(diff);
  f.request.mockResolvedValue({
    entry: { ...entry, after: "c".repeat(64) },
    data: diff.slice(CONTENT_STEP - 1),
    total: diff.length,
    encoding: "utf16",
    nextOffset: null,
  });
  await expect(f.reader.readDiff(entry.id, CONTENT_STEP)).rejects.toThrow(
    /changed/i,
  );
  expect(f.reader.state.diff?.page).toBeNull();
  f.reader.bind(null);
  expect(f.reader.state.changes).toBeNull();
  expect(f.reader.state.diff).toBeNull();
});

it("searches bounded session text and rejects stale results after switching tasks", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce({
    items: [{ seq: 9, role: "user", snippet: "中文结果" }],
    nextBefore: 9,
  });
  await f.reader.searchMessages("中文");
  expect(f.request.mock.calls[0]![1]).toEqual({
    sessionId: "one",
    query: "中文",
    before: undefined,
    limit: 20,
  });
  expect(f.reader.state.search?.nextBefore).toBe(9);
  let finish!: (value: unknown) => void;
  f.request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.reader.searchMessages("中文", 9, [undefined]);
  f.client.state.session = { id: "two" };
  f.reader.bind(f.client);
  finish({
    items: [{ seq: 8, role: "user", snippet: "old task" }],
    nextBefore: null,
  });
  await expect(pending).rejects.toThrow(/context changed/);
  expect(f.reader.state.search).toBeNull();
  expect(f.reader.state.loading).toBe(false);
});

it("refuses unsupported search and malformed non-advancing cursors", async () => {
  const f = fixture();
  f.request.mockResolvedValue({
    items: [{ seq: 9, role: "user", snippet: "match" }],
    nextBefore: 9,
  });
  await expect(f.reader.searchMessages("match", 9)).rejects.toThrow(/cursor/);
  expect(f.reader.state.search).toBeNull();
  f.reader.bind({ ...f.client, supports: () => false });
  await expect(f.reader.searchMessages("match")).rejects.toThrow(/尚不支持/);
  expect(f.request).toHaveBeenCalledTimes(1);
});

it("negotiates descendant observations and reads deletions through the review API", async () => {
  const f = fixture();
  f.client.supports = () => true;
  const observed = {
    ...entry,
    after: null,
    state: "observed",
    source: "shell",
    sessionId: "child",
    depth: 1,
    readOnly: true,
    callId: "invocation",
  };
  f.request.mockImplementation(async (method) =>
    method === "changes.review.list"
      ? { items: [observed], more: false, warnings: ["Incomplete snapshot"] }
      : {
          entry: observed,
          data: "--- file\n+++ /dev/null\n-before",
          total: 30,
          encoding: "utf16",
          nextOffset: null,
        },
  );
  await f.reader.listChanges();
  expect(f.reader.state.changes?.warnings).toEqual(["Incomplete snapshot"]);
  f.request.mockResolvedValue({
    entry: observed,
    data: "-before",
    total: 7,
    encoding: "utf16",
    nextOffset: null,
  });
  await f.reader.readDiff(entry.id);
  expect(f.request.mock.calls.at(-1)).toMatchObject([
    "changes.review.diff",
    { sessionId: "one", owner: "child", source: "shell" },
    { beforeSend: expect.any(Function) },
  ]);
  expect(f.reader.state.diff?.entry.after).toBeNull();
});
