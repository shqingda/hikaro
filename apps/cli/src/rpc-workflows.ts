import { QuestionService } from "./question-service.ts";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import type { Runtime } from "../../../packages/runtime/src/index.ts";
import type { Agent, Session } from "../../../packages/core/src/index.ts";
import type { Questions } from "../../../packages/runtime/src/planning.ts";
import { executionItems } from "../../../packages/runtime/src/execution-items.ts";
import { changeDiff } from "../../../packages/core/src/change-diff.ts";
const kindSchema = z.enum([
  "queue",
  "terminals",
  "children",
  "steering",
  "history",
]);
export class RpcWorkflows {
  private holds = new Map<
    string,
    {
      session: string;
      token: string;
      release: () => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private questionService: QuestionService;
  constructor(
    private runtime: Runtime,
    hostInstanceId: string = randomUUID(),
    enforceAccess = false,
  ) {
    this.questionService = new QuestionService(
      runtime,
      hostInstanceId,
      enforceAccess,
    );
  }
  ready() {
    return this.questionService.ready();
  }
  private release(scope: string) {
    const held = this.holds.get(scope);
    if (held) {
      clearTimeout(held.timer);
      held.release();
      this.holds.delete(scope);
    }
  }
  private renew(scope: string, session: string, token: unknown) {
    const held = this.holds.get(scope);
    if (!held || held.session !== session || held.token !== token)
      throw Error("Queue hold expired; reopen the execution manager");
    clearTimeout(held.timer);
    held.timer = setTimeout(() => this.release(scope), 15000);
    held.timer.unref();
  }
  ask(
    questions: Questions,
    signal: AbortSignal,
    executionSessionId: string,
    scope = "default",
  ) {
    return this.questionService.ask(
      questions,
      signal,
      executionSessionId,
      scope,
    );
  }
  async handle(
    method: string,
    p: Record<string, unknown>,
    session: Session,
    agent: Agent,
    scope: string,
  ): Promise<unknown> {
    switch (method) {
      case "changes.list": {
        const entries = await this.runtime.changes.list(session.id);
        const offset = z
          .number()
          .int()
          .min(0)
          .max(10000)
          .parse(p.offset ?? 0);
        const items: typeof entries = [];
        let bytes = 0;
        for (const entry of entries.slice(offset, offset + 100)) {
          const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
          if (bytes + size > 128000) break;
          items.push(entry);
          bytes += size;
        }
        if (offset < entries.length && !items.length)
          throw Error("Change record exceeds response limit");
        return { items, more: offset + items.length < entries.length };
      }
      case "changes.diff": {
        const detail = await this.runtime.changes.detail(
          session.id,
          z.string().uuid().parse(p.id),
        );
        const offset = z
          .number()
          .int()
          .min(0)
          .max(128 * 1024 * 1024)
          .parse(p.offset ?? 0);
        const limit = z
          .number()
          .int()
          .min(1)
          .max(16000)
          .parse(p.limit ?? 8192);
        const text = changeDiff(detail.entry.path, detail.before, detail.after);
        const end = Math.min(text.length, offset + limit);
        return {
          entry: detail.entry,
          data: text.slice(offset, end),
          total: text.length,
          encoding: "utf16",
          nextOffset: end < text.length ? end : null,
        };
      }
      case "changes.detail": {
        const detail = await this.runtime.changes.detail(
          session.id,
          z.string().uuid().parse(p.id),
        );
        const field = z.enum(["before", "after"]).parse(p.field ?? "after");
        const text = detail[field] ?? "";
        const offset = z
          .number()
          .int()
          .min(0)
          .max(32 * 1024 * 1024)
          .parse(p.offset ?? 0);
        return {
          entry: detail.entry,
          text: text.slice(offset, offset + 16000),
          length: text.length,
        };
      }
      case "changes.rollback":
      case "changes.redo":
        await this.runtime[
          method === "changes.redo" ? "redoChange" : "rollbackChange"
        ](session, z.string().uuid().parse(p.id), AbortSignal.timeout(15000));
        return { completed: true };
      case "execution.hold": {
        this.release(scope);
        const token = randomUUID();
        const release = agent.holdQueue();
        const timer = setTimeout(() => this.release(scope), 15000);
        timer.unref();
        this.holds.set(scope, { token, session: session.id, release, timer });
        return { token };
      }
      case "execution.release": {
        this.renew(scope, session.id, p.token);
        this.release(scope);
        return { released: true };
      }
      case "execution.read": {
        if (p.token !== undefined) this.renew(scope, session.id, p.token);
        const kind = kindSchema.parse(p.kind);
        const items =
          kind === "history"
            ? await this.runtime.executionHistory(session.id)
            : executionItems(agent, this.runtime, session.id, kind);
        if (p.id !== undefined) {
          const item = items.find((t) => t.id === z.string().parse(p.id));
          if (!item) throw Error("Item no longer available");
          return item;
        }
        return items.map((t) => ({
          ...t,
          title: t.title.slice(0, 240),
          detail: "",
          editText: undefined,
        }));
      }
      case "execution.action": {
        const kind = kindSchema.parse(p.kind),
          id = z.string().parse(p.id),
          action = z
            .enum(["edit", "first", "remove", "resume", "send", "stop"])
            .parse(p.action);
        if (kind === "history") throw Error("Execution history is read-only");
        if (kind === "queue") {
          this.renew(scope, session.id, p.token);
          if (action === "edit")
            await agent.updatePending(id, z.string().max(100000).parse(p.text));
          else if (action === "first") await agent.prioritizePending(id);
          else if (action === "remove") await agent.removePending(id);
          else if (action === "resume") await agent.resumePending(id, scope);
          else throw Error("Invalid queue action");
        } else if (kind === "steering") {
          this.renew(scope, session.id, p.token);
          if (action === "edit")
            await agent.updateSteering(
              id,
              z.string().max(100000).parse(p.text),
            );
          else if (action === "first") await agent.prioritizeSteering(id);
          else if (action === "remove") await agent.removeSteering(id);
          else if (action === "resume") await agent.resumeSteering(id, scope);
          else throw Error("Invalid steering action");
        } else if (kind === "terminals") {
          if (action === "send") {
            await this.runtime.planning.load(session.id, true);
            if (this.runtime.planning.get(session.id).active)
              throw Error("Plan mode is read-only");
            this.runtime.terminals.send(
              session.id,
              id,
              z.string().max(32000).parse(p.text),
            );
          } else if (action === "stop")
            this.runtime.terminals.stop(session.id, id);
          else throw Error("Invalid terminal action");
        } else if (action === "stop") this.runtime.stopChild(session.id, id);
        else throw Error("Invalid child action");
        return { completed: true };
      }
      case "plan.history":
        await this.runtime.planning.load(session.id, true);
        return this.runtime.planning.history(
          session.id,
          p.before === undefined
            ? undefined
            : z.number().int().min(1).safe().parse(p.before),
        );
      case "plan.version":
        await this.runtime.planning.load(session.id, true);
        return this.runtime.planning.version(
          session.id,
          z.string().uuid().parse(p.id),
        );
      case "plan.read":
        await this.runtime.planning.load(session.id, true);
        return this.runtime.planning.get(session.id);
      case "plan.set":
        await this.runtime.setPlanning(session, z.boolean().parse(p.active));
        return this.runtime.planning.get(session.id);
      case "questions.read":
        return this.questionService.read(session.id, scope);
      case "questions.respond":
        return this.questionService.respond(session.id, scope, p);
      default:
        throw Error("Unsupported workflow method");
    }
  }
  close() {
    for (const scope of this.holds.keys()) this.release(scope);
    this.questionService.close();
  }
}
