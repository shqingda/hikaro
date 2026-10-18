import { constants } from "node:fs";
import {
  mkdir,
  lstat,
  open,
  readdir,
  rename,
  unlink,
  realpath,
} from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

// Synthetic development identities only; never the user's ~/.hikaro or Keychain.
export async function openLab(directory) {
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700
  )
    throw Error(
      "Lab must be a private, owned directory without symbolic links",
    );
  directory = await realpath(directory);
  const path = (name) => {
    if (basename(name) !== name || name === "." || name === "..")
      throw Error("Invalid lab filename");
    return join(directory, name);
  };
  const readText = async (name) => {
    let file;
    try {
      file = await open(path(name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 65536
      )
        throw Error("Unsafe lab file");
      return await file.readFile("utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    } finally {
      await file?.close();
    }
  };
  const read = async (name) => {
    const text = await readText(name);
    return text === null ? null : JSON.parse(text);
  };
  const writeText = async (name, value) => {
    const temp = path(".write-" + randomUUID());
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
      await file.close();
      await rename(temp, path(name));
    } finally {
      await file.close().catch(() => {});
      await unlink(temp).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
  const write = (name, value) => writeText(name, JSON.stringify(value));
  const marker = await read("owner.json");
  if (!marker) {
    if ((await readdir(directory)).length)
      throw Error("Lab directory must be owned or empty");
    await write("owner.json", { kind: "hikaro-mobile-lab-v1" });
  } else if (marker.kind !== "hikaro-mobile-lab-v1")
    throw Error("Lab directory is not owned by Hikaro");
  return { directory, read, write, readText, writeText };
}

export async function lockLab(lab) {
  const path = join(lab.directory, "run.lock");
  const owner = { pid: process.pid, nonce: randomUUID() };
  let file;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      file = await open(path, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await lab.read("run.lock");
      if (!Number.isSafeInteger(previous?.pid) || previous.pid <= 0)
        throw Error("Invalid lab lock; inspect run.lock");
      try {
        process.kill(previous.pid, 0);
      } catch (check) {
        if (check.code !== "ESRCH") throw check;
        await unlink(path);
        continue;
      }
      throw Error(
        "Mobile lab is already running; use its terminal or stop it first",
      );
    }
  }
  if (!file) throw Error("Cannot claim mobile lab lock");
  await file.writeFile(JSON.stringify(owner));
  await file.close();
  return async () => {
    if ((await lab.read("run.lock"))?.nonce === owner.nonce) await unlink(path);
  };
}
