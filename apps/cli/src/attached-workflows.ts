import type { DisplayChange } from "../../../packages/tui/src/change-review.ts";
import type { ReviewEntry } from "../../../packages/runtime/src/change-review.ts";
import type { ClientConnection } from "../../../packages/client-core/src/connection.ts";
import type { HikaroView } from "../../../packages/tui/src/index.ts";
import type {
  RpcMethod,
  QuestionDraftSnapshot,
  QuestionDraftSaveResult,
} from "../../../packages/protocol/src/contracts.ts";
import { QuestionDraftSaver } from "../../../packages/tui/src/question-drafts.ts";
import { openChangeReview } from "../../../packages/tui/src/change-review.ts";
import { openExecutionControl } from "../../../packages/tui/src/execution-control.ts";
import {
  browseExecutionHistory,
  type ExecutionHistorySource,
} from "../../../packages/tui/src/execution-history.ts";
import {
  answerQuestion,
  reviewPlan,
  browsePlanHistory,
  browsePlanProgress,
} from "../../../packages/tui/src/planning.ts";
import type { FileChange } from "../../../packages/tools/src/changes.ts";
import type {
  Plan,
  PlanProgress,
  Questions,
} from "../../../packages/runtime/src/planning.ts";
import type { ExecutionItem } from "../../../packages/runtime/src/execution-items.ts";
export class AttachedWorkflows {
  private modal?: string;
  private question?: { id: string; recovered: boolean; abort: AbortController };
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
    signal?: AbortSignal,
  ): Promise<T> {
    const epoch = this.epoch;
    const current = () => {
      if (signal?.aborted || this.stopped || epoch !== this.epoch) return false;
      const state = this.client.state;
      return state.canAct && state.session?.id === sessionId;
    };
    if (!current())
      throw Error(
        "Connection or session changed; reopen the panel. No action was replayed.",
      );
    const result = await this.client.request(
      method,
      { ...params, sessionId },
      {
        beforeSend: () => {
          if (!current())
            throw Error("Connection or session changed; command was not sent.");
        },
      },
    );
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
      if (
        this.question &&
        (this.question.id !== q?.id ||
          this.question.recovered !== !!q?.recovered)
      )
        this.question.abort.abort();
      if (q && !this.question) {
        this.view.closeModelPanel();
        const abort = new AbortController();
        this.question = { id: q.id, recovered: !!q.recovered, abort };
        this.modal = "questions";
        void this.answer(q, id, abort.signal)
          .catch((error) => this.view.setError(String(error)))
          .finally(() => {
            if (this.question?.abort === abort) {
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
  private async answer(
    question: { id: string; questions: Questions; recovered?: boolean },
    sessionId: string,
    signal: AbortSignal,
  ) {
    let draft: QuestionDraftSaver | undefined;
    try {
      if (
        this.client.supports("questions.draft.read") &&
        this.client.supports("questions.draft.save")
      ) {
        const snapshot = await this.request<QuestionDraftSnapshot>(
          "questions.draft.read",
          sessionId,
          { id: question.id },
          signal,
        );
        signal.throwIfAborted();
        draft = new QuestionDraftSaver(
          snapshot,
          (expectedRevision, draft) => {
            signal.throwIfAborted();
            return this.request<QuestionDraftSaveResult>(
              "questions.draft.save",
              sessionId,
              { id: question.id, expectedRevision, draft },
              signal,
            );
          },
          (error) => {
            if (!signal.aborted)
              this.view.setError(`Answer draft not saved: ${String(error)}`);
          },
        );
      }
      signal.throwIfAborted();
      await answerQuestion(
        this.view,
        question,
        signal,
        (answers, draftRevision) => {
          signal.throwIfAborted();
          return this.request(
            "questions.respond",
            sessionId,
            {
              id: question.id,
              ...(draftRevision === undefined ? {} : { draftRevision }),
              ...(answers ? { answers } : { cancelled: true }),
            },
            signal,
          );
        },
        draft,
      );
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      draft?.stop();
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
  async command(
    command: string,
    arg: string,
    filter: import("../../../packages/runtime/src/change-review.ts").ReviewFilter = {},
  ) {
    const id = this.client.state.session?.id;
    if (!id) throw Error("No session selected");
    if (this.modal) throw Error("Close the current workflow first");
    if (command === "/plan") {
      this.modal = "plan";
      try {
        if (arg === "progress") {
          await browsePlanProgress(
            this.view,
            async () => {
              const state = await this.request<{
                progress?: PlanProgress | null;
              }>("plan.read", id);
              if (state.progress === undefined)
                throw Error("Upgrade the host to read plan progress.");
              return state.progress;
            },
            this.client.supports("plan.evidence")
              ? {
                  changes: async (planId, step) => {
                    this.modal = undefined;
                    await this.command("/changes", "", { planId, step });
                  },
                  tool: async (planId, tool) => {
                    let offset = 0,
                      text = "";
                    for (;;) {
                      const part = await this.request<{
                        data: string;
                        nextOffset: number | null;
                        truncated: boolean;
                      }>("plan.evidence", id, {
                        planId,
                        owner: tool.sessionId,
                        seq: tool.seq,
                        offset,
                        limit: 16000,
                      });
                      text += part.data;
                      if (part.nextOffset === null)
                        return (
                          text +
                          (part.truncated
                            ? "\n[Result preview limited; see session history.]"
                            : "")
                        );
                      if (part.nextOffset <= offset || text.length > 128000)
                        throw Error("Invalid evidence page");
                      offset = part.nextOffset;
                    }
                  },
                }
              : undefined,
          );
          return;
        }
        if (arg === "history") {
          if (
            !this.client.supports("plan.history") ||
            !this.client.supports("plan.version")
          )
            throw Error("Upgrade the host to browse plan history.");
          await browsePlanHistory(this.view, {
            list: (before) => this.request("plan.history", id, { before }),
            detail: (version) =>
              this.request("plan.version", id, { id: version }),
          });
          return;
        }
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
        const unified =
          this.client.supports("changes.review.list") &&
          this.client.supports("changes.review.diff");
        let reviewRows: DisplayChange[] = [];
        let warnings: string[] = [];
        await openChangeReview(this.view, {
          cwd: this.cwd,
          list: async () => {
            const all: DisplayChange[] = [];
            for (let offset = 0; ;) {
              const page = await this.request<{
                items: DisplayChange[];
                more: boolean;
                warnings?: string[];
              }>(unified ? "changes.review.list" : "changes.list", id, {
                offset,
                ...filter,
              });
              warnings = page.warnings ?? [];
              all.push(...page.items);
              if (!page.more) {
                reviewRows = all;
                return all;
              }
              if (!page.items.length) throw Error("Incomplete change list");
              offset += page.items.length;
            }
          },
          warnings: unified ? () => warnings : undefined,
          detail: async (changeId) => {
            const row = reviewRows.find((row) => row.id === changeId);
            if (row && "readOnly" in row && row.readOnly) {
              let offset = 0,
                diff = "",
                entry: ReviewEntry | undefined;
              for (;;) {
                const part = await this.request<{
                  entry: ReviewEntry;
                  data: string;
                  nextOffset: number | null;
                }>("changes.review.diff", id, {
                  id: changeId,
                  owner: row.sessionId,
                  source: row.source,
                  offset,
                  limit: 16000,
                });
                if (
                  entry &&
                  JSON.stringify(entry) !== JSON.stringify(part.entry)
                )
                  throw Error("Change record changed; refresh the list");
                entry = part.entry;
                diff += part.data;
                if (part.nextOffset === null) break;
                if (
                  part.nextOffset <= offset ||
                  diff.length > 128 * 1024 * 1024
                )
                  throw Error("Invalid change diff page");
                offset = part.nextOffset;
              }
              return {
                entry: entry!,
                before: undefined,
                after: undefined,
                diff,
              };
            }
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
        const history: ExecutionHistorySource | undefined =
          this.client.supports("execution.history") &&
          this.client.supports("execution.history.detail")
            ? {
                list: (cursor, signal) =>
                  this.request("execution.history", id, cursor, signal),
                detail: (runId, snapshot, signal) =>
                  this.request(
                    "execution.history.detail",
                    id,
                    { id: runId, snapshot },
                    signal,
                  ),
              }
            : undefined;
        const requested = /^history(?:\s+(.+))?$/u.exec(arg.trim());
        if (requested) {
          if (!history)
            throw Error(
              "Upgrade the host for complete saved history. /tasks still provides recent execution history.",
            );
          await browseExecutionHistory(this.view, history, requested[1]);
          return;
        }
        let token: string | undefined;
        let renewal: ReturnType<typeof setInterval> | undefined;
        let renewing = false;
        let holding = false;
        await openExecutionControl(this.view, {
          history,
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
