import { Editor, truncateToWidth, visibleWidth } from "./primitives.ts";

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Put activity in the existing border; never animate an idle editor. */
export class ActivityEditor extends Editor {
  private activity = "";
  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private animated = false;

  setActivity(label = "", animate = true) {
    const animated = !!label && animate;
    if (this.activity === label && this.animated === animated) return;
    this.activity = label;
    this.animated = animated;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.frame = 0;
    if (animated) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % frames.length;
        this.tui.requestRender();
      }, 80);
      this.timer.unref();
    }
    this.tui.requestRender();
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number) {
    if (!this.activity || width < 5)
      return super.renderTopBorder(width, hiddenLineCount);
    const overflow = hiddenLineCount > 0 ? ` · ↑ ${hiddenLineCount} more` : "";
    const text = `${this.animated ? frames[this.frame] + " " : ""}${this.activity}${overflow}`;
    const label = truncateToWidth(text, Math.max(1, width - 4), "");
    return this.borderColor(
      `── ${label} ${"─".repeat(Math.max(0, width - visibleWidth(label) - 4))}`,
    );
  }

  dispose() {
    this.setActivity();
  }
}
