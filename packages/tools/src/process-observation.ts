import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as z from "zod";

const identity = z.object({
  pid: z.number().int().min(2),
  ppid: z.number().int().nonnegative(),
  pgid: z.number().int().nonnegative(),
  startSec: z.string().regex(/^\d{1,20}$/),
  startUsec: z.string().regex(/^\d{1,6}$/),
  status: z.number().int(),
});
const snapshot = z.object({
  supported: z.boolean(),
  incomplete: z.boolean(),
  processes: z.array(identity).max(256),
  missing: z.array(z.number().int()).max(256),
  mismatched: z.array(z.number().int()).max(256),
});
const executable = fileURLToPath(
  new URL("./process-snapshot-helper", import.meta.url),
);
const execute = promisify(execFile);
type ProcessIdentity = z.infer<typeof identity>;

/** Read-only observations; these identities are never used as signal targets. */
export class ProcessObservation {
  private known = new Map<number, ProcessIdentity>();
  private current: ProcessIdentity[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private closed = false;
  private captured = false;
  private valid = false;
  private incomplete = false;
  private supported = process.platform === "darwin";
  constructor(
    private readonly root: number,
    private readonly changed: () => void = () => {},
  ) {}
  get survivors() {
    return this.valid
      ? this.current.filter((row) => row.pid !== this.root && row.status !== 5)
      : [];
  }
  get unresolved() {
    return [...this.known.keys()].some((pid) => pid !== this.root);
  }
  get note() {
    if (!this.supported)
      return "Descendant observation unavailable on this platform; process-group cleanup does not cover detached processes.";
    const survivors = this.survivors;
    return (
      (survivors.length
        ? `Observed descendants: ${survivors
            .slice(0, 16)
            .map(
              (row) =>
                `${row.pid}${row.pgid !== this.root ? " (outside original group)" : ""}`,
            )
            .join(
              ", ",
            )}${survivors.length > 16 ? ` and ${survivors.length - 16} more` : ""}. Detached processes are not stopped automatically.`
        : "No surviving descendants in the current observation.") +
      (!this.valid || !this.captured || this.incomplete
        ? " Observation incomplete; descendant state may be unknown."
        : "") +
      " Cleanup covers the original process group only. Sampling can miss processes that detach before observation."
    );
  }
  sample() {
    if (this.closed) return Promise.resolve();
    return (this.pending ??= this.observe().finally(() => {
      this.pending = undefined;
      if (
        !this.closed &&
        this.supported &&
        (!this.captured || this.known.size)
      ) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.sample(), 1000);
        this.timer.unref();
      }
    }));
  }
  private async observe() {
    if (!this.supported) return;
    const previous = this.note;
    // Once an observed process is gone or its PID is reused, never reacquire it
    // by bare PID. Only the very first root observation can omit identity.
    const tokens = this.captured
      ? [...this.known.values()].map(
          (row) => `${row.pid}:${row.startSec}:${row.startUsec}`,
        )
      : [`${this.root}:0:0`];
    if (!tokens.length) return;
    try {
      const { stdout } = await execute(executable, tokens, {
        encoding: "utf8",
        timeout: 1000,
        maxBuffer: 128 * 1024,
      });
      const result = snapshot.parse(JSON.parse(stdout));
      this.supported = result.supported;
      this.valid = result.supported;
      this.incomplete ||= result.incomplete;
      this.current = result.processes;
      if (!result.supported) return;
      for (const pid of [...result.missing, ...result.mismatched])
        this.known.delete(pid);
      for (const row of result.processes) {
        if (row.status === 5) this.known.delete(row.pid);
        else this.known.set(row.pid, row);
      }
      // A missed first root cannot be safely reacquired by its numeric PID later.
      this.captured = true;
      if (!result.processes.length && !this.known.size)
        this.incomplete ||= tokens[0]?.endsWith(":0:0") ?? false;
      if (this.known.size > 256) {
        this.known = new Map([...this.known].slice(0, 256));
        this.incomplete = true;
      }
    } catch {
      this.valid = false;
      this.current = [];
      this.incomplete = true;
      // Do not retry an unverified bare PID after the first observation failed.
      this.captured = true;
    } finally {
      if (this.note !== previous) this.changed();
    }
  }
  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.pending;
  }
}
