/** iOS permission sheets briefly become inactive without entering background. */
export function mobileLifecycle(
  controller: { restore(): Promise<void>; suspend(): void },
  initialState: string | null | undefined,
) {
  let suspended = initialState !== "active";
  if (!suspended) void controller.restore();
  return (state: string) => {
    if (state === "background" && !suspended) {
      suspended = true;
      controller.suspend();
    } else if (state === "active" && suspended) {
      suspended = false;
      void controller.restore();
    }
  };
}
