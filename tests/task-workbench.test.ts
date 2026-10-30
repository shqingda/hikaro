import { describe, it, expect } from "vitest";
import {
  ActionRegistry,
  workspaceColumns,
} from "../packages/tui/src/workbench.ts";

describe("workbench navigation", () => {
  it("reserves readable content instead of squeezing three panes", () => {
    expect(workspaceColumns(144, true)).toEqual({
      navigation: 22,
      inspector: 44,
    });
    expect(workspaceColumns(120, true)).toEqual({
      navigation: 0,
      inspector: 44,
    });
    expect(workspaceColumns(120, false)).toEqual({
      navigation: 22,
      inspector: 0,
    });
    expect(workspaceColumns(80, true)).toEqual({ navigation: 0, inspector: 0 });
  });
  it("rechecks availability at execution and never runs a disabled action", async () => {
    const registry = new ActionRegistry();
    let connected = true,
      calls = 0;
    registry.set([
      {
        id: "stop",
        title: "Stop current run",
        enabled: () => connected || "Disconnected",
        run: () => {
          calls++;
        },
      },
    ]);
    expect(registry.search("current")).toHaveLength(1);
    connected = false;
    await expect(registry.run("stop")).rejects.toThrow("Disconnected");
    expect(calls).toBe(0);
  });
});
