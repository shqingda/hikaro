import { homedir } from "node:os";
import { join } from "node:path";
import type { HikaroView } from "../../../packages/tui/src/index.ts";
import { readConfig } from "../../../packages/remote/src/host-store.ts";
import { serveRemote } from "../../../packages/remote/src/host.ts";
import { setTimeout as pause } from "node:timers/promises";
import {
  createPairingInvite,
  pairingRequest,
  acceptPairingClaim,
  validateClaim,
} from "../../../packages/remote/src/pairing-host.ts";
import { pairingFingerprint } from "../../../packages/remote/src/pairing-client.ts";
import { lanOrigins } from "../../../packages/remote/src/lan.ts";
const defaults = {
  readConfig,
  lanOrigins,
  pair: createPairingInvite,
  request: pairingRequest,
  accept: acceptPairingClaim,
  serve: serveRemote,
  async qr(code: string) {
    const { default: qr } = await import("qrcode-terminal");
    return new Promise<string>((resolve) =>
      qr.generate(code, { small: true }, resolve),
    );
  },
};
export async function hasMobileConfig(home?: string) {
  try {
    await readConfig(home ?? join(homedir(), ".hikaro"));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
/** One TUI owns its bridge; device grants still use the existing host checks. */
export class MobilePairing {
  private bridge?: Awaited<ReturnType<typeof serveRemote>>;
  private closed = false;
  private invitation?: AbortController;
  constructor(
    private options: { cwd: string; home?: string },
    private deps = defaults,
  ) {}
  private async configured() {
    try {
      return await this.deps.readConfig(
        this.options.home ?? join(homedir(), ".hikaro"),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  async start(view: HikaroView) {
    if (this.closed || this.bridge) return;
    const config = await this.configured();
    if (!config || config.registered === false) return;
    this.bridge = await this.deps.serve({
      ...this.options,
      lan: true,
      approveDevice: async (id) => {
        if (this.closed) return false;
        view.closePairing();
        // Never compete for stdin with the TUI or silently allow enrollment.
        try {
          const { panel, close } = view.openModelPanel();
          try {
            const choice = await panel.choose(
              "确认连接手机",
              [
                { value: "deny", label: "拒绝" },
                { value: "allow", label: "允许这台手机连接" },
              ],
              `设备 ${id}。仅确认你刚刚扫码的手机；已有任务仍需单独授权。`,
            );
            return choice.value === "allow";
          } finally {
            close();
          }
        } catch {
          return false;
        }
      },
    });
    if (this.closed) await this.bridge.close();
  }
  async prepare(view: HikaroView) {
    if (this.closed) return;
    this.invitation?.abort();
    // Read before enrollment so corrupt existing data is never overwritten.
    await this.configured();
    view.notice("正在生成手机配对码…");
    const code = await this.deps.pair({
      home: this.options.home,
      lan: this.deps.lanOrigins(),
    });
    if (this.closed) return;
    return code;
  }
  async show(view: HikaroView, code: string) {
    await this.start(view);
    this.invitation?.abort();
    view.showPairing(code, await this.deps.qr(code));
    if (code.startsWith("hikaro://connect#")) {
      const invite = JSON.parse(decodeURIComponent(code.split("#")[1]!));
      const abort = new AbortController();
      this.invitation = abort;
      void this.waitForPhone(
        view,
        invite.code,
        invite.hostKey,
        abort.signal,
      ).catch((error) => {
        if (!abort.signal.aborted && !this.closed) {
          view.closePairing();
          view.setError(String(error));
        }
      });
    }
  }
  private async waitForPhone(
    view: HikaroView,
    code: string,
    hostKey: string,
    signal: AbortSignal,
  ) {
    const deadline = Date.now() + 300000;
    while (!signal.aborted && !this.closed && Date.now() < deadline) {
      const claim = await this.deps.request(
        this.options.home,
        `/pairings/${code}/request`,
        undefined,
        signal,
      );
      if (signal.aborted || this.closed) return;
      if (claim) {
        validateClaim(claim);
        view.closePairing();
        const { panel, close } = view.openModelPanel();
        let approved = false;
        try {
          const choice = await panel.choose(
            "确认连接手机",
            [
              { value: "deny", label: "拒绝" },
              { value: "allow", label: "核对一致，允许连接" },
            ],
            `请核对手机上的验证指纹：${pairingFingerprint(hostKey, claim.publicKey)}。一致后再允许，任务仍需单独授权。`,
          );
          approved = choice.value === "allow";
        } catch {
          /* Cancel means reject. */
        } finally {
          close();
        }
        if (signal.aborted || this.closed) return;
        if (approved) {
          // The user may leave the confirmation panel open past the invitation expiry.
          const current = await this.deps.request(
            this.options.home,
            `/pairings/${code}/request`,
            undefined,
            signal,
          );
          validateClaim(current);
          if (
            current.deviceId !== claim.deviceId ||
            current.publicKey !== claim.publicKey ||
            current.token !== claim.token
          )
            throw Error("配对请求已变化，请重新输入 /pair。");
          await this.deps.accept(this.options.home, claim);
        }
        await this.deps.request(
          this.options.home,
          `/pairings/${code}/complete`,
          { deviceId: claim.deviceId, approved },
          signal,
        );
        view.notice(
          approved
            ? "手机已配对。使用 /share 授予当前任务的访问权限。"
            : "已拒绝手机连接。输入 /pair 可重新配对。",
        );
        return;
      }
      await pause(1000, undefined, { signal });
    }
    if (!signal.aborted) {
      view.closePairing();
      view.notice("配对码已过期，请输入 /pair 重新生成。");
    }
  }
  async pair(view: HikaroView) {
    const code = await this.prepare(view);
    if (code) await this.show(view, code);
  }
  async close() {
    this.closed = true;
    this.invitation?.abort();
    await this.bridge?.close();
  }
}
