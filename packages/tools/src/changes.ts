import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as z from "zod";
import { readTextFile } from "./secure-files.ts";
import { updateTextFile } from "./workspace.ts";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const recordSchema = z.object({
  id: z.string().uuid(),
  path: z.string().startsWith("/"),
  timestamp: z.number(),
  before: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  after: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["prepared", "committed", "reverting", "reverted"]),
});
export type FileChange = z.infer<typeof recordSchema>;

/** Journal files are private local data. Snapshots never enter model context. */
export class ChangeJournal {
  constructor(private readonly home: string) {}
  private root?: string;
  private async initialize(create = false) {
    if (this.root) return;
    if (create) await mkdir(this.home, { recursive: true, mode: 0o700 });
    this.root = await realpath(this.home);
  }
  private folder(session: string) {
    return join(this.root ?? this.home, "changes", digest(session));
  }
  private recordPath(session: string, id: string) {
    z.uuid().parse(id);
    return join(this.folder(session), `${id}.json`);
  }
  private async save(path: string, text: string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path);
      const dir = await open(dirname(path), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async record(session: string, id: string) {
    const entry = recordSchema.parse(
      JSON.parse(
        await readTextFile(
          this.recordPath(session, id),
          AbortSignal.timeout(10000),
          65536,
        ),
      ),
    );
    if (entry.id !== id) throw Error("Invalid change record identity");
    return entry;
  }
  private async saveRecord(session: string, entry: FileChange) {
    await this.save(this.recordPath(session, entry.id), JSON.stringify(entry));
  }
  private async snapshot(session: string, text: string) {
    const hash = digest(text);
    await this.save(join(this.folder(session), `${hash}.txt`), text);
    return hash;
  }
  async list(session: string): Promise<FileChange[]> {
    let files: string[];
    try {
      await this.initialize();
      files = await readdir(this.folder(session));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const ids = files.filter((f) => f.endsWith(".json"));
    if (ids.length > 10000)
      throw Error(
        "Change history exceeds 10,000 entries; start a new session.",
      );
    const entries: FileChange[] = [];
    for (const name of ids)
      entries.push(await this.record(session, name.slice(0, -5)));
    return entries.sort(
      (a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id),
    );
  }
  async detail(session: string, id: string) {
    await this.initialize();
    const entry = await this.record(session, id);
    const load = async (hash: string) => {
      const text = await readTextFile(
        join(this.folder(session), `${hash}.txt`),
        AbortSignal.timeout(10000),
        16 * 1024 * 1024,
      );
      if (digest(text) !== hash)
        throw Error("Change snapshot is damaged; rollback refused");
      return text;
    };
    return {
      entry,
      before: entry.before === null ? undefined : await load(entry.before),
      after: await load(entry.after),
    };
  }
  async update(
    session: string,
    path: string,
    signal: AbortSignal,
    replace: (current: string | undefined) => string,
    checkpoint?: () => Promise<void>,
  ) {
    await this.initialize(true);
    let entry: FileChange | undefined,
      before: string | undefined,
      after = "";
    await updateTextFile(
      path,
      signal,
      (current) => {
        before = current;
        after = replace(current);
        return after;
      },
      async () => {
        await checkpoint?.();
        if (before !== after) {
          entry = {
            id: randomUUID(),
            path,
            timestamp: Date.now(),
            before:
              before === undefined
                ? null
                : await this.snapshot(session, before),
            after: await this.snapshot(session, after),
            state: "prepared",
          };
          await this.saveRecord(session, entry);
        }
        await checkpoint?.();
      },
    );
    if (entry) await this.saveRecord(session, { ...entry, state: "committed" });
  }
  async redo(
    session: string,
    id: string,
    signal: AbortSignal,
    checkpoint?: () => Promise<void>,
  ) {
    const { entry, before, after } = await this.detail(session, id);
    if (entry.state !== "reverted")
      throw Error(`This change is ${entry.state}; redo is unavailable.`);
    // Record reapplication as a new edit, so it can itself be undone and audited.
    await this.update(
      session,
      entry.path,
      signal,
      (current) => {
        if (current !== before)
          throw Error(
            "File changed after rollback. Preserve the newer work; redo refused.",
          );
        return after;
      },
      async () => {
        await checkpoint?.();
        if ((await this.record(session, id)).state !== "reverted")
          throw Error("Change state changed; redo refused.");
      },
    );
    return entry;
  }
  async rollback(
    session: string,
    id: string,
    signal: AbortSignal,
    checkpoint?: () => Promise<void>,
  ) {
    const { entry, before, after } = await this.detail(session, id);
    if (entry.state !== "committed")
      throw Error(
        `This change is ${entry.state}; automatic rollback is unavailable.`,
      );
    await updateTextFile(
      entry.path,
      signal,
      (current) => {
        if (current !== after)
          throw Error(
            "File changed after this edit. Preserve the newer work; review it before retrying.",
          );
        return before;
      },
      async () => {
        await checkpoint?.();
        const current = await this.record(session, id);
        if (current.state !== "committed")
          throw Error(`This change is ${current.state}`);
        await this.saveRecord(session, { ...entry, state: "reverting" });
        await checkpoint?.();
      },
    );
    await this.saveRecord(session, { ...entry, state: "reverted" });
    return entry;
  }
}
