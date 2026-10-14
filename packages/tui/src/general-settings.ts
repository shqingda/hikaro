import type { HikaroView } from "./index.ts";
import type { TuiPreferences } from "./preferences.ts";
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
  ];
  try {
    for (;;) {
      const selected = await panel.choose(
        "Settings · saved immediately",
        fields.map((field) => ({
          value: field.key,
          label: field.label,
          description: preferences[field.key] ? field.on : field.off,
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
        warning = e instanceof Error ? e.message : String(e);
      }
    }
  } catch (e) {
    if (!signal.aborted) view.setError(String(e));
  } finally {
    close();
  }
}
