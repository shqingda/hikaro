import { randomUUID } from "node:crypto";
import type { HikaroView } from "./index.ts";

export async function pluginResult<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort!: () => void;
  const closed = new Promise<never>((_, reject) => {
    abort = () => reject(Error("Plugin result view closed"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([work, closed]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Closing a view does not cancel trusted code; stopping is always explicit. */
export async function openPluginExecution(
  view: HikaroView,
  name: string,
  invoke: (id: string) => Promise<string>,
  cancel?: (id: string) => Promise<unknown>,
) {
  const id = randomUUID();
  let settled = false;
  const { panel, signal, close } = view.openModelPanel({
    onCancel: cancel
      ? () => {
          if (settled || signal.aborted) return;
          panel.progress(
            "Cancellation requested; waiting for plugin to settle… Esc closes this view.",
          );
          void cancel(id).catch((error) => {
            if (!signal.aborted) view.setError(String(error));
          });
        }
      : undefined,
  });
  view.notice(
    `Plugin ${id}. ${cancel ? `Stop with /plugin-stop ${id}.` : "Host does not support plugin cancellation."}`,
  );
  panel.progress(
    `Running ${name}… ${cancel ? "Ctrl+C requests cancellation. " : ""}Esc closes this view.`,
  );
  const work = Promise.resolve()
    .then(() => invoke(id))
    .finally(() => {
      settled = true;
    });
  try {
    const text = await pluginResult(work, signal);
    signal.throwIfAborted();
    return text;
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    close();
  }
}
