import { execFile } from "node:child_process";

/** Open a pasted image in the system viewer. The path never reaches a shell. */
export function openImage(path: string) {
  if (!path || /[\x00-\x1f\x7f]/.test(path))
    return Promise.reject(Error("Invalid image path"));
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", path] : [path];
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, (error) => (error ? reject(error) : resolve()));
  });
}
