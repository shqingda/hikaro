import { expect, it, vi } from "vitest";
import {
  confirmLeavePlan,
  readPlanEvidence,
} from "../packages/tui/src/planning.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";

it.each(["keep", "leave"])(
  "only leaves Plan mode after the explicit %s choice",
  async (value) => {
    const controller = new AbortController();
    const choose = vi.fn().mockResolvedValue({ value });
    const close = vi.fn(() => controller.abort());
    const view = {
      openModelPanel: () => ({
        panel: { choose },
        signal: controller.signal,
        close,
      }),
    } as unknown as HikaroView;
    const leave = vi.fn(async () => {
      expect(controller.signal.aborted).toBe(false);
    });
    await confirmLeavePlan(view, leave);
    expect(leave).toHaveBeenCalledTimes(value === "leave" ? 1 : 0);
    expect(choose.mock.calls[0]![4]).toMatchObject({
      cancelValue: "keep",
      requireNoticeVisible: true,
    });
    expect(close).toHaveBeenCalledOnce();
  },
);

it("never applies a delayed plan exit choice after the panel was invalidated", async () => {
  const controller = new AbortController();
  const close = vi.fn();
  const view = {
    openModelPanel: () => ({
      panel: {
        choose: async () => {
          controller.abort();
          return { value: "leave" };
        },
      },
      signal: controller.signal,
      close,
    }),
  } as unknown as HikaroView;
  const leave = vi.fn();
  await expect(confirmLeavePlan(view, leave)).rejects.toThrow(/abort/i);
  expect(leave).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("reassembles paginated Unicode evidence and retains an explicit truncation notice", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      data: "中文\ud83c",
      nextOffset: 3,
      truncated: true,
    })
    .mockResolvedValueOnce({
      data: "\udf05END",
      nextOffset: null,
      truncated: true,
    });
  expect(await readPlanEvidence(read, new AbortController().signal)).toBe(
    "中文🌅END\n[Result preview limited; see session history.]",
  );
  expect(read.mock.calls).toEqual([
    [0, 16000],
    [3, 16000],
  ]);
});

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10])(
  "rejects invalid evidence cursor %s without requesting another page",
  async (nextOffset) => {
    const read = vi
      .fn()
      .mockResolvedValue({ data: "one", nextOffset, truncated: false });
    await expect(
      readPlanEvidence(read, new AbortController().signal),
    ).rejects.toThrow("Invalid evidence page");
    expect(read).toHaveBeenCalledOnce();
  },
);

it("bounds all evidence content, including a final oversized page", async () => {
  const read = vi
    .fn()
    .mockResolvedValue({
      data: "x".repeat(128001),
      nextOffset: null,
      truncated: false,
    });
  await expect(
    readPlanEvidence(read, new AbortController().signal),
  ).rejects.toThrow("Invalid evidence page");
  expect(read).toHaveBeenCalledOnce();
});

it("stops paging when a pending result arrives after the reader closes", async () => {
  const controller = new AbortController();
  const read = vi.fn(async () => {
    controller.abort();
    return { data: "late", nextOffset: 4, truncated: false };
  });
  await expect(readPlanEvidence(read, controller.signal)).rejects.toThrow(
    /abort/i,
  );
  expect(read).toHaveBeenCalledOnce();
});
