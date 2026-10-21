import type { ClientConnection } from "../../../packages/client-core/src/connection.ts";
import type { HikaroView } from "../../../packages/tui/src/index.ts";
import type { RpcMethod } from "../../../packages/protocol/src/contracts.ts";
import { openChangeReview } from "../../../packages/tui/src/change-review.ts";
import { openExecutionControl } from "../../../packages/tui/src/execution-control.ts";
import {
  askQuestions,
  reviewPlan,
} from "../../../packages/tui/src/planning.ts";
import type { FileChange } from "../../../packages/tools/src/changes.ts";
import type {
  Plan,
  Questions,
} from "../../../packages/runtime/src/planning.ts";
import type { ExecutionItem } from "../../../packages/runtime/src/execution-items.ts";
export class AttachedWorkflows {
  private modal?: string;
  private question?: { id: string; abort: AbortController };
  private seenPlans = new Set<string>();
  private polling = false;
  private stopped = false;
  private epoch = 0;
  private permissionLabel?: string;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private client: ClientConnection,
    private view: HikaroView,
    private cwd: string,
  ) {
    this.timer = setInterval(() => void this.poll(), 750);
    this.timer.unref();
  }
  private async request<T>(
    method: RpcMethod,
    sessionId: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const epoch = this.epoch;
    const current = () => {
      if (this.stopped || epoch !== this.epoch) return false;
      const state = this.client.state;
      return state.canAct && state.session?.id === sessionId;
    };
    if (!current())
      throw Error(
        "Connection or session changed; reopen the panel. No action was replayed.",
      );
    const result = await this.client.request(method, { ...params, sessionId });
    if (!current())
      throw Error(
        "Connection or session changed; inspect current state before retrying. No action was replayed.",
      );
    if (result && typeof result === "object" && "duplicate" in result)
      throw Error(
        "Command already received; inspect its receipt and current state before retrying",
      );
    return result as T;
  }
  disconnected() {
    this.epoch++;
    this.permissionLabel = undefined;
    this.question?.abort.abort();
    this.view.closeModelPanel();
  }
  close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.disconnected();
  }
  async withMenu(action: () => Promise<void>) {
    if (this.modal) throw Error("Close the current workflow first");
    this.modal = "menu";
    try {
      await action();
    } finally {
      if (this.modal === "menu") this.modal = undefined;
    }
  }
  private async poll() {
    const state = this.client.state;
    if (
      this.modal === "menu" ||
      this.stopped ||
      this.polling ||
      !state.canAct ||
      !state.session ||
      state.sessionRole === "view"
    )
      return;
    this.polling = true;
    const id = state.session.id;
    try {
      const q = await this.request<{
        id: string;
        questions: Questions;
        recovered?: boolean;
      } | null>("questions.read", id);
      if (this.modal === "menu") return;
      if (this.question && this.question.id !== q?.id)
        this.question.abort.abort();
      if (q && !this.question) {
        this.view.closeModelPanel();
        const abort = new AbortController();
        this.question = { id: q.id, abort };
        this.modal = "questions";
        void askQuestions(this.view, q.questions, abort.signal, q.recovered)
          .then(async (answers) => {
            while (!abort.signal.aborted) {
              try {
                await this.request("questions.respond", id, {
                  id: q.id,
                  ...(answers ? { answers } : { cancelled: true }),
                });
                if (q.recovered)
                  this.view.notice(
                    answers
                      ? "Recovered answers saved. Send a new message to continue; no operation was resumed."
                      : "Recovered questions dismissed. No answers were inferred.",
                  );
                return;
              } catch (error) {
                if (!q.recovered || abort.signal.aborted) throw error;
                const { panel, close } = this.view.openModelPanel();
                abort.signal.addEventListener("abort", close, { once: true });
                try {
                  const choice = await panel.readDocument(
                    "Answers not saved",
                    `${String(error)}\n\nYour answers are retained here. A previous execution lease can take up to 30 seconds to expire. Retry when the session is idle.`,
                    [{ value: "retry", label: "Retry saving answers" }],
                  );
                  if (choice.value !== "retry") return;
                } finally {
                  abort.signal.removeEventListener("abort", close);
                  close();
                }
              }
            }
          })
          .catch((error) => this.view.setError(String(error)))
          .finally(() => {
            if (this.question?.id === q.id) {
              this.question = undefined;
              this.modal = undefined;
            }
          });
        return;
      }
      const state = await this.request<{ active: boolean; plan?: Plan }>(
        "plan.read",
        id,
      );
      const label = `Host owns task approvals${state.active ? " · Plan read-only" : ""}`;
      if (label !== this.permissionLabel) {
        this.permissionLabel = label;
        this.view.setPermissionLabel(label);
      }
      if (
        state.active &&
        state.plan &&
        !this.client.state.busy &&
        !this.modal &&
        !this.seenPlans.has(state.plan.id)
      ) {
        this.seenPlans.add(state.plan.id);
        void this.review(id, state.plan).catch((error) =>
          this.view.setError(String(error)),
        );
      }
    } catch (error) {
      if (this.client.state.canAct) this.view.setError(String(error));
    } finally {
      this.polling = false;
    }
  }
  private async review(id: string, plan: Plan) {
    this.modal = "plan";
    try {
      const result = await reviewPlan(this.view, plan);
      if (result.action === "execute") {
        await this.request("plan.execute", id, { id: result.id });
        this.view.notice(
          "Plan accepted by host. Execution results appear in the conversation; reconnect never resends it.",
        );
      } else if (result.action === "revise") {
        await this.request("plan.set", id, { active: true });
        await this.request("prompt", id, {
          text: `Revise the plan: ${result.text}`,
        });
      } else
        this.view.notice("Plan kept read-only. Use /plan to review again.");
    } finally {
      if (this.modal === "plan") this.modal = undefined;
    }
  }
  async command(command: string, arg: string) {
    const id = this.client.state.session?.id;
    if (!id) throw Error("No session selected");
    if (this.modal) throw Error("Close the current workflow first");
    if (command === "/plan") {
      this.modal = "plan";
      try {
        if (arg === "cancel") {
          this.modal = "plan";
          const { panel, close } = this.view.openModelPanel();
          try {
            const choice = await panel.choose(
              "Leave Plan mode?",
              [
                { value: "keep", label: "Stay read-only" },
                { value: "leave", label: "Leave without executing" },
              ],
              "Future prompts may edit under host permissions. No task starts now.",
              undefined,
              {
                search: false,
                cancelValue: "keep",
                requireNoticeVisible: true,
              },
            );
            if (choice.value === "leave")
              await this.request("plan.set", id, { active: false });
          } finally {
            close();
            if (this.modal === "plan") this.modal = undefined;
          }
          return;
        }
        const state = await this.request<{ active: boolean; plan?: Plan }>(
          "plan.read",
          id,
        );
        if (!state.active) await this.request("plan.set", id, { active: true });
        if (arg) {
          await this.request("prompt", id, { text: arg });
          this.view.notice(
            "Host planning · read-only. Questions and plan review will appear here.",
          );
        } else if (state.active && state.plan) {
          this.seenPlans.add(state.plan.id);
          await this.review(id, state.plan);
        } else
          this.view.notice(
            "Plan mode · read-only. Describe the task to explore.",
          );
        return;
      } finally {
        if (this.modal === "plan") this.modal = undefined;
      }
    }
    this.modal = command;
    try {
      if (command === "/changes") {
        await openChangeReview(this.view, {
          cwd: this.cwd,
          list: async () => {
            const all: FileChange[] = [];
            for (let offset = 0; ;) {
              const page = await this.request<{
                items: FileChange[];
                more: boolean;
              }>("changes.list", id, { offset });
              all.push(...page.items);
              if (!page.more) return all;
              if (!page.items.length) throw Error("Incomplete change list");
              offset += page.items.length;
            }
          },
          detail: async (changeId) => {
            let entry: FileChange | undefined;
            const texts = { before: "", after: "" };
            for (const field of ["before", "after"] as const) {
              for (let offset = 0; ;) {
                const part = await this.request<{
                  entry: FileChange;
                  text: string;
                  length: number;
                }>("changes.detail", id, { id: changeId, field, offset });
                if (
                  entry &&
                  JSON.stringify(entry) !== JSON.stringify(part.entry)
                )
                  throw Error(
                    "Change record changed during reading; reopen it",
                  );
                entry = part.entry;
                texts[field] += part.text;
                offset += part.text.length;
                if (offset >= part.length) break;
                if (!part.text) throw Error("Incomplete change snapshot");
              }
            }
            return {
              entry: entry!,
              before: entry!.before === null ? undefined : texts.before,
              after: texts.after,
            };
          },
          rollback: async (changeId, signal) => {
            signal.throwIfAborted();
            await this.request("changes.rollback", id, { id: changeId });
          },
          redo: this.client.supports("changes.redo")
            ? async (changeId, signal) => {
                signal.throwIfAborted();
                await this.request("changes.redo", id, { id: changeId });
              }
            : undefined,
        });
      } else {
        let token: string | undefined;
        let renewal: ReturnType<typeof setInterval> | undefined;
        let renewing = false;
        let holding = false;
        await openExecutionControl(this.view, {
          hold: async () => {
            token = (
              await this.request<{ token: string }>("execution.hold", id)
            ).token;
            holding = true;
            renewal = setInterval(() => {
              if (renewing) return;
              renewing = true;
              void this.request("execution.read", id, { kind: "queue", token })
                .catch((error) => {
                  if (holding) {
                    this.view.setError(String(error));
                    this.view.closeModelPanel();
                  }
                })
                .finally(() => {
                  renewing = false;
                });
            }, 4000);
            return async () => {
              holding = false;
              clearInterval(renewal);
              await this.request("execution.release", id, { token });
            };
          },
          list: (kind) =>
            this.request<ExecutionItem[]>("execution.read", id, {
              kind,
              token,
            }),
          detail: (kind, itemId) =>
            this.request<ExecutionItem>("execution.read", id, {
              kind,
              id: itemId,
              token,
            }),
          act: async (kind, itemId, action, text) => {
            await this.request("execution.action", id, {
              kind,
              id: itemId,
              action,
              token,
              ...(text === undefined ? {} : { text }),
            });
          },
        });
      }
    } finally {
      if (this.modal === command) this.modal = undefined;
    }
  }
}
