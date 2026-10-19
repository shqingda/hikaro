import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  Credential,
  CredentialStore,
  CredentialInfo,
  AuthOperationOptions,
} from "@earendil-works/pi-ai";
export class KeychainCredentials implements CredentialStore {
  private namespace: string;
  private cache: Record<string, CredentialInfo> = {};
  private checked = 0;
  constructor(private home: string) {
    this.namespace = createHash("sha256")
      .update(home)
      .digest("hex")
      .slice(0, 16);
  }
  invalidate() {
    this.checked = 0;
  }
  private async index() {
    if (Date.now() - this.checked < 1000) return this.cache;
    try {
      this.cache = JSON.parse(
        await readFile(join(this.home, "auth-index.json"), "utf8"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.cache = {};
    }
    this.checked = Date.now();
    return this.cache;
  }
  private async entry(id: string) {
    if (!/^[a-z0-9-]+$/.test(id)) throw Error("Invalid provider");
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry("hikaro.providers", this.namespace + ":" + id);
  }
  async read(id: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    if (!(await this.index())[id]) return undefined;
    const value = await (await this.entry(id)).getPassword(options?.signal);
    return value ? (JSON.parse(value) as Credential) : undefined;
  }
  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();
    return Object.values(await this.index());
  }
  private async locked<T>(fn: () => Promise<T>, signal?: AbortSignal) {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const lock = join(this.home, ".auth.lock");
    const until = Date.now() + 15000;
    for (;;) {
      signal?.throwIfAborted();
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let stale = false;
        try {
          const pid = Number(await readFile(join(lock, "pid"), "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (error) {
              stale = (error as NodeJS.ErrnoException).code === "ESRCH";
            }
          }
        } catch {
          const info = await stat(lock).catch(() => undefined);
          stale = !!info && Date.now() - info.mtimeMs > 30000;
        }
        if (stale) {
          const abandoned = lock + "." + randomUUID();
          try {
            await rename(lock, abandoned);
            await rm(abandoned, { recursive: true, force: true });
          } catch {}
          continue;
        }
        if (Date.now() > until)
          throw Error("Credential store is busy; retry sign-in.");
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try {
      await writeFile(join(lock, "pid"), String(process.pid), {
        mode: 0o600,
        flag: "wx",
      });
      this.checked = 0;
      return await fn();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  private async record(id: string, type?: Credential["type"]) {
    const index = await this.index();
    if (type) index[id] = { providerId: id, type };
    else delete index[id];
    const temp = join(this.home, `.auth-${randomUUID()}.json`);
    await writeFile(temp, JSON.stringify(index), { mode: 0o600, flag: "wx" });
    await rename(temp, join(this.home, "auth-index.json"));
    this.cache = index;
    this.checked = Date.now();
  }
  async modify(
    id: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    return this.locked(async () => {
      const current = await this.read(id, options);
      const next = await fn(current);
      options?.signal?.throwIfAborted();
      if (next) {
        await (
          await this.entry(id)
        ).setPassword(JSON.stringify(next), options?.signal);
        await this.record(id, next.type);
      }
      return next ?? current;
    }, options?.signal);
  }
  async delete(id: string, options?: AuthOperationOptions) {
    await this.locked(async () => {
      await (await this.entry(id)).deletePassword(options?.signal);
      await this.record(id);
    }, options?.signal);
  }
}
