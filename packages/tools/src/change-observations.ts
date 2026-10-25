import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import * as z from "zod";
import { sensitivePath } from "./workspace.ts";
import {
  readFileBytes,
  readFileBytesBatch,
  readTextFile,
} from "./secure-files.ts";

const execute = promisify(execFile);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
import {
  changeOriginSchema,
  type ChangeOrigin,
} from "../../core/src/change-evidence.ts";
const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const observationSchema = z.object({
  id: z.string().uuid(),
  path: z.string().startsWith("/").max(32768),
  timestamp: z.number(),
  before: digest,
  after: digest,
  source: z.enum(["shell", "plugin"]),
  runId: z.string().max(128).optional(),
  ...changeOriginSchema.shape,
});
export type ObservedChange = z.infer<typeof observationSchema>;
type Origin = ChangeOrigin & { source: "shell" | "plugin"; runId?: string };
type Snapshot = {
  files: Map<string, string>;
  present: Set<string>;
  complete: boolean;
  warnings: string[];
};
const fileLimit = 16 * 1024 * 1024,
  totalLimit = 64 * 1024 * 1024,
  batchFileLimit = 2_000_000;

/** Best-effort observations are never a write journal or proof of authorship. */
export class ChangeObservations {
  private root?: string;
  private failures = new Map<string, string>();
  constructor(private readonly home: string) {}
  private folder(session: string) {
    return join(this.root ?? this.home, "observations", hash(session));
  }
  private async save(session: string, name: string, text: string) {
    this.root ??= await realpath(this.home);
    const folder = this.folder(session);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if ((await realpath(folder)) !== folder)
      throw Error("Observation directory is linked");
    const temp = join(folder, `${randomUUID()}.tmp`);
    try {
      await writeFile(temp, text, { flag: "wx", mode: 0o600 });
      await rename(temp, join(folder, name));
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async snapshot(
    cwd: string,
    budget: { remaining: number },
  ): Promise<Snapshot> {
    const snapshot: Snapshot = {
      files: new Map(),
      present: new Set(),
      complete: true,
      warnings: [],
    };
    const warn = (message: string) => {
      if (!snapshot.warnings.includes(message)) snapshot.warnings.push(message);
    };
    const signal = AbortSignal.timeout(5000);
    let names: string[];
    try {
      const { stdout } = await execute(
        "rg",
        [
          "--no-config",
          "--files",
          "--hidden",
          "--no-require-git",
          "-0",
          "-g",
          "!.git",
        ],
        { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal },
      );
      names = stdout.split("\0").filter(Boolean).sort();
    } catch (error) {
      if ((error as { code?: number }).code === 1) names = [];
      else {
        snapshot.complete = false;
        warn("File enumeration failed or exceeded its time/output limit.");
        return snapshot;
      }
    }
    if (names.length > 10000) {
      snapshot.complete = false;
      warn("File enumeration exceeds 10,000 candidates.");
      names = names.slice(0, 10000);
    }
    const root = await realpath(cwd),
      home = await realpath(this.home);
    const unreadable = () =>
      warn("Some files could not be read safely within the snapshot limit.");
    const accept = (path: string, buffer: Buffer) => {
      budget.remaining -= buffer.length;
      if (buffer.includes(0)) {
        warn("Binary files were excluded.");
        return;
      }
      try {
        snapshot.files.set(
          path,
          new TextDecoder("utf-8", { fatal: true }).decode(buffer),
        );
      } catch {
        warn("Non-UTF-8 files were excluded.");
      }
    };
    let pending: string[] = [];
    const flush = async () => {
      if (!pending.length) return;
      const paths = pending;
      pending = [];
      try {
        await readFileBytesBatch(
          paths,
          signal,
          (result, index) => {
            if (result.status === "fulfilled")
              accept(paths[index]!, result.value);
            else unreadable();
          },
          Math.min(batchFileLimit, budget.remaining),
        );
      } catch {
        // Callback data is provisional until the whole helper request succeeds.
        // Consumed bytes still count against the shared before/after budget.
        for (const path of paths) snapshot.files.delete(path);
        snapshot.complete = false;
        unreadable();
      }
    };

    for (const name of names) {
      const path = resolve(root, name),
        rel = relative(root, path);
      if (isAbsolute(rel) || rel.startsWith("../") || sensitivePath.test(path))
        continue;
      // Never snapshot our own evidence, including isolated homes used as workspaces.
      if (
        home.startsWith(root + "/") &&
        (path === home || path.startsWith(home + "/"))
      )
        continue;
      if (
        root === home &&
        /^(?:observations|changes|plans|outputs|artifacts)(?:\/|$)|^sessions\.sqlite/.test(
          rel,
        )
      )
        continue;
      snapshot.present.add(path);
      try {
        signal.throwIfAborted();
        const stat = await lstat(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          (await realpath(path)) !== path
        ) {
          warn("Non-regular or linked paths were excluded.");
          continue;
        }
        if (stat.size > fileLimit || stat.size > budget.remaining) {
          warn("Snapshot exceeds the 16 MiB file or 64 MiB total limit.");
          continue;
        }
        if (stat.size <= batchFileLimit) {
          pending.push(path);
          const limit = Math.min(batchFileLimit, budget.remaining);
          // Reserve each entry's full read limit, not its earlier stat size:
          // files may grow before opening, but the batch must fit the budget.
          const count = limit ? Math.floor(budget.remaining / limit) : 100;
          if (pending.length >= Math.min(100, count)) await flush();
        } else {
          await flush();
          if (stat.size > budget.remaining) {
            warn("Snapshot exceeds the 16 MiB file or 64 MiB total limit.");
            continue;
          }
          accept(
            path,
            await readFileBytes(
              path,
              signal,
              Math.min(fileLimit, budget.remaining),
            ),
          );
        }
      } catch {
        unreadable();
      }
      if (signal.aborted) {
        snapshot.complete = false;
        break;
      }
    }
    await flush();
    if (signal.aborted) snapshot.complete = false;
    return snapshot;
  }
  async capture<T>(
    session: string,
    cwd: string,
    origin: Origin,
    run: () => Promise<T>,
  ): Promise<T> {
    const budget = { remaining: totalLimit };
    let before: Snapshot;
    try {
      before = await this.snapshot(cwd, budget);
    } catch {
      before = {
        files: new Map(),
        present: new Set(),
        complete: false,
        warnings: ["Initial snapshot unavailable."],
      };
    }
    try {
      return await run();
    } finally {
      try {
        const after = await this.snapshot(cwd, budget);
        const warnings = [...new Set([...before.warnings, ...after.warnings])];
        const timestamp = Date.now();
        const ignoreChanged = [
          ...new Set([...before.files.keys(), ...after.files.keys()]),
        ].some(
          (path) =>
            /(?:^|\/)(?:\.gitignore|\.ignore|\.rgignore)$/.test(path) &&
            before.files.get(path) !== after.files.get(path),
        );
        if (ignoreChanged)
          warnings.push(
            "Ignore rules changed; file additions/deletions may be incomplete.",
          );
        for (const path of new Set([
          ...before.files.keys(),
          ...after.files.keys(),
        ])) {
          const a = before.files.get(path),
            b = after.files.get(path);
          // Missing evidence is not a creation/deletion. Only a complete inventory proves absence.
          if (
            (a === undefined &&
              (before.present.has(path) || !before.complete)) ||
            (b === undefined && (after.present.has(path) || !after.complete)) ||
            a === b ||
            (ignoreChanged && (a === undefined || b === undefined))
          )
            continue;
          if (b === undefined) {
            try {
              await lstat(path);
              continue;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
            }
          }
          const entry: ObservedChange = {
            id: randomUUID(),
            path,
            timestamp,
            before: a === undefined ? null : hash(a),
            after: b === undefined ? null : hash(b),
            ...origin,
          };
          if (a !== undefined)
            await this.save(session, entry.before + ".txt", a);
          if (b !== undefined)
            await this.save(session, entry.after + ".txt", b);
          await this.save(
            session,
            entry.id + ".json",
            JSON.stringify(observationSchema.parse(entry)),
          );
        }
        if (warnings.length)
          await this.save(
            session,
            `${randomUUID()}.coverage`,
            JSON.stringify(warnings),
          );
      } catch {
        this.failures.set(
          session,
          "Observation persistence failed; some changes may be missing.",
        );
      }
    }
  }
  private async names(session: string) {
    try {
      this.root ??= await realpath(this.home);
      return await readdir(this.folder(session));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  async warnings(session: string) {
    const warnings = new Set<string>();
    if (this.failures.has(session)) warnings.add(this.failures.get(session)!);
    const names = (await this.names(session))
      .filter((n) => n.endsWith(".coverage"))
      .slice(-100);
    await readFileBytesBatch(
      names.map((name) => join(this.folder(session), name)),
      AbortSignal.timeout(5000),
      (result) => {
        if (result.status === "rejected") throw result.reason;
        const rows = z
          .array(z.string().max(200))
          .max(20)
          .parse(JSON.parse(result.value.toString("utf8")));
        for (const row of rows) warnings.add(row);
      },
      8192,
    );
    return [...warnings];
  }
  async list(session: string) {
    const names = (await this.names(session)).filter((n) =>
      n.endsWith(".json"),
    );
    if (names.length > 10000)
      throw Error("Observation history exceeds 10,000 records.");
    const rows: ObservedChange[] = [];
    for (let offset = 0; offset < names.length; offset += 100) {
      const batch = names.slice(offset, offset + 100).map((name) => {
        const id = z.string().uuid().parse(name.slice(0, -5));
        return { id, path: join(this.folder(session), name) };
      });
      await readFileBytesBatch(
        batch.map((entry) => entry.path),
        AbortSignal.timeout(5000),
        (result, index) => {
          if (result.status === "rejected") throw result.reason;
          rows.push(
            this.parseRecord(batch[index]!.id, result.value.toString("utf8")),
          );
        },
        65536,
      );
    }
    return rows;
  }
  private parseRecord(id: string, text: string) {
    const entry = observationSchema.parse(JSON.parse(text));
    if (entry.id !== id) throw Error("Invalid observation identity");
    return entry;
  }
  private async record(session: string, id: string) {
    this.root ??= await realpath(this.home);
    z.string().uuid().parse(id);
    return this.parseRecord(
      id,
      await readTextFile(
        join(this.folder(session), id + ".json"),
        AbortSignal.timeout(5000),
        65536,
      ),
    );
  }
  async detail(session: string, id: string) {
    const entry = await this.record(session, id);
    const load = async (digest: string | null) => {
      if (digest === null) return undefined;
      const text = await readTextFile(
        join(this.folder(session), digest + ".txt"),
        AbortSignal.timeout(5000),
        fileLimit,
      );
      if (hash(text) !== digest) throw Error("Observation snapshot is damaged");
      return text;
    };
    return {
      entry,
      before: await load(entry.before),
      after: await load(entry.after),
    };
  }
  async removeSession(session: string) {
    this.failures.delete(session);
    await rm(this.folder(session), { recursive: true, force: true });
  }
}
