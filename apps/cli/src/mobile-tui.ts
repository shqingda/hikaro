import { SharedHostClient } from "../../../packages/host/src/client.ts";
import type { RuntimeOptions } from "../../../packages/runtime/src/index.ts";
import { serveSharedHost } from "./shared-host.ts";
import { attachTui } from "./attached-tui.ts";
/** Start the existing host and client in one terminal; never take ownership of an external host. */
export async function openMobileTui(
  options: Omit<RuntimeOptions, "approve"> & {
    session?: string;
    newSession?: boolean;
    pairOnStart?: boolean;
    pairingCode?: string;
    initialDraft?: string;
  },
) {
  let host: Awaited<ReturnType<typeof serveSharedHost>> | undefined;
  try {
    const probe = await SharedHostClient.connect({
      ...options,
      clientId: "mobile-startup",
    });
    await probe.close();
  } catch (e) {
    if (
      !["ENOENT", "ECONNREFUSED"].includes(
        ((e as Error).cause as NodeJS.ErrnoException)?.code ??
          (e as NodeJS.ErrnoException).code ??
          "",
      )
    )
      throw e;
    host = await serveSharedHost(options);
  }
  try {
    await attachTui({ ...options, mobile: true, onClose: () => host?.close() });
  } catch (e) {
    await host?.close();
    throw e;
  }
}
