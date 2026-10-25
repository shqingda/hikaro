import type { HikaroView } from "./index.ts";
import type { ProviderCatalog } from "../../provider-pi/src/catalog.ts";
import type { ModelSelection, ModelSettings } from "../../core/src/types.ts";
export type ModelControl = "context" | "thinking" | "speed";
export function parseModelControl(field: ModelControl, argument: string) {
  const tokens = argument.trim().split(/\s+/).filter(Boolean);
  const scopes = tokens.filter((t) => t === "active" || t === "default");
  const raw = tokens.filter((t) => t !== "active" && t !== "default");
  if (raw.length > 1 || scopes.length > 1)
    throw Error(`Use /${field} [VALUE] [active|default]`);
  const scope = scopes[0] === "default" ? "default" : "active";
  let value: string | number | undefined = raw[0];
  if (value === "auto") value = undefined;
  else if (field === "context" && value !== undefined) {
    const match = /^(\d+)(k|m)?$/i.exec(value);
    if (!match)
      throw Error("Use /context auto, /context 128k, or /context 1000000");
    value =
      Number(match[1]) *
      (match[2]?.toLowerCase() === "m"
        ? 1000000
        : match[2]?.toLowerCase() === "k"
          ? 1000
          : 1);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw Error("Context size must be a positive safe integer");
  }
  const key =
    field === "context"
      ? "contextWindow"
      : field === "thinking"
        ? "reasoning"
        : "speed";
  return { scope, supplied: raw.length > 0, key, value } as const;
}
export async function openModelControl(
  view: HikaroView,
  catalog: Pick<ProviderCatalog, "capabilities">,
  field: ModelControl,
  active: ModelSelection,
  defaults: ModelSelection,
  apply: (settings: ModelSettings) => Promise<void>,
  saveDefault: (selection: ModelSelection) => Promise<void>,
  argument = "",
) {
  const {
    scope: requestedScope,
    supplied,
    key,
    value,
  } = parseModelControl(field, argument);
  if (supplied) {
    const selection = requestedScope === "active" ? active : defaults;
    const settings = { ...selection.settings, [key]: value } as ModelSettings;
    if (requestedScope === "active") await apply(settings);
    else await saveDefault({ ...selection, settings });
    view.notice(
      `/${field}: ${requestedScope === "active" ? "applied to this session" : "saved for new sessions"}.`,
    );
    return;
  }
  const { panel, signal, close } = view.openModelPanel();
  let scope = requestedScope,
    warning = "";
  try {
    for (;;) {
      const selection = scope === "default" ? defaults : active;
      const cap = await catalog.capabilities(
        selection.provider,
        selection.model,
      );
      const current =
        selection.settings[key] ?? (field === "speed" ? "default" : undefined);
      const chosenMark = (value: unknown, label: string) =>
        `${value === current ? "✓ " : "  "}${label}`;
      let items: Array<{ value: string; label: string; description?: string }>;
      if (field === "context") {
        const sizes = [
          ...new Set([
            16000,
            32000,
            64000,
            128000,
            256000,
            512000,
            cap.contextWindow,
            ...(typeof current === "number" ? [current] : []),
          ]),
        ]
          .filter((n) => n <= cap.contextWindow)
          .sort((a, b) => a - b);
        items = [
          {
            value: "auto",
            label: chosenMark(
              undefined,
              `Auto (${Math.round(cap.contextWindow / 1000)}k maximum)`,
            ),
          },
          ...sizes.map((n) => ({
            value: String(n),
            label: chosenMark(n, `${Math.round(n / 1000)}k`),
          })),
        ];
      } else if (field === "thinking") {
        items = [
          {
            value: "auto",
            label: chosenMark(undefined, "Auto (provider default)"),
          },
          ...cap.reasoning.map((level) => ({
            value: level,
            label: chosenMark(level, level),
          })),
        ];
      } else {
        items = cap.speed.map((tier) => ({
          value: tier,
          label: chosenMark(
            tier,
            tier === "priority"
              ? "Fast (priority)"
              : tier === "flex"
                ? "Flex (slower, lower cost)"
                : "Standard",
          ),
          description:
            tier === "default"
              ? "Provider default"
              : "Availability and pricing depend on your account.",
        }));
      }
      items.push({
        value: "__scope",
        label:
          scope === "active"
            ? "Edit default for new sessions…"
            : "Edit active session…",
      });
      const picked = await panel.choose(
        `/${field} · ${scope} · ${selection.provider}/${selection.model}`,
        items,
        warning,
        undefined,
        {
          allowDefault: (item) =>
            scope === "active" && item.value !== "__scope",
          enterAction: (item) =>
            item.value === "__scope"
              ? "switch scope"
              : scope === "active"
                ? "apply now"
                : "save default",
        },
      );
      if (picked.value === "__scope") {
        scope = scope === "active" ? "default" : "active";
        warning = "";
        continue;
      }
      const value =
        picked.value === "auto"
          ? undefined
          : field === "context"
            ? Number(picked.value)
            : picked.value;
      const settings = { ...selection.settings, [key]: value } as ModelSettings;
      try {
        if (scope === "active") await apply(settings);
        if (scope === "default" || picked.makeDefault)
          await saveDefault({ ...selection, settings });
        view.notice(
          scope === "default"
            ? `/${field}: default saved; new sessions use it.`
            : `/${field}: applied to this session${picked.makeDefault ? " and saved as default" : ""}.`,
        );
        return;
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
