/** Read leftover color-query replies while input is still raw, then restore the shell. */
export async function stopTerminal(tui: {
  stop(options: { preserveScreen: boolean }): void;
  terminal: {
    drainInput?(maxMs?: number, idleMs?: number): Promise<void>;
  };
}) {
  try {
    await tui.terminal.drainInput?.(200, 40);
  } catch {
    // A closed stdin must not block restoring the shell.
  }
  tui.stop({ preserveScreen: true });
}
