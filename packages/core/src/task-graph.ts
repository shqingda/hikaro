export type TaskNode = { id: string; dependsOn: string[]; task: string };
export async function runTaskGraph<T>(
  nodes: TaskNode[],
  concurrency: number,
  execute: (node: TaskNode, dependencies: Record<string, T>) => Promise<T>,
  signal: AbortSignal,
) {
  const pending = new Map(nodes.map((n) => [n.id, n]));
  if (pending.size !== nodes.length) throw Error("Duplicate task ID");
  for (const n of nodes)
    for (const dependency of n.dependsOn)
      if (!pending.has(dependency))
        throw Error(`Missing dependency: ${dependency}`);
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw Error("Task graph has a dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const d of pending.get(id)!.dependsOn) visit(d);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of pending.keys()) visit(id);
  const done = new Map<string, T>();
  const running = new Map<string, Promise<void>>();
  const failures = new Map<string, unknown>();
  while (pending.size || running.size) {
    signal.throwIfAborted();
    const pendingBefore = pending.size;
    for (const [id, node] of pending) {
      if (running.size >= concurrency) break;
      if (node.dependsOn.some((d) => failures.has(d))) {
        pending.delete(id);
        failures.set(id, Error("Dependency failed"));
        continue;
      }
      if (!node.dependsOn.every((d) => done.has(d))) continue;
      pending.delete(id);
      const work = execute(
        node,
        Object.fromEntries(node.dependsOn.map((d) => [d, done.get(d)!])),
      )
        .then(
          (result) => {
            done.set(id, result);
          },
          (error) => {
            failures.set(id, error);
          },
        )
        .finally(() => {
          running.delete(id);
        });
      running.set(id, work);
    }
    if (!running.size && pending.size && pending.size === pendingBefore)
      throw Error("Task graph has a dependency cycle");
    if (running.size) await Promise.race(running.values());
  }
  return {
    results: Object.fromEntries(done),
    failures: Object.fromEntries(
      [...failures].map(([id, e]) => [id, String(e)]),
    ),
  };
}
