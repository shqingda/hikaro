import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { constants } from "node:os";
import { cleanProcessEnv } from "./process.ts";

const capacity = 16 * 1024 * 1024;
const executable = fileURLToPath(
  new URL("./secure-file-helper", import.meta.url),
);
export class SecureFileError extends Error {
  constructor(
    message: string,
    readonly errno?: number,
  ) {
    super(message);
  }
}
export const isFileTooLarge = (error: unknown) =>
  error instanceof SecureFileError && error.errno === constants.errno.EFBIG;

// Length-delimited bytes never pass through a line decoder, shell, or pathname
// reopen. The native process retains its directory/file descriptors throughout.
class Frames {
  private buffer: Buffer = Buffer.alloc(0);
  private iterator: AsyncIterator<Buffer>;
  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  private async more() {
    const part = await this.iterator.next();
    if (part.done)
      throw Error("Secure file helper closed before completing its response");
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, part.value])
      : part.value;
  }
  async header() {
    while (!this.buffer.includes(10)) {
      if (this.buffer.length > 8192)
        throw Error("Invalid secure file response");
      await this.more();
    }
    const end = this.buffer.indexOf(10);
    if (end > 8192) throw Error("Invalid secure file response");
    const frame: unknown = JSON.parse(
      this.buffer.subarray(0, end).toString("utf8"),
    );
    this.buffer = this.buffer.subarray(end + 1);
    if (!frame || typeof frame !== "object")
      throw Error("Invalid secure file response");
    const data = frame as Record<string, unknown>;
    if (typeof data.error === "string")
      throw new SecureFileError(
        data.error,
        typeof data.errno === "number" ? data.errno : undefined,
      );
    return data;
  }
  async bytes(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || length > capacity)
      throw Error("Invalid secure file response length");
    const parts: Buffer[] = [];
    let remaining = length;
    while (remaining) {
      if (!this.buffer.length) await this.more();
      const count = Math.min(this.buffer.length, remaining);
      parts.push(this.buffer.subarray(0, count));
      this.buffer = this.buffer.subarray(count);
      remaining -= count;
    }
    return Buffer.concat(parts, length);
  }
}

function start(
  mode: "read" | "update" | "read-many",
  path: string,
  signal: AbortSignal,
  limit: number,
) {
  signal.throwIfAborted();
  const batch = mode === "read-many";
  if (
    (!batch && (!path.startsWith("/") || path.includes("\0"))) ||
    (batch && !/^(?:[1-9][0-9]?|100)$/.test(path)) ||
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > capacity
  )
    throw Error("Invalid secure file request");
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw Error(
      "Secure file operations require macOS or Linux; refusing unsafe fallback",
    );
  const child = spawn(executable, [mode, path, String(limit)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanProcessEnv(),
  });
  const frames = new Frames(child.stdout);
  let ended = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let diagnostics = "";
  child.stderr.on("data", (data: Buffer) => {
    if (diagnostics.length < 4096)
      diagnostics += data.toString("utf8").slice(0, 4096 - diagnostics.length);
  });
  child.stdin.on("error", () => {});
  const stop = () => {
    if (ended || escalation) return;
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), 1000);
  };
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", (error) =>
      reject(
        new Error(
          `Secure file helper unavailable; run pnpm install or pnpm build. Refusing unsafe fallback: ${error.message}`,
        ),
      ),
    );
    child.once("close", (code) => {
      ended = true;
      if (escalation) clearTimeout(escalation);
      signal.removeEventListener("abort", stop);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            diagnostics.trim() || "Secure file operation did not complete",
          ),
        );
    });
  });
  // A helper can fail before its first frame is consumed.
  void done.catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const send = (data: string | Buffer) =>
    new Promise<void>((resolve, reject) =>
      child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
    );
  return {
    frames,
    done,
    send,
    async snapshot() {
      let header: Record<string, unknown>;
      try {
        header = await frames.header();
      } catch (error) {
        if (error instanceof SecureFileError) throw error;
        await done;
        throw error;
      }
      if (
        typeof header.exists !== "boolean" ||
        !Number.isSafeInteger(header.length) ||
        Number(header.length) > limit
      )
        throw Error("Invalid secure file snapshot");
      const content = await frames.bytes(Number(header.length));
      signal.throwIfAborted();
      return header.exists ? content : undefined;
    },
    async close() {
      child.stdin.end();
      // An interrupted batch may have unread frames. Release the pipe so a
      // helper that already exited cannot wait forever for stdout consumption.
      child.stdout.destroy();
      stop();
      await done.catch(() => {});
    },
  };
}

/** The caller must authorize a canonical path before opening it. */
export async function readFileBytes(
  path: string,
  signal: AbortSignal,
  limit = 2_000_000,
) {
  const worker = start("read", path, signal, limit);
  try {
    const content = await worker.snapshot();
    if (content === undefined) throw Error("File does not exist");
    await worker.done;
    signal.throwIfAborted();
    return content;
  } finally {
    await worker.close();
  }
}

export async function readTextFile(
  path: string,
  signal: AbortSignal,
  limit = 2_000_000,
) {
  return (await readFileBytes(path, signal, limit)).toString("utf8");
}

/** Authorize every canonical path first. Results are provisional until this
 * promise succeeds; consume each result immediately rather than retaining file
 * bodies. Individual file errors continue, while IPC failure/cancellation aborts
 * the batch. At most one file body and bounded pipe buffers are held at a time. */
export async function readFileBytesBatch(
  paths: readonly string[],
  signal: AbortSignal,
  receive: (result: PromiseSettledResult<Buffer>, index: number) => void,
  limit = 2_000_000,
) {
  signal.throwIfAborted();
  if (
    paths.length > 100 ||
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > 2_000_000 ||
    paths.some(
      (path) =>
        !path.startsWith("/") ||
        path.includes("\0") ||
        Buffer.byteLength(path) > 32768,
    )
  )
    throw Error(
      "Invalid secure file batch (100 paths and 2,000,000 byte limit)",
    );
  if (!paths.length) return;
  const worker = start("read-many", String(paths.length), signal, limit);
  // Send and consume concurrently: either pipe may apply backpressure before a
  // large manifest or file finishes. Every input byte is bounded and authorized.
  const request = worker.send(
    Buffer.concat(
      paths.flatMap((path) => {
        const bytes = Buffer.from(path);
        return [Buffer.from(`${bytes.length}\n`), bytes];
      }),
    ),
  );
  void request.catch(() => {});
  try {
    for (let index = 0; index < paths.length; index++) {
      signal.throwIfAborted();
      let result: PromiseSettledResult<Buffer>;
      try {
        const content = await worker.snapshot();
        if (content === undefined) throw Error("Invalid secure file snapshot");
        result = { status: "fulfilled", value: content };
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof SecureFileError)) throw error;
        result = { status: "rejected", reason: error };
      }
      receive(result, index);
    }
    await request;
    await worker.done;
    signal.throwIfAborted();
  } finally {
    await worker.close();
    await request.catch(() => {});
  }
}

export async function replaceTextFile(
  path: string,
  signal: AbortSignal,
  replace: (current: string | undefined) => string | undefined,
  beforeCommit?: () => Promise<void>,
) {
  const worker = start("update", path, signal, capacity);
  try {
    const current = await worker.snapshot();
    const next = replace(current?.toString("utf8"));
    const content = Buffer.from(next ?? "");
    if (content.length > capacity) throw Error("File update exceeds 16 MiB");
    signal.throwIfAborted();
    await worker.send(
      next === undefined ? "DELETE\n" : `PREPARE ${content.length}\n`,
    );
    await worker.send(content);
    if ((await worker.frames.header()).prepared !== true)
      throw Error("Invalid secure file prepare response");
    await beforeCommit?.();
    signal.throwIfAborted();
    await worker.send("COMMIT\n");
    if ((await worker.frames.header()).committed !== true)
      throw Error("Invalid secure file commit response");
    await worker.done;
  } finally {
    await worker.close();
  }
}
