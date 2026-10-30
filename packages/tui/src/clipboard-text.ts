import { spawn } from "node:child_process";

/** Explicit copy action; page-sized text is passed on stdin, never to a shell. */
export async function copyText(text: string) {
  if (process.platform !== "darwin")
    throw Error(
      "Clipboard copy is unavailable on this platform; use conversation export.",
    );
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/pbcopy", [], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error("Clipboard copy failed")),
    );
    child.stdin.end(text);
  });
}
