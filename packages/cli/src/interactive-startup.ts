/** Join independent startup work without publishing a partly initialized UI. */
export async function openInteractive<
  View,
  Runtime extends { close(): Promise<void> },
>(view: Promise<View>, runtime: Promise<Runtime>) {
  const [loadedView, openedRuntime] = await Promise.allSettled([view, runtime]);
  if (openedRuntime.status === "rejected") throw openedRuntime.reason;
  if (loadedView.status === "rejected") {
    await openedRuntime.value.close();
    throw loadedView.reason;
  }
  return { view: loadedView.value, runtime: openedRuntime.value };
}
