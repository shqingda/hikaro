/**
 * Returns the previous selection while every selected field keeps its identity, so a
 * component reading only some state does not re-render on unrelated updates (e.g. stream).
 */
export function selectionSnapshot<S, T extends Record<string, unknown>>(
  read: () => S,
  select: (state: S) => T,
) {
  let last: T | undefined;
  return () => {
    const next = select(read());
    if (
      last &&
      Object.keys(next).length === Object.keys(last).length &&
      Object.keys(next).every((key) => Object.is(next[key], last![key]))
    )
      return last;
    return (last = next);
  };
}
