import { constants } from "node:fs";
import { open, mkdir, lstat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { IntentStore, Intent } from "../../client-core/src/connection.ts";

/** Private per-workspace/per-view files. Payloads are never automatically sent. */
export class ClientFiles implements IntentStore {
  private constructor(private path: string) {}
  static async open(home: string, key: string, scope: string) {
    const root = join(home, "shared-clients");
    const path = join(
      root,
      createHash("sha256")
        .update(key + "\0" + scope)
        .digest("hex"),
    );
    for (const directory of [root, path]) {
      await mkdir(directory, { mode: 0o700 }).catch((e) => {
        if (e.code !== "EEXIST") throw e;
      });
      const stat = await lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.uid !== process.getuid!() ||
        (stat.mode & 0o777) !== 0o700
      )
        throw Error("Unsafe client state directory");
    }
    return new ClientFiles(path);
  }
  private async read(name: string): Promise<unknown> {
    let file;
    try {
      file = await open(
        join(this.path, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (e: any) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid!() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 1_048_576
      )
        throw Error("Unsafe client state file");
      return JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  }
  private async write(name: string, value: unknown) {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 1_048_576)
      throw Error("Client state capacity exceeded");
    const temp = join(this.path, randomUUID() + ".tmp");
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
      await file.close();
      await rename(temp, join(this.path, name));
      const directory = await open(this.path, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await file.close().catch(() => {});
      await unlink(temp).catch(() => {});
    }
  }
  preferences() {
    return this.read("preferences.json");
  }
  savePreferences(value: unknown) {
    return this.write("preferences.json", value);
  }
  async load(): Promise<Intent[]> {
    const value = await this.read("intents.json");
    if (value === null) return [];
    if (!Array.isArray(value)) throw Error("Invalid client intents");
    return value;
  }
  save(intents: Intent[]) {
    return this.write("intents.json", intents);
  }
  private draftName(session: string) {
    return createHash("sha256").update(session).digest("hex") + ".draft.json";
  }
  async draft(session: string) {
    const value = await this.read(this.draftName(session));
    if (value === null) return "";
    if (typeof value !== "string" || value.length > 100000)
      throw Error("Invalid local draft");
    return value;
  }
  saveDraft(session: string, text: string) {
    if (text.length > 100000) return Promise.reject(Error("Draft is too long"));
    return this.write(this.draftName(session), text);
  }
}
