import { constants } from "node:fs";
import { mkdir, realpath, lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export async function hostEndpoint(options: { cwd: string; home?: string }) {
  const home = options.home ?? join(homedir(), ".hikaro");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const canonicalHome = await realpath(home),
    cwd = await realpath(options.cwd);
  const root = `/tmp/hikaro-${process.getuid!()}`;
  await mkdir(root, { mode: 0o700 }).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o777) !== 0o700
  )
    throw Error("Unsafe shared host directory");
  const key = createHash("sha256")
    .update(canonicalHome + "\0" + cwd)
    .digest("hex")
    .slice(0, 24);
  return {
    home: canonicalHome,
    cwd,
    socket: join(root, key + ".sock"),
    metadata: join(root, key + ".json"),
    key,
  };
}
export type HostEndpoint = Awaited<ReturnType<typeof hostEndpoint>>;
export type HostDescriptor = {
  localToken: string;
  instanceId: string;
  key: string;
};
export async function readDescriptor(
  endpoint: HostEndpoint,
): Promise<HostDescriptor> {
  const file = await open(
    endpoint.metadata,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid!() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 4096
    )
      throw Error("Unsafe shared host credentials");
    const value = JSON.parse(await file.readFile("utf8"));
    if (
      value.key !== endpoint.key ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.localToken) ||
      typeof value.instanceId !== "string"
    )
      throw Error("Invalid shared host credentials");
    const socket = await lstat(endpoint.socket);
    if (
      !socket.isSocket() ||
      socket.uid !== process.getuid!() ||
      (socket.mode & 0o777) !== 0o600
    )
      throw Error("Unsafe shared host socket");
    return value;
  } finally {
    await file.close();
  }
}
