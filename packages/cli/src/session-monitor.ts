import type { ClientConnection } from "../../client-core/src/connection.ts";

/** Saved outcomes are settled; live or unrecognized states keep their view. */
export function backgroundWorkSettled(
  terminals: unknown,
  children: unknown,
): boolean {
  const settled = (items: unknown, states: readonly string[]) =>
    Array.isArray(items) &&
    items.every(
      (item: unknown) =>
        item !== null &&
        typeof item === "object" &&
        "state" in item &&
        typeof item.state === "string" &&
        states.includes(item.state.split(" · ")[0]!),
    );
  return (
    settled(terminals, ["exited", "unknown after host restart"]) &&
    settled(children, ["completed", "failed", "cancelled", "interrupted"])
  );
}

/** Read current work without holding the queue or trusting a stale connection. */
export async function attachedBackgroundSettled(
  client: Pick<
    ClientConnection,
    "status" | "supports" | "subscribe" | "request"
  >,
  sessionId: string,
): Promise<boolean> {
  const host = client.status.hostInstanceId;
  let invalid = false;
  const current = () =>
    client.status.canAct &&
    client.status.session?.id === sessionId &&
    client.status.hostInstanceId === host;
  if (!current() || !client.supports("execution.read")) return false;
  const unsubscribe = client.subscribe(() => {
    if (!current()) invalid = true;
  });
  const check = () => {
    if (invalid || !current()) throw Error("Session connection changed");
  };
  try {
    const [terminals, children] = await Promise.all(
      (["terminals", "children"] as const).map((kind) =>
        client.request(
          "execution.read",
          { sessionId, kind },
          { beforeSend: check },
        ),
      ),
    );
    check();
    return backgroundWorkSettled(terminals, children);
  } catch {
    return false;
  } finally {
    unsubscribe();
  }
}
