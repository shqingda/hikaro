import { expect, it } from "vitest";
import { runTaskGraph } from "../packages/core/src/task-graph.ts";

it.each([false, true])(
  "propagates dependency failures without executing descendants (reversed: %s)",
  async (reversed) => {
    const nodes = [
      { id: "A", dependsOn: [], task: "" },
      { id: "B", dependsOn: ["A"], task: "" },
      { id: "C", dependsOn: ["B"], task: "" },
      { id: "independent", dependsOn: [], task: "" },
    ];
    const executed: string[] = [];
    const result = await runTaskGraph(
      reversed ? nodes.reverse() : nodes,
      3,
      async (node) => {
        executed.push(node.id);
        if (node.id === "A") throw Error("A failed");
        return node.id;
      },
      new AbortController().signal,
    );
    expect(result).toEqual({
      results: { independent: "independent" },
      failures: {
        A: "Error: A failed",
        B: "Error: Dependency failed",
        C: "Error: Dependency failed",
      },
    });
    expect(executed.sort()).toEqual(["A", "independent"]);
  },
);

it("rejects a dependency cycle before executing any task", async () => {
  const executed: string[] = [];
  await expect(
    runTaskGraph(
      [
        { id: "independent", dependsOn: [], task: "" },
        { id: "A", dependsOn: ["B"], task: "" },
        { id: "B", dependsOn: ["A"], task: "" },
      ],
      3,
      async (node) => {
        executed.push(node.id);
        return node.id;
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Task graph has a dependency cycle");
  expect(executed).toEqual([]);
});
