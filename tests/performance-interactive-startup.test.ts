import { describe, expect, it, vi } from "vitest";
import { openInteractive } from "../apps/cli/src/interactive-startup.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("interactive startup readiness", () => {
  it("does not expose readiness until both the view and runtime finish", async () => {
    const view = deferred<{ ready: boolean }>();
    const runtime = deferred<{ close: () => Promise<void> }>();
    const opened = { close: vi.fn(async () => {}) };
    let ready = false;
    const result = openInteractive(view.promise, runtime.promise).then(
      (value) => {
        ready = true;
        return value;
      },
    );
    runtime.resolve(opened);
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toBe(false);
    view.resolve({ ready: true });
    expect(await result).toEqual({ view: { ready: true }, runtime: opened });
    expect(opened.close).not.toHaveBeenCalled();
  });

  it("closes a runtime that finishes after the view import fails", async () => {
    const view = deferred<never>();
    const runtime = deferred<{ close: () => Promise<void> }>();
    const close = vi.fn(async () => {});
    const failure = Error("View dependency could not load");
    const result = openInteractive(view.promise, runtime.promise);
    const rejected = expect(result).rejects.toBe(failure);
    view.reject(failure);
    await Promise.resolve();
    runtime.resolve({ close });
    await rejected;
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves runtime initialization failures without publishing a view", async () => {
    const failure = Error("Invalid saved permission configuration");
    await expect(
      openInteractive(
        Promise.resolve({ ready: true }),
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
  });
});
