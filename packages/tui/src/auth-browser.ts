import { spawn } from "node:child_process";
import type { AuthEvent } from "@earendil-works/pi-ai";
export function authenticationUrl(event: AuthEvent) {
  return event.type === "auth_url"
    ? event.url
    : event.type === "device_code"
      ? event.verificationUri
      : undefined;
}
export async function openAuthenticationUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw Error("Unsupported authentication URL");
  return new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", [parsed.toString()], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              "Could not open the browser. Open the displayed URL manually.",
            ),
          ),
    );
  });
}
