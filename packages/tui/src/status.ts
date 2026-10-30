import { truncateToWidth, visibleWidth } from "./primitives.ts";
import { accent, bold, muted } from "./theme.ts";
import { sanitize } from "./text.ts";

/** UI-only projection. Missing backend metadata is intentionally not inferred. */
export type ViewStatus = {
  connection: "connected" | "disconnected" | "synchronizing";
  model: string;
  permission: string;
  cwd: string;
  branch?: string;
  usage?: { input: number; output: number; cost: number };
  contextWindow?: number;
  reasoning?: string;
  speed?: string;
};

const single = (text: string) => sanitize(text).replace(/[\r\n\t]+/g, " ");
const fit = (text: string, width: number) =>
  truncateToWidth(text, Math.max(0, width));

export function renderHeader(status: ViewStatus, width: number) {
  const room = Math.max(0, width - 2);
  const title = accent(bold("hikaro"));
  const workspace = single(
    status.cwd.replace(/\/$/, "").split("/").at(-1) ?? "",
  );
  const context = fit(
    `${workspace}${status.branch ? ` / ${single(status.branch)}` : ""}`,
    Math.max(0, room - 9),
  );
  return [
    fit(
      ` ${title}${" ".repeat(Math.max(1, room - 6 - visibleWidth(context)))}${muted(context)}`,
      width,
    ),
  ];
}

export function renderStatus(
  status: ViewStatus,
  phase: string,
  showUsage: boolean,
  width: number,
) {
  const room = Math.max(1, width - 2);
  const state =
    status.connection === "disconnected"
      ? "Disconnected"
      : status.connection === "synchronizing"
        ? "Synchronizing"
        : single(phase);
  const permission = status.permission
    ? `Permissions · ${single(status.permission)}`
    : "";
  const model = single(status.model);
  const usage = status.usage;
  const extra = showUsage
    ? [
        ...(usage
          ? [`↑${usage.input} ↓${usage.output} est $${usage.cost.toFixed(3)}`]
          : []),
        ...(status.contextWindow
          ? [`${Math.round(status.contextWindow / 1000)}k`]
          : []),
        ...(status.reasoning ? [single(status.reasoning)] : []),
        ...(status.speed && status.speed !== "default"
          ? [single(status.speed)]
          : []),
      ].join(" · ")
    : "";
  let right = [model, permission, extra].filter(Boolean).join(" · ");
  if (visibleWidth(state + right) + 3 > room)
    right = [model, permission].filter(Boolean).join(" · ");
  if (visibleWidth(state + right) + 3 > room) right = permission;
  if (visibleWidth(state + right) + 3 <= room) {
    return [
      ` ${bold(state)}${" ".repeat(Math.max(1, room - visibleWidth(state + right)))}${muted(right)}`,
    ];
  }
  // Permission and connection state survive even when model/usage cannot fit.
  return [
    ` ${bold(fit(state, room))}`,
    ` ${muted(fit(permission || model, room))}`,
  ];
}
