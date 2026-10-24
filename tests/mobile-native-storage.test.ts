import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  open: vi.fn(),
  erase: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock("../apps/mobile/node_modules/expo-sqlite/build/index.js", () => ({
  openDatabaseAsync: native.open,
}));
vi.mock(
  "../apps/mobile/node_modules/expo-secure-store/build/SecureStore.js",
  () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
    deleteItemAsync: native.erase,
    getItemAsync: native.read,
    setItemAsync: native.write,
  }),
);
import type { MobileStorage } from "../apps/mobile/src/controller.ts";
// The implementation is checked by mobile:typecheck. Loading its native adapters
// at runtime keeps React Native's global types out of the Node test project.
const { nativeStorage }: { nativeStorage(): MobileStorage } = await import(
  new URL("../apps/mobile/src/native-storage.ts", import.meta.url).href
);

beforeEach(() => {
  vi.resetAllMocks();
  native.read.mockResolvedValue("saved pairing");
});
function database(installed = true) {
  return {
    execAsync: vi.fn(async () => {}),
    getFirstAsync: vi.fn(async () => (installed ? { id: 1 } : null)),
    runAsync: vi.fn(async () => {}),
    closeAsync: vi.fn(async () => {}),
  };
}

it("retries a failed database open without requiring an app restart", async () => {
  native.open
    .mockRejectedValueOnce(Error("Storage temporarily unavailable"))
    .mockResolvedValueOnce(database());
  const store = nativeStorage();
  await expect(store.read()).rejects.toThrow("Storage temporarily unavailable");
  await expect(store.read()).resolves.toBe("saved pairing");
  expect(native.open).toHaveBeenCalledTimes(2);
  expect(native.erase).not.toHaveBeenCalled();
});

it("closes a partially initialized database and retries schema setup", async () => {
  const first = database(),
    second = database();
  first.execAsync.mockRejectedValueOnce(Error("Database locked"));
  native.open.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const store = nativeStorage();
  await expect(store.read()).rejects.toThrow("Database locked");
  await expect(store.read()).resolves.toBe("saved pairing");
  expect(first.closeAsync).toHaveBeenCalledOnce();
  expect(second.closeAsync).not.toHaveBeenCalled();
});

it("does not reuse an old Keychain identity when first-install cleanup fails", async () => {
  const first = database(false),
    second = database(false);
  native.erase
    .mockRejectedValueOnce(Error("Keychain locked"))
    .mockResolvedValueOnce(undefined);
  native.open.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  native.read.mockResolvedValue(null);
  const store = nativeStorage();
  await expect(store.read()).rejects.toThrow("Keychain locked");
  expect(native.read).not.toHaveBeenCalled();
  expect(first.runAsync).not.toHaveBeenCalled();
  await expect(store.read()).resolves.toBeNull();
  expect(native.erase).toHaveBeenCalledTimes(2);
  expect(second.runAsync).toHaveBeenCalledWith(
    "INSERT INTO installation VALUES(1)",
  );
});

it("shares initialization among concurrent callers and preserves the first error if close fails", async () => {
  const first = database();
  first.execAsync.mockRejectedValueOnce(Error("Schema unavailable"));
  first.closeAsync.mockRejectedValueOnce(Error("Close failed"));
  native.open.mockResolvedValueOnce(first).mockResolvedValueOnce(database());
  const store = nativeStorage();
  const results = await Promise.allSettled([store.read(), store.read()]);
  expect(results).toEqual([
    { status: "rejected", reason: Error("Schema unavailable") },
    { status: "rejected", reason: Error("Schema unavailable") },
  ]);
  expect(native.open).toHaveBeenCalledOnce();
  await Promise.all([store.read(), store.read()]);
  expect(native.open).toHaveBeenCalledTimes(2);
  expect(first.closeAsync).toHaveBeenCalledTimes(2);
});

it("does not reopen a native cached connection until failed cleanup succeeds", async () => {
  const first = database();
  first.execAsync.mockRejectedValueOnce(Error("Schema unavailable"));
  first.closeAsync
    .mockRejectedValueOnce(Error("Close busy"))
    .mockRejectedValueOnce(Error("Still busy"));
  native.open.mockResolvedValueOnce(first).mockResolvedValueOnce(database());
  const store = nativeStorage();
  await expect(store.read()).rejects.toThrow("Schema unavailable");
  await expect(store.read()).rejects.toThrow("Still busy");
  expect(native.open).toHaveBeenCalledOnce();
  await expect(store.read()).resolves.toBe("saved pairing");
  expect(first.closeAsync).toHaveBeenCalledTimes(3);
  expect(native.open).toHaveBeenCalledTimes(2);
});

it("keeps concurrent callers on the failed initialization until native cleanup finishes", async () => {
  let closed!: () => void;
  const first = database();
  first.execAsync.mockRejectedValueOnce(Error("Schema unavailable"));
  first.closeAsync.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        closed = resolve;
      }),
  );
  native.open.mockResolvedValueOnce(first).mockResolvedValueOnce(database());
  const store = nativeStorage();
  const initial = store.read();
  await vi.waitFor(() => expect(first.closeAsync).toHaveBeenCalledOnce());
  const simultaneous = store.read();
  const settled = Promise.allSettled([initial, simultaneous]);
  expect(native.open).toHaveBeenCalledOnce();
  closed();
  expect((await settled).map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  await expect(store.read()).resolves.toBe("saved pairing");
  expect(native.open).toHaveBeenCalledTimes(2);
});
