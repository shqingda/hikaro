import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { expect, vi } from "vitest";

/** Drive the real workbench controls, leaving assertions on task/file state to each test. */
export function workbenchKeys(
  send: (text: string) => number | Promise<number>,
  wait: (text: string, offset?: number) => Promise<unknown>,
  output: () => string,
) {
  const sent = async (text: string, expected: string) =>
    wait(expected, await send(text));
  const actionIndex = (label: string) => {
    if (label.startsWith("Roll back this run")) return 4;
    if (label.startsWith("Roll back to here")) return 5;
    if (
      label === "Roll back this edit" ||
      label === "Reapply this edit" ||
      label === "Move to front"
    )
      return 3;
    if (label === "Remove message") return 4;
    if (
      [
        "Edit message",
        "Resume recovered message",
        "Apply recovered steering",
        "Send a line",
        "Stop child agent",
      ].includes(label)
    )
      return 2;
  };
  const reveal = async (label: string, offset: number) => {
    const index = actionIndex(label);
    if (!index) return wait(label, offset);
    const expected = label.replace(/ \(.*$/, "");
    await vi.waitFor(
      async () => {
        const text = stripVTControlCharacters(output().slice(offset));
        const marker = [...text.matchAll(/\b([1-9])\/([1-9]) /g)].at(-1);
        if (!marker) throw Error(`Waiting for ${label} action controls`);
        const current = text.slice(marker.index, marker.index + 100);
        if (Number(marker[1]) === index) expect(current).toContain(expected);
        else {
          await send("\t");
          throw Error(`Selecting ${label}; currently ${current}`);
        }
      },
      { timeout: 8000, interval: 100 },
    );
  };
  return {
    async tab(
      tab: "Conversation" | "Changes" | "Activity" | "Plan" | "Context",
    ) {
      await sent("\x10", "Search commands and actions");
      await sent(`Open ${tab}`, `Open ${tab}`);
      await sent(
        "\r",
        tab === "Conversation"
          ? "Enter "
          : tab === "Activity"
            ? "Queue · steering"
            : tab === "Changes"
              ? "File edits and observed changes"
              : tab,
      );
      if (tab !== "Conversation")
        await sent(
          "\x12",
          tab === "Activity"
            ? "Queue · steering"
            : tab === "Changes"
              ? "File edits and observed changes"
              : tab,
        );
    },
    async object(query: string, visible: string, detail: string) {
      await send("/\x01\x0b");
      await delay(40); // Let an unchanged repeated search visibly clear first.
      await sent(`${query}\r`, visible);
      await reveal(detail, await send("\r"));
    },
    async confirm(action: string, title: string, after: string) {
      await sent(action, title);
      await reveal(after, await send("\x1b[B\r"));
    },
    async cancel(action: string, title: string, after: string) {
      await sent(action, title);
      // Enter alone explicitly chooses the default Cancel item.
      await reveal(after, await send("\r"));
    },
    async refresh(expected: string) {
      // Refresh only until the actual process state is observed; the action
      // receipt is not proof of exit. Keep the existing bounded PTY deadline.
      await vi.waitFor(
        async () => {
          if (stripVTControlCharacters(output()).includes(expected)) return;
          await send("\x12");
          throw Error(`Waiting for ${expected}`);
        },
        { timeout: 8000, interval: 150 },
      );
    },
  };
}
