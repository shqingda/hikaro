import { Text, matchesKey, type Component } from "./primitives.ts";
/** QR modules are never wrapped or cropped into a misleading partial code. */
export class PairingScreen implements Component {
  focused = true;
  private showCode = false;
  constructor(
    private code: string,
    private qr: string,
    private rows: () => number,
    private close: () => void,
    private refresh: () => void,
  ) {}
  invalidate() {}
  handleInput(data: string) {
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+d") ||
      matchesKey(data, "ctrl+c")
    )
      this.close();
    else if (matchesKey(data, "tab")) {
      this.showCode = !this.showCode;
      this.refresh();
    }
  }
  render(width: number) {
    const header = "手机配对 · 五分钟内扫码 · 配对码含凭据，请勿转发";
    const help = "Tab 切换二维码/配对码 · Esc 返回任务";
    const qr = this.qr.trimEnd().split("\n");
    if (this.showCode) {
      const lines = [header, ...new Text(this.code, 0, 1).render(width), help];
      return lines.length <= this.rows()
        ? lines
        : [
            header,
            `请放大终端至至少 ${lines.length} 行，或增加宽度以完整显示配对码。`,
            help,
          ];
    }
    const required = Math.max(...qr.map((line) => line.length));
    if (width < required || this.rows() < qr.length + 3)
      return [
        header,
        `请放大终端至至少 ${required} 列 × ${qr.length + 3} 行以完整显示二维码。`,
        help,
      ];
    return [header, "", ...qr.map((line) => `\x1b[97;40m${line}\x1b[0m`), help];
  }
}
