import { homedir } from "node:os";
import { join } from "node:path";
import type { HikaroView } from "../../../packages/tui/src/index.ts";
import { readConfig } from "../../../packages/remote/src/host-store.ts";
import { pairDevice, serveRemote } from "../../../packages/remote/src/host.ts";
const defaults = {
  readConfig,
  pair: pairDevice,
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
    const config = await this.configured();
    const options: Parameters<typeof pairDevice>[0] = {
      home: this.options.home,
    };
    if (!config || config.registered === false) {
      const { panel, close } = view.openModelPanel();
      try {
        if (!config)
          options.relay = (
            await panel.prompt("手机连接 · 输入已部署的 relay 地址（wss://…）")
          ).trim();
        options.bootstrap = await panel.prompt(
          "首次注册 · 输入 relay bootstrap 密钥（隐藏输入）",
          true,
        );
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        throw e;
      } finally {
        close();
      }
    }
    const code = await this.deps.pair(options);
    if (this.closed) return;
    return code;
  }
  async show(view: HikaroView, code: string) {
    await this.start(view);
    view.showPairing(code, await this.deps.qr(code));
  }
  async pair(view: HikaroView) {
    const code = await this.prepare(view);
    if (code) await this.show(view, code);
  }
  async close() {
    this.closed = true;
    await this.bridge?.close();
  }
}
