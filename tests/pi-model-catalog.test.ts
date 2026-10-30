import { expect, it, vi } from "vitest";
import { piModelCatalog } from "../packages/cli/src/pi-model-catalog.ts";

it("lists only Pi-owned provider metadata and never offers local credential mutation", async () => {
  const backend = {
    currentModel: { provider: "existing", id: "active", name: "Active" },
    availableModels: vi.fn(async () => [
      { provider: "provider", id: "one", name: "One" },
      { provider: "provider", id: "two", name: "Two" },
    ]),
  };
  const catalog = piModelCatalog(backend);
  expect(await catalog.available("provider")).toHaveLength(2);
  expect(await catalog.available("missing")).toEqual([]);
  expect(await catalog.providers()).toEqual([
    expect.objectContaining({
      id: "existing",
      methods: [],
      stored: false,
      statusReason: expect.stringContaining("Managed by Pi"),
    }),
    expect.objectContaining({ id: "provider", methods: [], stored: false }),
  ]);
  expect(catalog.logout).toBeUndefined();
  await expect(
    catalog.login("provider", "api_key", {} as never),
  ).rejects.toThrow("Managed by Pi");
  const controller = new AbortController();
  controller.abort();
  const before = backend.availableModels.mock.calls.length;
  await expect(
    catalog.refresh("provider", controller.signal),
  ).rejects.toThrow();
  expect(backend.availableModels).toHaveBeenCalledTimes(before);
});
