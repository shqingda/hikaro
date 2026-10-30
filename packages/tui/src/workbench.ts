import {
  HStack,
  VStack,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "./primitives.ts";
import { accent, bold, muted, selected } from "./theme.ts";
import { sanitize } from "./text.ts";

export type WorkspaceTab =
  "Conversation" | "Changes" | "Activity" | "Plan" | "Context";
export const workspaceTabs: WorkspaceTab[] = [
  "Conversation",
  "Changes",
  "Activity",
  "Plan",
  "Context",
];
export type WorkspaceSession = {
  id: string;
  title: string;
  state: string;
  unread?: boolean;
  attention?: number;
  current?: boolean;
};
export type WorkbenchAction = {
  id: string;
  title: string;
  description?: string;
  shortcut?: string;
  enabled?: () => boolean | string;
  run(): void | Promise<void>;
};
export class ActionRegistry {
  private actions: WorkbenchAction[] = [];
  set(actions: WorkbenchAction[]) {
    this.actions = actions;
  }
  search(query = "") {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.actions.filter((a) =>
      words.every((word) =>
        `${a.title} ${a.description ?? ""}`.toLowerCase().includes(word),
      ),
    );
  }
  async run(id: string) {
    const action = this.actions.find((a) => a.id === id);
    if (!action) throw Error("Action is no longer available");
    const enabled = action.enabled?.() ?? true;
    if (enabled !== true)
      throw Error(
        typeof enabled === "string" ? enabled : "Action is unavailable",
      );
    await action.run();
  }
}
export function workspaceColumns(width: number, inspector: boolean) {
  return {
    navigation: width >= 100 && (!inspector || width >= 144) ? 22 : 0,
    inspector: inspector && width >= 100 ? 44 : 0,
  };
}
const fit = (text: string, width: number) =>
  truncateToWidth(sanitize(text), Math.max(0, width), "…");

/** Stateful navigation chrome; the renderer retains Pi's cell and cursor mapping. */
export class WorkbenchFrame extends VStack {
  tab: WorkspaceTab = "Conversation";
  sessions: WorkspaceSession[] = [];
  navigationOpen = false;
  private navigationIndex = 0;
  private toolbarActions: {
    row: number;
    start: number;
    end: number;
    run(): void;
  }[] = [];
  private tabRegions: { tab: WorkspaceTab; start: number; end: number }[] = [];
  private sessionRegions: { row: number; id: string }[] = [];
  private navigationActions = new Map<number, () => void>();
  private tabs: WorkspaceTab[] = ["Conversation", "Context"];
  readonly navigation: Component & { focused: boolean };
  readonly tabBar: Component & { focused: boolean };

  constructor(
    private tui: TUI,
    content: Component,
    private callbacks: {
      selectTab(tab: WorkspaceTab): void;
      selectSession(id: string): void;
      sessions(): void;
      actions(): void;
      inspector(): boolean;
      sessionNavigation?: boolean;
      intrinsicHeight?: boolean;
    },
  ) {
    super();
    this.navigation = {
      focused: false,
      render: (width) => {
        const current = this.sessions.find((s) => s.current);
        const attention = this.sessions.reduce(
          (n, s) => n + (s.attention ?? 0),
          0,
        );
        const running = this.sessions.filter((s) =>
          /working|running/i.test(s.state),
        ).length;
        const lines = [muted(" Sessions")];
        if (attention)
          lines.push(accent(fit(` Needs attention  ${attention}`, width)));
        if (running) lines.push(muted(fit(` Running  ${running}`, width)));
        const room = Math.max(1, this.tui.terminal.rows - 12);
        const index = this.navigation.focused
          ? this.navigationIndex
          : Math.max(0, this.sessions.indexOf(current!));
        const start = Math.max(
          0,
          Math.min(index - Math.floor(room / 2), this.sessions.length - room),
        );
        this.sessionRegions = [];
        for (const [i, session] of this.sessions
          .slice(start, start + room)
          .entries()) {
          this.sessionRegions.push({ row: lines.length, id: session.id });
          const line = fit(
            ` ${session.current ? "›" : session.attention ? "!" : session.unread ? "•" : " "} ${session.title}`,
            width,
          );
          lines.push(
            this.navigation.focused && start + i === this.navigationIndex
              ? selected(line)
              : line,
          );
          if (
            width >= 22 &&
            this.sessions.length <= 4 &&
            session.state !== "Ready"
          ) {
            this.sessionRegions.push({ row: lines.length, id: session.id });
            lines.push(muted(fit(`   ${session.state}`, width)));
          }
        }
        lines.push("");
        this.navigationActions.clear();
        if (callbacks.sessionNavigation !== false) {
          this.navigationActions.set(lines.length, callbacks.sessions);
          lines.push(muted(fit(" Ctrl+O all sessions", width)));
        }
        return lines;
      },
      invalidate() {},
      handleInput: (data) => {
        if (matchesKey(data, "up"))
          this.navigationIndex = Math.max(0, this.navigationIndex - 1);
        else if (matchesKey(data, "down"))
          this.navigationIndex = Math.min(
            this.sessions.length - 1,
            this.navigationIndex + 1,
          );
        else if (matchesKey(data, "enter")) {
          const item = this.sessions[this.navigationIndex];
          if (item && callbacks.sessionNavigation !== false)
            callbacks.selectSession(item.id);
        } else if (matchesKey(data, "escape")) {
          this.navigationOpen = false;
          callbacks.selectTab(this.tab);
        }
        tui.requestRender();
      },
      handleMouse: (event) => {
        if (event.type !== "press" || event.button !== "left") return;
        const session = this.sessionRegions.find((s) => s.row === event.y);
        if (session && callbacks.sessionNavigation !== false)
          callbacks.selectSession(session.id);
        else this.navigationActions.get(event.y)?.();
        return { handled: true };
      },
    };
    this.tabBar = {
      focused: false,
      render: (width) => {
        this.tabRegions = [];
        this.toolbarActions = [];
        const full = this.tabs.map((t) => ` ${t} `).join(" ");
        if (!this.tabBar.focused) {
          let offset = 1;
          const buttons = [
            {
              label: `View: ${this.tab} ▾`,
              run: () => {
                tui.setFocus(this.tabBar);
                tui.requestRender();
              },
            },
            ...(callbacks.sessionNavigation !== false
              ? [{ label: "Sessions", run: callbacks.sessions }]
              : []),
            { label: "Commands", run: callbacks.actions },
          ];
          const lines = [" "];
          for (const button of buttons) {
            const text = `[${button.label}]`;
            if (offset + text.length > width && offset > 1) {
              lines.push(" ");
              offset = 1;
            }
            this.toolbarActions.push({
              row: lines.length - 1,
              start: offset,
              end: Math.min(width, offset + text.length),
              run: button.run,
            });
            lines[lines.length - 1] += accent(fit(text, width - offset));
            offset += text.length + 2;
            if (offset <= width) lines[lines.length - 1] += "  ";
          }
          return [...lines, ""];
        }
        if (visibleWidth(full) > width) {
          this.tabRegions.push({ tab: this.tab, start: 0, end: width });
          return [
            accent(fit(` [${this.tab}]  ← → select · Enter open`, width)),
            "",
          ];
        }
        let offset = 0;
        const line = this.tabs
          .map((tab) => {
            const text = ` ${tab} `;
            this.tabRegions.push({
              tab,
              start: offset,
              end: offset + text.length,
            });
            offset += text.length + 1;
            return tab === this.tab
              ? this.tabBar.focused
                ? selected(text)
                : accent(bold(text))
              : muted(text);
          })
          .join(" ");
        return [line, ""];
      },
      invalidate() {},
      handleInput: (data) => {
        const delta =
          matchesKey(data, "left") || matchesKey(data, "up")
            ? -1
            : matchesKey(data, "right") || matchesKey(data, "down")
              ? 1
              : 0;
        if (delta) {
          callbacks.selectTab(
            this.tabs[
              (this.tabs.indexOf(this.tab) + delta + this.tabs.length) %
                this.tabs.length
            ]!,
          );
          tui.setFocus(this.tabBar);
        } else if (matchesKey(data, "enter")) callbacks.selectTab(this.tab);
      },
      handleMouse: (event) => {
        if (event.type !== "press" || event.button !== "left") return;
        const button = this.toolbarActions.find(
          (item) =>
            event.y === item.row && event.x >= item.start && event.x < item.end,
        );
        if (button) {
          button.run();
          return { handled: true };
        }
        const hit = this.tabRegions.find(
          (t) => event.x >= t.start && event.x < t.end,
        );
        if (hit)
          callbacks.selectTab(
            this.tabRegions.length === 1
              ? this.tabs[(this.tabs.indexOf(this.tab) + 1) % this.tabs.length]!
              : hit.tab,
          );
        return { handled: true };
      },
    };
    this.addChild(this.tabBar, { shrink: 0 });
    this.addChild(
      new HStack(
        [
          {
            component: this.navigation,
            basis: 22,
            shrink: 0,
            visible: () => tui.terminal.columns >= 100 && this.navigationOpen,
          },
          {
            component: this.navigation,
            basis: 0,
            grow: 1,
            minSize: 1,
            visible: () => this.navigationOpen && tui.terminal.columns < 100,
          },
          {
            component: content,
            basis: 0,
            grow: 1,
            minSize: 1,
            visible: () => !(this.navigationOpen && tui.terminal.columns < 100),
          },
        ],
        { gap: 1 },
      ),
      { basis: callbacks.intrinsicHeight ? "auto" : 0, grow: 1, minSize: 1 },
    );
  }
  setTabs(tabs: WorkspaceTab[]) {
    this.tabs = workspaceTabs.filter((t) => tabs.includes(t));
  }
  setSessions(sessions: WorkspaceSession[]) {
    this.sessions = sessions;
    this.navigationIndex = Math.min(
      this.navigationIndex,
      Math.max(0, sessions.length - 1),
    );
    this.tui.requestRender();
  }
  focusNavigation() {
    this.navigationOpen = true;
    this.tui.setFocus(this.navigation);
    this.tui.requestRender();
  }
}
