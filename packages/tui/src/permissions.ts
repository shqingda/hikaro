import type { HikaroView } from "./index.ts";
import {
  permissionOptions,
  type PermissionMode,
} from "../../runtime/src/permissions.ts";

export async function openPermissions(
  view: HikaroView,
  current: PermissionMode,
  apply: (mode: PermissionMode) => Promise<void>,
) {
  const { panel, signal, close } = view.openModelPanel();
  try {
    const selected = await panel.choose(
      "Permissions · this workspace",
      permissionOptions.map((option) => ({
        ...option,
        label: `${option.value === current ? "● " : ""}${option.label}`,
      })),
      "",
      "↑↓ select · Enter apply and save · Esc close",
      { search: false, selectedValue: current, enterAction: "apply" },
    );
    await apply(selected.value as PermissionMode);
  } catch (error) {
    if (!signal.aborted) view.setError(String(error));
  } finally {
    close();
  }
}
