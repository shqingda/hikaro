import type { HikaroView } from "./index.ts";
import type { TuiPreferences } from "./preferences.ts";
import { errorMessage } from "../../core/src/util.ts";
export async function openGeneralSettings(
  view: HikaroView,
  current: TuiPreferences,
  apply: (next: TuiPreferences) => Promise<void>,
) {
  const { panel, signal, close } = view.openModelPanel();
  let preferences = { ...current },
    warning = "";
  let selectedValue: string | undefined;
  const fields: Array<{
    key: Exclude<keyof TuiPreferences, "version">;
    label: string;
    on: string;
    off: string;
  }> = [
    {
      key: "showToolDetails",
      label: "Tool output",
      on: "Expanded",
      off: "Collapsed",
    },
    { key: "showThinking", label: "Thinking output", on: "Show", off: "Hide" },
    { key: "showUsage", label: "Usage footer", on: "Show", off: "Hide" },
    { key: "completionBell", label: "Completion bell", on: "On", off: "Off" },
    {
      key: "resumeOnStart",
      label: "Startup",
      on: "Resume last opened session",
      off: "New session",
    },
    {
      key: "followUp",
      label: "While a run is active",
      on: "Enter queues a follow-up",
      off: "Enter steers the run",
    },
  ];
  try {
    for (;;) {
      const selected = await panel.choose(
        "Settings · saved immediately",
        fields.map((field) => ({
          value: field.key,
          // Every row shows its value so the whole menu can be scanned.
          label: `${field.label} · ${preferences[field.key] ? field.on : field.off}`,
        })),
        warning,
        "↑↓ select · Enter toggle and save · Esc close",
        { search: false, selectedValue, enterAction: "toggle" },
      );
      selectedValue = selected.value;
      const key = fields.find((field) => field.key === selected.value)!.key;
      const next = { ...preferences, [key]: !preferences[key] };
      try {
        await apply(next);
        preferences = next;
        warning = "";
      } catch (e) {
        warning = errorMessage(e);
      }
    }
  } catch (e) {
    if (!signal.aborted) view.setError(String(e));
  } finally {
    close();
  }
}
