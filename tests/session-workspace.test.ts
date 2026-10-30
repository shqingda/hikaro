import { expect, it, vi } from "vitest";
import {
  SessionWorkspace,
  type WorkspaceHandle,
} from "../packages/cli/src/session-workspace.ts";
import type { HikaroView } from "../packages/tui/src/index.ts";

function fixture() {
  const visible: string[] = [];
  const handles = new Map<string, WorkspaceHandle>();
  const create = vi.fn(async (id: string) => {
    let active = false;
    const handle: WorkspaceHandle = {
      id,
      view: {
        attentionCount: 0,
        get active() {
          return active;
        },
        setActive(value: boolean) {
          active = value;
        },
        setSessions: vi.fn(),
        notice: vi.fn(),
      } as unknown as HikaroView,
      title: () => id,
      state: () => "Ready",
      canClose: () => true,
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    handles.set(id, handle);
    return handle;
  });
  const workspace = new SessionWorkspace(create, (view) =>
    visible.push(
      [...handles.values()].find((handle) => handle.view === view)!.id,
    ),
  );
  return { workspace, handles, create, visible };
}

it("keeps distinct views and drafts when switching while background state changes", async () => {
  const { workspace, visible } = fixture();
  const first = await workspace.open("first");
  const second = await workspace.open("second");
  expect(first.flush).toHaveBeenCalled();
  expect(first.view.active).toBe(false);
  expect(second.view.active).toBe(true);
  workspace.refresh("first");
  expect(visible).toEqual(["first", "second"]);
  expect(second.view.setSessions).toHaveBeenLastCalledWith(
    expect.arrayContaining([
      expect.objectContaining({ id: "first", unread: true }),
    ]),
  );
  expect(await workspace.open("first")).toBe(first);
  expect(second.view.active).toBe(false);
  expect(first.close).not.toHaveBeenCalled();
  await workspace.dispose();
});

it("retains running or approval-bound sessions when their view is closed", async () => {
  const { workspace } = fixture();
  const first = await workspace.open("first");
  const second = await workspace.open("second");
  second.canClose = () => false;
  await workspace.close("second");
  expect(workspace.get("second")).toBe(second);
  expect(second.close).not.toHaveBeenCalled();
  expect(workspace.current).toBe(first);
  second.canClose = () => true;
  await workspace.close("second");
  expect(workspace.get("second")).toBeUndefined();
  expect(second.close).toHaveBeenCalledOnce();
  await workspace.dispose();
});

it("bounds all monitored sessions and deduplicates concurrent opens", async () => {
  const { workspace, create } = fixture();
  const [a, b] = await Promise.all([
    workspace.open("one"),
    workspace.open("one"),
  ]);
  expect(a).toBe(b);
  expect(create).toHaveBeenCalledOnce();
  for (let i = 2; i <= 8; i++) await workspace.open(String(i), false);
  await expect(workspace.open("ninth")).rejects.toThrow(/8 sessions/);
  await workspace.close("2");
  await workspace.open("ninth");
  expect(workspace.values()).toHaveLength(8);
  await workspace.dispose();
});

it("keeps the current view selected when saving its draft fails", async () => {
  const { workspace } = fixture();
  const first = await workspace.open("first");
  vi.mocked(first.flush).mockRejectedValueOnce(Error("disk full"));
  await expect(workspace.open("second")).rejects.toThrow("disk full");
  expect(workspace.current).toBe(first);
  expect(first.view.active).toBe(true);
  await workspace.dispose();
});

it("closes transports even when saving a draft fails during shutdown", async () => {
  const { workspace } = fixture();
  const first = await workspace.open("first");
  vi.mocked(first.flush).mockRejectedValueOnce(Error("disk full"));
  await expect(workspace.dispose()).rejects.toThrow("disk full");
  expect(first.close).toHaveBeenCalledOnce();
});

it("forgets a deleted active session without writing its draft back", async () => {
  const { workspace } = fixture();
  const first = await workspace.open("first");
  vi.mocked(first.flush).mockClear();
  await workspace.forget("first");
  expect(workspace.current).toBeUndefined();
  expect(first.flush).not.toHaveBeenCalled();
  expect(first.close).toHaveBeenCalledOnce();
  await workspace.open("replacement");
  expect(workspace.current?.id).toBe("replacement");
  await workspace.dispose();
});

it("keeps the current view interactive throughout delayed creation and closes both on exit", async () => {
  const { workspace, create } = fixture();
  const first = await workspace.open("first");
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const build = create.getMockImplementation()!;
  create.mockImplementationOnce(async (id) => {
    await blocked;
    return build(id);
  });
  const opening = workspace.open("second");
  await Promise.resolve();
  expect(workspace.switching).toBe(true);
  expect(workspace.current).toBe(first);
  expect(first.view.active).toBe(true);
  const ending = workspace.dispose();
  finish();
  await expect(opening).rejects.toThrow("Workspace is closing");
  await ending;
  expect(workspace.switching).toBe(false);
  expect(first.close).toHaveBeenCalledOnce();
});
