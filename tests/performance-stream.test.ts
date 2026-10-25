import { expect, it } from "vitest";

const script = "../scripts/bench-stream.mjs";

it("requires every completed response delta and terminal marker before reporting latency", async () => {
  const { verifyStreamRecords } = await import(script);
  const text = "x\nHKB100_110X\nx\nHKB200_210X\n";
  const records = [
    { type: "text.delta", data: { text: text.slice(0, 9) } },
    { type: "text.delta", data: { text: text.slice(9) } },
    { type: "message", data: { message: { role: "assistant", text } } },
    { type: "run.end", data: { status: "completed" } },
  ];
  expect(
    verifyStreamRecords(records, "normal", 2, ["HKB100_110X", "HKB200_210X"])
      .completed,
  ).toBe(true);
  expect(() =>
    verifyStreamRecords(records, "normal", 2, ["HKB100_110X"]),
  ).toThrow(/visible|marker/i);
  expect(() =>
    verifyStreamRecords(records.slice(1), "normal", 2, [
      "HKB100_110X",
      "HKB200_210X",
    ]),
  ).toThrow(/delta|match/i);
  expect(() =>
    verifyStreamRecords(
      [...records.slice(0, 3), { type: "run.end", data: { status: "failed" } }],
      "normal",
      2,
      ["HKB100_110X", "HKB200_210X"],
    ),
  ).toThrow(/complete|status/i);
});
