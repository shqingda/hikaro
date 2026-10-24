/** Bind a destructive confirmation to the pairing that was shown to the user. */
export function connectionRemoval(controller: {
  readonly notificationIdentity: string | null;
  readonly state: object;
  forget(): Promise<void>;
}) {
  const identity = controller.notificationIdentity;
  const state = controller.state;
  let consumed = false;
  return {
    cancel() {
      consumed = true;
    },
    async confirm(): Promise<"removed" | "changed" | "ignored"> {
      if (consumed) return "ignored";
      consumed = true;
      if (
        identity !== controller.notificationIdentity ||
        (identity === null && state !== controller.state)
      )
        return "changed";
      await controller.forget();
      return "removed";
    },
  };
}
