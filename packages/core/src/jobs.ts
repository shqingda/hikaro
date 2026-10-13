import { randomUUID } from "node:crypto";
export type Job = {
  id: string;
  sessionId: string;
  task: string;
  runAt: number;
  state: "queued" | "running" | "completed" | "failed" | "interrupted";
  owner?: string;
  leaseUntil?: number;
  error?: string;
};
export interface JobStore {
  putJob(job: Job): Promise<void>;
  jobs(): Promise<Job[]>;
  claimJob(owner: string, cwd?: string): Promise<Job | undefined>;
  finishJob(
    id: string,
    owner: string,
    state: Job["state"],
    error?: string,
  ): Promise<void>;
  renewJob(id: string, owner: string): Promise<boolean>;
}
export class JobScheduler {
  private owner = randomUUID();
  private timer?: ReturnType<typeof setTimeout>;
  private current?: { job: Job; abort: AbortController };
  private stopped = true;
  constructor(
    private store: JobStore,
    private execute: (job: Job, signal: AbortSignal) => Promise<void>,
    private cwd?: string,
  ) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }
  private async tick() {
    if (this.stopped) return;
    try {
      const job = await this.store.claimJob(this.owner, this.cwd);
      if (job) {
        const abort = new AbortController();
        this.current = { job, abort };
        const heartbeat = setInterval(() => {
          void this.store.renewJob(job.id, this.owner).then(
            (ok) => {
              if (!ok) abort.abort();
            },
            () => abort.abort(),
          );
        }, 10000);
        heartbeat.unref();
        try {
          await this.execute(job, abort.signal);
          await this.store.finishJob(job.id, this.owner, "completed");
        } catch (e) {
          await this.store.finishJob(
            job.id,
            this.owner,
            abort.signal.aborted ? "interrupted" : "failed",
            String(e),
          );
        } finally {
          clearInterval(heartbeat);
          this.current = undefined;
        }
      }
    } catch (e) {
      console.error(`Job scheduler: ${String(e)}`);
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.tick(), 1000);
        this.timer.unref();
      }
    }
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.current?.abort.abort();
    const deadline = Date.now() + 5000;
    while (this.current && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
  }
}
