import type { MobileState } from "./controller.ts";

export function canReturnToTask(
  state: Pick<MobileState, "phase" | "session" | "composer">,
): boolean {
  if (!state.session) return false;
  if (state.phase === "connected") return true;
  return (
    ["offline", "connecting", "error"].includes(state.phase) &&
    !state.composer.loading &&
    state.composer.record?.session.id === state.session.id
  );
}
