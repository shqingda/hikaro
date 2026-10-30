import { basename, relative } from "node:path";
import type { Agent, Session } from "../../core/src/index.ts";
import { changeDiff } from "../../core/src/change-diff.ts";
import type { ToolEvidence } from "../../core/src/change-evidence.ts";
import type { Runtime } from "../../runtime/src/index.ts";
import type { ReviewEntry } from "../../runtime/src/change-review.ts";
import type {
  ExecutionItem,
  ExecutionKind,
} from "../../runtime/src/execution-items.ts";
import type {
  ExecutionHistoryCursor,
  ExecutionHistoryPage,
} from "../../runtime/src/execution-history.ts";
import type {
  Plan,
  PlanHistory,
  PlanProgress,
  Questions,
} from "../../runtime/src/planning.ts";
import {
  attachmentReference,
  parseFileReferences,
} from "../../runtime/src/attachments.ts";
import type { ClientConnection } from "../../client-core/src/connection.ts";
import type { RpcMethod } from "../../protocol/src/contracts.ts";
import type { HikaroView } from "../../tui/src/index.ts";
import type {
  ObjectAction,
  ObjectDetail,
  ObjectSource,
  WorkspaceObject,
} from "../../tui/src/object-page.ts";
import {
  localExecutionSource,
  type ExecutionSource,
} from "../../tui/src/execution-control.ts";
import {
  batchRollbackTargets,
  runRollbackTargets,
  runBatchRollback,
} from "../../tui/src/change-review.ts";
import type { FileChange } from "../../tools/src/changes.ts";
import {
  configurationRequest,
  type ResourceEntry,
} from "./rpc-configuration.ts";
import { localQuestionScope } from "./local-questions.ts";

type Value<T> = T | (() => T);
const value = <T>(input: Value<T>): T =>
  typeof input === "function" ? (input as () => T)() : input;
type TextPart = {
  data: string;
  total: number;
  nextOffset: number | null;
  truncated?: boolean;
};
type PlanState = {
  active: boolean;
  plan?: Plan;
  progress?: PlanProgress | null;
  incomplete?: boolean;
};
type Question = { id: string; questions: Questions };
type Backend = {
  id: string;
  cwd: string;
  current(signal?: AbortSignal): void;
  capable(method: RpcMethod): boolean;
  writable(): boolean;
  action(
    work: (current: () => void) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  changes(
    signal: AbortSignal,
  ): Promise<{ items: ReviewEntry[]; warnings: string[] }>;
  diff(
    entry: ReviewEntry,
    offset: number,
    signal: AbortSignal,
  ): Promise<TextPart & { entry: ReviewEntry }>;
  change(entry: ReviewEntry, redo: boolean, signal: AbortSignal): Promise<void>;
  execution(): ExecutionSource;
  plan(signal: AbortSignal): Promise<PlanState>;
  versions(
    before: number | undefined,
    signal: AbortSignal,
  ): Promise<PlanHistory>;
  version(id: string, signal: AbortSignal): Promise<Plan>;
  questions(signal: AbortSignal): Promise<Question[]>;
  evidence(
    tool: ToolEvidence,
    planId: string,
    offset: number,
    signal: AbortSignal,
  ): Promise<TextPart>;
  resources(
    offset: number,
    signal: AbortSignal,
  ): Promise<{ items: ResourceEntry[]; hasMore: boolean }>;
  model(): string;
};
export type WorkspaceSources = Record<
  "Changes" | "Activity" | "Plan" | "Context",
  ObjectSource
>;
const partSize = 16000;
/** RPC offsets count UTF-16 units. Leave a trailing high surrogate for the next
 * page so each independently rendered part contains complete code points. */
function textPart<T extends TextPart>(part: T, offset: number): T {
  if (
    part.total < offset + part.data.length ||
    (part.nextOffset !== null && part.nextOffset !== offset + part.data.length)
  )
    throw Error("Invalid content cursor");
  const last = part.data.charCodeAt(part.data.length - 1);
  if (part.nextOffset !== null && last >= 0xd800 && last <= 0xdbff) {
    if (part.data.length < 2) throw Error("Content page cannot advance safely");
    return {
      ...part,
      data: part.data.slice(0, -1),
      nextOffset: part.nextOffset - 1,
    };
  }
  return part;
}
const changeId = (entry: ReviewEntry) =>
  `change:${JSON.stringify([entry.sessionId, entry.source, entry.id])}`;
const evidenceId = (tool: ToolEvidence, plan: string) =>
  `evidence:${JSON.stringify([tool.sessionId, plan, tool.seq])}`;
const entryVersion = (entry: ReviewEntry) =>
  JSON.stringify([
    entry.id,
    entry.path,
    entry.sessionId,
    entry.source,
    entry.state,
    entry.before,
    entry.after,
    entry.readOnly,
  ]);
const cancelled = () =>
  new DOMException("This view is no longer current", "AbortError");

/** A native view is bound to one session; getters permit replacing its model agent. */
export function nativeWorkspaceSources(
  view: HikaroView,
  runtime: Runtime,
  session: Value<Session>,
  agent: Value<Agent>,
): WorkspaceSources {
  const initial = value(session);
  const current = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (value(session).id !== initial.id) throw cancelled();
  };
  const backend: Backend = {
    id: initial.id,
    cwd: initial.cwd,
    current,
    capable: () => true,
    writable: () => true,
    async action(work, signal) {
      const selected = value(agent);
      const check = () => {
        current(signal);
        if (selected !== value(agent)) throw cancelled();
      };
      check();
      await work(check);
    },
    changes: () => runtime.review.list(initial.id),
    async diff(entry, offset) {
      const detail = await runtime.review.detail(initial.id, entry);
      const text = changeDiff(detail.entry.path, detail.before, detail.after);
      return {
        entry: detail.entry,
        data: text.slice(offset, offset + partSize),
        total: text.length,
        nextOffset: offset + partSize < text.length ? offset + partSize : null,
      };
    },
    async change(entry, redo, signal) {
      current(signal);
      await runtime[redo ? "redoChange" : "rollbackChange"](
        value(session),
        entry.id,
        signal,
      );
    },
    execution() {
      const source = localExecutionSource({
        runtime,
        agent: value(agent),
        session: initial.id,
      });
      return {
        ...source,
        async act(kind, id, action, text) {
          current();
          if (kind === "terminals" && action === "send") {
            await runtime.planning.load(initial.id, true);
            if (runtime.planning.get(initial.id).active)
              throw Error("Plan mode is read-only");
          }
          await source.act(kind, id, action, text);
        },
      };
    },
    async plan() {
      await runtime.planning.load(initial.id, true);
      return {
        ...runtime.planning.get(initial.id),
        progress: await runtime.planProgress(initial.id),
      };
    },
    versions: (before) => runtime.planning.history(initial.id, before),
    version: (id) => runtime.planning.version(initial.id, id),
    questions: async () =>
      (
        await runtime.store.pendingQuestions(initial.id, localQuestionScope)
      ).slice(0, 1),
    async evidence(tool, plan, offset) {
      if (!(await runtime.review.owners(initial.id)).has(tool.sessionId))
        throw Error("Tool result no longer belongs to this task tree");
      return runtime.store.planEvidenceContent(
        tool.sessionId,
        initial.id,
        plan,
        tool.seq,
        offset,
        partSize,
      );
    },
    resources: async (offset) =>
      (await configurationRequest(runtime, "resources.list", { offset })) as {
        items: ResourceEntry[];
        hasMore: boolean;
      },
    model: () => {
      const provider = value(agent).options.provider;
      return `${provider.id} / ${provider.model}\nContext window: ${provider.contextWindow.toLocaleString()} tokens`;
    },
  };
  return workspaceSources(view, backend);
}

/** Uses the existing RPC methods and receipt semantics; mutations are never replayed. */
export function attachedWorkspaceSources(
  view: HikaroView,
  client: ClientConnection,
  sessionId: string,
): WorkspaceSources {
  const initial = client.status;
  const hostInstanceId = initial.hostInstanceId;
  const current = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const state = client.status;
    if (
      !state.canAct ||
      state.session?.id !== sessionId ||
      state.hostInstanceId !== hostInstanceId
    )
      throw Error(
        "Connection or session changed; refresh after reconnecting. No action was replayed.",
      );
  };
  const request = async <T>(
    method: RpcMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> => {
    current(signal);
    if (!client.supports(method))
      throw Error(`This host does not support ${method}`);
    let invalid = false;
    const check = () => {
      current(signal);
      if (invalid) throw cancelled();
    };
    const unsubscribe = client.subscribe(() => {
      try {
        check();
      } catch {
        invalid = true;
      }
    });
    try {
      const result = await client.request(
        method,
        { ...params, sessionId },
        { beforeSend: check },
      );
      check();
      if (result && typeof result === "object" && "duplicate" in result)
        throw Error(
          "Command was already received; inspect its receipt before retrying.",
        );
      return result as T;
    } finally {
      unsubscribe();
    }
  };
  const review = () =>
    client.supports("changes.review.list") &&
    client.supports("changes.review.diff");
  const normalize = (entry: ReviewEntry): ReviewEntry => ({
    ...entry,
    sessionId: entry.sessionId ?? sessionId,
    depth: entry.depth ?? 0,
    source: entry.source ?? "file",
    readOnly: entry.readOnly ?? false,
  });
  const backend: Backend = {
    id: sessionId,
    cwd: initial.session?.cwd ?? "",
    current,
    capable: (method) => client.supports(method),
    writable: () => client.status.sessionRole !== "view",
    async action(work, signal) {
      current(signal);
      let invalid = false;
      const check = () => {
        current(signal);
        if (client.status.sessionRole === "view")
          throw Error("This session is read-only");
        if (invalid) throw cancelled();
      };
      const unsubscribe = client.subscribe(() => {
        try {
          check();
        } catch {
          invalid = true;
        }
      });
      try {
        await work(check);
      } finally {
        unsubscribe();
      }
    },
    async changes(signal) {
      const items: ReviewEntry[] = [],
        warnings = new Set<string>();
      for (;;) {
        const result = await request<{
          items: ReviewEntry[];
          more: boolean;
          warnings?: string[];
        }>(
          review() ? "changes.review.list" : "changes.list",
          { offset: items.length },
          signal,
        );
        result.warnings?.forEach((warning) => warnings.add(warning));
        items.push(...result.items.map(normalize));
        if (!result.more) return { items, warnings: [...warnings] };
        if (!result.items.length || items.length > 10000)
          throw Error("Invalid change history page");
      }
    },
    async diff(entry, offset, signal) {
      if (!review() && !client.supports("changes.diff")) {
        const read = async (field: string) => {
          let text = "";
          for (;;) {
            const part = await request<{
              entry: ReviewEntry;
              text: string;
              length: number;
            }>(
              "changes.detail",
              { id: entry.id, field, offset: text.length },
              signal,
            );
            if (entryVersion(normalize(part.entry)) !== entryVersion(entry))
              throw Error("Change was updated; refresh before reading");
            text += part.text;
            if (text.length >= part.length)
              return field === "before" && entry.before === null
                ? undefined
                : text;
            if (!part.text.length || text.length > 32 * 1024 * 1024)
              throw Error("Invalid file snapshot page");
          }
        };
        const text = changeDiff(
          entry.path,
          await read("before"),
          await read("after"),
        );
        return {
          entry,
          data: text.slice(offset, offset + partSize),
          total: text.length,
          nextOffset:
            offset + partSize < text.length ? offset + partSize : null,
        };
      }
      const part = await request<TextPart & { entry: ReviewEntry }>(
        review() ? "changes.review.diff" : "changes.diff",
        {
          id: entry.id,
          owner: entry.sessionId,
          source: entry.source,
          offset,
          limit: partSize,
        },
        signal,
      );
      return { ...part, entry: normalize(part.entry) };
    },
    async change(entry, redo, signal) {
      await request(
        redo ? "changes.redo" : "changes.rollback",
        { id: entry.id },
        signal,
      );
    },
    execution() {
      let token: string | undefined;
      return {
        ...(client.supports("execution.history") &&
        client.supports("execution.history.detail")
          ? {
              history: {
                list: (cursor, signal) =>
                  request("execution.history", cursor, signal),
                detail: (id, snapshot, signal) =>
                  request("execution.history.detail", { id, snapshot }, signal),
              },
            }
          : {}),
        async hold() {
          token = (await request<{ token: string }>("execution.hold", {}))
            .token;
          return async () => {
            await request("execution.release", { token });
            token = undefined;
          };
        },
        list: (kind) => request("execution.read", { kind }),
        detail: (kind, id) => request("execution.read", { kind, id, token }),
        async act(kind, id, action, text) {
          await request("execution.action", { kind, id, action, text, token });
        },
      };
    },
    plan: (signal) => request("plan.read", {}, signal),
    versions: (before, signal) => request("plan.history", { before }, signal),
    version: (id, signal) => request("plan.version", { id }, signal),
    async questions(signal) {
      const q = await request<Question | null>("questions.read", {}, signal);
      return q ? [q] : [];
    },
    evidence: (tool, planId, offset, signal) =>
      request(
        "plan.evidence",
        {
          owner: tool.sessionId,
          planId,
          seq: tool.seq,
          offset,
          limit: partSize,
        },
        signal,
      ),
    resources: (offset, signal) =>
      request("resources.list", { offset }, signal),
    model: () => {
      const model = client.status.session?.modelSelection;
      return model
        ? `${model.provider} / ${model.model}\nModel and context are managed on the host.`
        : "Model information is not available from this host.";
    },
  };
  return workspaceSources(view, backend);
}

function workspaceSources(
  view: HikaroView,
  backend: Backend,
): WorkspaceSources {
  const reviewed = new Set<string>(),
    offsets = new Map<string, number[]>(),
    pageIndexes = new Map<string, number>();
  const pageOffset = (id: string) =>
    offsets.get(id)?.[pageIndexes.get(id) ?? 0] ?? 0;
  let changes = new Map<string, ReviewEntry>();
  let changeWarnings: string[] = [];
  let activity = new Map<
    string,
    { kind: ExecutionKind; item: ExecutionItem; snapshot?: number }
  >();
  const historyCursors: ExecutionHistoryCursor[] = [{}];
  let historyIndex = 0,
    historyPage: ExecutionHistoryPage | undefined;
  type PlanObject =
    | { type: "current"; state: PlanState }
    | { type: "version"; id: string }
    | { type: "question"; question: Question }
    | { type: "evidence"; tool: ToolEvidence; plan: string }
    | { type: "step"; step: number; state: PlanState };
  let plans = new Map<string, PlanObject>(),
    resources = new Map<string, ResourceEntry>();
  const title = (entry: ReviewEntry) => {
    const path = relative(backend.cwd, entry.path);
    return path.startsWith("../") ? basename(entry.path) : path || entry.path;
  };
  const append = (text: string) => {
    backend.current();
    const draft = view.editor.getExpandedText();
    view.editor.setText(`${draft}${draft ? "\n\n" : ""}${text}`);
    view.notice("Reference added to the current draft");
  };
  const command = (
    id: string,
    label: string,
    text: string,
    signal: AbortSignal,
  ): ObjectAction => ({
    id,
    title: label,
    run: () =>
      backend.action(async (check) => {
        check();
        await view.command(text);
      }, signal),
  });
  const confirm = async (
    heading: string,
    text: string,
    signal: AbortSignal,
  ) => {
    const opened = view.openModelPanel({ yieldToApproval: true });
    signal.addEventListener("abort", opened.close, { once: true });
    try {
      const answer = await opened.panel.choose(
        heading,
        [
          { value: "cancel", label: "Cancel" },
          { value: "confirm", label: "Confirm" },
        ],
        text,
        undefined,
        { search: false, cancelValue: "cancel", requireNoticeVisible: true },
      );
      opened.signal.throwIfAborted();
      signal.throwIfAborted();
      return answer.value === "confirm";
    } finally {
      signal.removeEventListener("abort", opened.close);
      opened.close();
    }
  };
  const prompt = async (heading: string, text: string, signal: AbortSignal) => {
    const opened = view.openModelPanel({ yieldToApproval: true });
    signal.addEventListener("abort", opened.close, { once: true });
    try {
      const answer = await opened.panel.prompt(heading, false, text);
      opened.signal.throwIfAborted();
      signal.throwIfAborted();
      return answer;
    } finally {
      signal.removeEventListener("abort", opened.close);
      opened.close();
    }
  };
  const pages = (
    id: string,
    part: TextPart,
    signal: AbortSignal,
  ): ObjectAction[] => {
    const offset = pageOffset(id),
      index = pageIndexes.get(id) ?? 0;
    if (
      !Number.isSafeInteger(part.total) ||
      part.total < 0 ||
      (part.nextOffset !== null &&
        (!Number.isSafeInteger(part.nextOffset) ||
          part.nextOffset <= offset ||
          part.nextOffset > part.total))
    )
      throw Error("Invalid content page");
    return [
      ...(offset
        ? [
            {
              id: "previous",
              title: "Previous part",
              run: () => {
                backend.current(signal);
                pageIndexes.set(id, Math.max(0, index - 1));
              },
            },
          ]
        : []),
      ...(part.nextOffset !== null
        ? [
            {
              id: "next",
              title: "Next part",
              run: () => {
                backend.current(signal);
                offsets.set(id, [
                  ...(offsets.get(id) ?? [0]).slice(0, index + 1),
                  part.nextOffset!,
                ]);
                pageIndexes.set(id, index + 1);
              },
            },
          ]
        : []),
    ];
  };
  const partLabel = (id: string, part: TextPart) =>
    part.total > partSize
      ? `\nPart ${(pageIndexes.get(id) ?? 0) + 1} · ${part.nextOffset === null ? "final" : "more available"}`
      : "";
  const Changes: ObjectSource = {
    title: "Changes",
    description:
      "File edits and observed changes · review, reference, or restore an edit",
    async load(signal) {
      backend.current(signal);
      const result = await backend.changes(signal);
      backend.current(signal);
      changes = new Map(result.items.map((entry) => [changeId(entry), entry]));
      changeWarnings = result.warnings;
      return result.items.map((entry) => ({
        id: changeId(entry),
        title: title(entry),
        group: `${entry.state}${reviewed.has(entryVersion(entry)) ? " · reviewed" : ""}`,
        description: `${entry.path} ${entry.source} ${entry.sessionId} ${entry.runId ?? ""}`,
      }));
    },
    async detail(item, signal) {
      backend.current(signal);
      const selected = changes.get(item.id);
      if (!selected) throw Error("Change is no longer in this view");
      const part = textPart(
        await backend.diff(selected, pageOffset(item.id), signal),
        pageOffset(item.id),
      );
      backend.current(signal);
      const entry = part.entry;
      const actions: ObjectAction[] = [
        ...pages(item.id, part, signal),
        {
          id: "reviewed",
          title: reviewed.has(entryVersion(entry))
            ? "Mark unread"
            : "Mark reviewed",
          run: () => {
            backend.current(signal);
            const key = entryVersion(entry);
            if (reviewed.has(key)) reviewed.delete(key);
            else reviewed.add(key);
          },
        },
        {
          id: "reference",
          title: "Reference file in draft",
          run: () => {
            backend.current(signal);
            append(attachmentReference(JSON.stringify(entry.path)));
          },
        },
      ];
      const redo = entry.state === "reverted";
      if (
        !entry.readOnly &&
        entry.sessionId === backend.id &&
        ["committed", "reverted"].includes(entry.state) &&
        backend.writable() &&
        backend.capable(redo ? "changes.redo" : "changes.rollback")
      )
        actions.push({
          id: redo ? "redo" : "rollback",
          title: redo ? "Reapply this edit…" : "Roll back this edit…",
          run: () =>
            backend.action(async (check) => {
              if (
                !(await confirm(
                  redo ? "Reapply edit" : "Roll back edit",
                  `${entry.path}\n${redo ? "Reapplies this recorded edit as a new change." : entry.before === null ? "Removes this newly created file." : "Restores the contents before this edit."} Later edits cause a conflict and are preserved.`,
                  signal,
                ))
              )
                return;
              check();
              const fresh = await backend.diff(entry, 0, signal);
              check();
              if (entryVersion(fresh.entry) !== entryVersion(entry))
                throw Error(
                  "Change was updated; review it again before restoring",
                );
              await backend.change(entry, redo, signal);
            }, signal),
        });
      if (
        !entry.readOnly &&
        entry.sessionId === backend.id &&
        entry.state === "committed" &&
        backend.writable() &&
        backend.capable("changes.rollback")
      ) {
        const reliable = (entries: ReviewEntry[]) =>
          entries.filter(
            (row): row is ReviewEntry & FileChange =>
              row.source === "file" &&
              row.state !== "observed" &&
              row.after !== null &&
              row.sessionId === backend.id &&
              !row.readOnly,
          );
        const selected = reliable([...changes.values()]);
        for (const [id, label, targets] of [
          ["run", "Roll back this run", runRollbackTargets],
          ["batch", "Roll back to here", batchRollbackTargets],
        ] as const) {
          let batch: FileChange[];
          try {
            batch = targets(selected, entry.id);
          } catch {
            continue;
          }
          if (!batch.length) continue;
          actions.push({
            id,
            title: `${label} (${batch.length} changes)…`,
            run: () =>
              backend.action(async (check) => {
                const files = [...new Set(batch.map((row) => row.path))];
                const created = batch.filter(
                  (row) => row.before === null,
                ).length;
                if (
                  !(await confirm(
                    id === "batch"
                      ? "Confirm rollback to here"
                      : "Confirm rollback of this run",
                    `${batch.length} changes across ${files.length} files, newest first:\n${files.join("\n")}\n${created ? `${created} created files will be removed. ` : ""}Stops at the first conflict; changes already rolled back stay rolled back.`,
                    signal,
                  ))
                )
                  return;
                check();
                const fresh = reliable((await backend.changes(signal)).items);
                check();
                const latest = targets(fresh, entry.id);
                if (JSON.stringify(latest) !== JSON.stringify(batch))
                  throw Error(
                    "The selected changes were updated; review the batch again",
                  );
                const result = await runBatchRollback(
                  latest,
                  async (id) => {
                    check();
                    await backend.change(
                      fresh.find((row) => row.id === id)!,
                      false,
                      signal,
                    );
                  },
                  signal,
                );
                if (result.failed)
                  throw Error(
                    `Rolled back ${result.completed}/${result.total} changes, then stopped at ${result.failed.entry.path}: ${String(result.failed.error)}. Remaining changes were kept.`,
                  );
                view.notice(
                  `Rolled back ${result.total} changes across ${files.length} files.`,
                );
              }, signal),
          });
        }
      }
      return {
        title: entry.path,
        text: `${entry.state} · ${entry.source}${entry.readOnly ? " · read-only" : ""}\nSession: ${entry.sessionId}${entry.runId ? `\nRun: ${entry.runId}` : ""}${changeWarnings.length ? `\n${changeWarnings.join("\n")}` : ""}${partLabel(item.id, part)}\n\n${part.data}`,
        actions,
      };
    },
  };
  const Activity: ObjectSource = {
    title: "Activity",
    description:
      "Queue · steering · child agents · terminals · saved runs. Search covers this loaded page; reading keeps execution moving.",
    get actions() {
      const page = historyPage,
        index = historyIndex;
      if (!page) return [];
      return [
        ...(index
          ? [
              {
                id: "history.previous",
                title: "Previous saved runs",
                run: () => {
                  backend.current();
                  historyIndex = index - 1;
                },
              },
            ]
          : []),
        ...(page.nextBefore !== null
          ? [
              {
                id: "history.earlier",
                title: `Earlier saved runs (page ${index + 2})`,
                run: () => {
                  backend.current();
                  historyCursors.splice(index + 1, Infinity, {
                    snapshot: page.snapshot,
                    before: page.nextBefore!,
                  });
                  historyIndex = index + 1;
                },
              },
            ]
          : []),
        ...(index
          ? [
              {
                id: "history.latest",
                title: "Latest saved runs",
                run: () => {
                  backend.current();
                  historyCursors.splice(0, Infinity, {});
                  historyIndex = 0;
                },
              },
            ]
          : []),
        {
          id: "history.all",
          title: "Browse full run history…",
          run: async () => {
            backend.current();
            await view.command("/tasks history");
          },
        },
      ];
    },
    async load(signal) {
      backend.current(signal);
      const index = historyIndex,
        cursor = historyCursors[index]!;
      let loadedHistory: ExecutionHistoryPage | undefined;
      const source = backend.execution(),
        next = new Map<
          string,
          { kind: ExecutionKind; item: ExecutionItem; snapshot?: number }
        >();
      for (const kind of [
        "queue",
        "steering",
        "children",
        "terminals",
      ] as const) {
        const items = await source.list(kind);
        backend.current(signal);
        for (const item of items)
          next.set(`${kind}:${item.id}`, { kind, item });
      }
      if (source.history) {
        const page = await source.history.list(cursor, signal);
        backend.current(signal);
        if (
          !Number.isSafeInteger(page.snapshot) ||
          page.snapshot < 0 ||
          (cursor.snapshot !== undefined &&
            cursor.snapshot !== page.snapshot) ||
          (page.nextBefore !== null &&
            (!Number.isSafeInteger(page.nextBefore) ||
              page.nextBefore < 1 ||
              page.nextBefore > page.snapshot ||
              (cursor.before !== undefined &&
                page.nextBefore >= cursor.before)))
        )
          throw Error("Invalid history cursor; refresh Activity");
        loadedHistory = page;
        for (const item of page.items)
          next.set(`history:${item.id}`, {
            kind: "history",
            item,
            snapshot: page.snapshot,
          });
      } else {
        for (const item of await source.list("history"))
          next.set(`history:${item.id}`, { kind: "history", item });
      }
      backend.current(signal);
      activity = next;
      historyPage = loadedHistory;
      return [...next].map(([id, { kind, item }]) => ({
        id,
        title: item.title,
        group:
          kind === "history" && loadedHistory
            ? `history · page ${index + 1}`
            : kind,
        description: item.state,
      }));
    },
    async detail(object, signal) {
      backend.current(signal);
      const ref = activity.get(object.id);
      if (!ref) throw Error("Execution item is no longer in this view");
      const source = backend.execution();
      const item =
        ref.kind === "history" && source.history
          ? await source.history.detail(ref.item.id, ref.snapshot, signal)
          : await source.detail(ref.kind, ref.item.id);
      backend.current(signal);
      if (item.id !== ref.item.id) throw Error("Execution identity changed");
      const actions: ObjectAction[] = [
        {
          id: "reference",
          title: "Reference this activity in draft",
          run: () => {
            backend.current(signal);
            append(`${ref.kind}: ${item.id}\n${item.title}`);
          },
        },
      ];
      if (
        ref.kind !== "history" &&
        backend.writable() &&
        backend.capable("execution.action")
      )
        for (const action of item.actions) {
          if (
            (ref.kind === "queue" || ref.kind === "steering") &&
            (!backend.capable("execution.hold") ||
              !backend.capable("execution.release"))
          )
            continue;
          actions.push({
            id: action.value,
            title: action.label,
            run: () =>
              backend.action(async (check) => {
                let text: string | undefined;
                if (action.value === "edit" || action.value === "send")
                  text = await prompt(
                    action.label,
                    action.value === "edit" ? (item.editText ?? "") : "",
                    signal,
                  );
                else if (
                  ["remove", "resume", "stop"].includes(action.value) &&
                  !(await confirm(
                    action.label,
                    `${item.title}\n${item.state}\n${action.value === "resume" ? "This permits the recovered message to be consumed." : action.value === "remove" ? "This removes the pending message." : "This requests a stop; inspect its final state afterward."}`,
                    signal,
                  ))
                )
                  return;
                if (
                  action.value === "send" &&
                  !(await confirm(
                    "Send terminal input?",
                    `${item.title}\n${text}\nSends this line to the running terminal.`,
                    signal,
                  ))
                )
                  return;
                check();
                const held = ref.kind === "queue" || ref.kind === "steering";
                let release: (() => Promise<void>) | undefined;
                try {
                  if (held) release = await source.hold();
                  check();
                  const fresh = await source.detail(ref.kind, item.id);
                  check();
                  if (
                    fresh.state !== item.state ||
                    fresh.editText !== item.editText ||
                    !fresh.actions.some((a) => a.value === action.value)
                  )
                    throw Error(
                      "This item changed while you were deciding; inspect it again",
                    );
                  await source.act(
                    ref.kind,
                    item.id,
                    action.value,
                    action.value === "send" ? text + "\n" : text,
                  );
                } finally {
                  await release?.();
                }
              }, signal),
          });
        }
      return {
        title: item.title,
        text: `${item.state}\n\n${item.detail.replace("Consumption is paused while this manager is open.", "Reading this page does not pause consumption.")}`,
        actions,
      };
    },
  };
  const Plan: ObjectSource = {
    title: "Plan",
    description:
      "Current plan, reported progress, questions, versions, and recorded evidence",
    async load(signal) {
      backend.current(signal);
      const state = await backend.plan(signal),
        next = new Map<string, PlanObject>();
      const result: WorkspaceObject[] = [
        {
          id: "current",
          title: state.plan?.title ?? "No proposed plan",
          group: state.active ? "Plan mode" : "Execution mode",
          description: state.incomplete
            ? "Earlier versions may be incomplete"
            : undefined,
        },
      ];
      next.set("current", { type: "current", state });
      if (backend.capable("questions.read"))
        for (const question of await backend.questions(signal)) {
          const id = `question:${question.id}`;
          next.set(id, { type: "question", question });
          result.push({
            id,
            title: question.questions.map((q) => q.question).join(" · "),
            group: "Questions",
          });
        }
      if (state.progress) {
        for (const [index, step] of state.progress.steps.entries()) {
          const id = `step:${index + 1}`;
          next.set(id, { type: "step", step: index + 1, state });
          result.push({
            id,
            title: `${index + 1}. ${step.text}`,
            group: step.status,
            description: step.note,
          });
        }
        for (const evidence of [
          ...state.progress.steps.map((step) => step.evidence),
          state.progress.unassigned,
        ])
          for (const tool of evidence?.tools ?? []) {
            const id = evidenceId(tool, state.progress.planId);
            next.set(id, {
              type: "evidence",
              tool,
              plan: state.progress.planId,
            });
            result.push({
              id,
              title: `${tool.name} · ${tool.status}`,
              group: tool.step
                ? `Step ${tool.step} evidence`
                : "Unassigned evidence",
              description: tool.preview,
            });
          }
      }
      if (backend.capable("plan.history") && backend.capable("plan.version")) {
        let before: number | undefined;
        for (;;) {
          const history = await backend.versions(before, signal);
          backend.current(signal);
          state.incomplete ||= history.incomplete;
          for (const version of history.items) {
            const id = `version:${version.id}`;
            next.set(id, { type: "version", id: version.id });
            result.push({
              id,
              title: version.title,
              group: `Version ${version.revision}`,
            });
          }
          if (history.nextBefore === null) break;
          if (
            !Number.isSafeInteger(history.nextBefore) ||
            history.nextBefore < 1 ||
            (before !== undefined && history.nextBefore >= before)
          )
            throw Error("Invalid plan history cursor");
          before = history.nextBefore;
        }
      }
      backend.current(signal);
      plans = next;
      return result;
    },
    async detail(item, signal) {
      backend.current(signal);
      const ref = plans.get(item.id);
      if (!ref) throw Error("Plan item is no longer in this view");
      if (ref.type === "question")
        return {
          title: "Questions waiting for you",
          text: ref.question.questions
            .map(
              (q) =>
                `${q.question}${q.options ? `\n${q.options.map((option, i) => `${i + 1}. ${option}`).join("\n")}` : ""}`,
            )
            .join("\n\n"),
          actions:
            backend.writable() && backend.capable("questions.respond")
              ? [
                  command(
                    "answer",
                    "Answer saved questions…",
                    "/questions",
                    signal,
                  ),
                ]
              : [],
        };
      if (ref.type === "evidence") {
        const part = textPart(
          await backend.evidence(
            ref.tool,
            ref.plan,
            pageOffset(item.id),
            signal,
          ),
          pageOffset(item.id),
        );
        backend.current(signal);
        return {
          title: `${ref.tool.name} · ${ref.tool.status}`,
          text: `Session: ${ref.tool.sessionId}\nCall: ${ref.tool.callId}${partLabel(item.id, part)}${part.truncated ? "\nThe saved result was truncated by the host." : ""}\n\n${part.data}`,
          actions: [
            ...pages(item.id, part, signal),
            {
              id: "reference",
              title: "Reference this evidence in draft",
              run: () => {
                backend.current(signal);
                append(
                  `Plan ${ref.plan} · ${ref.tool.name} · call ${ref.tool.callId}\n${part.data}`,
                );
              },
            },
          ],
        };
      }
      if (ref.type === "step") {
        const step = ref.state.progress!.steps[ref.step - 1]!;
        const related = await backend.changes(signal);
        backend.current(signal);
        const matching = related.items.filter((entry) => {
          const plan =
            entry.state === "observed" ? entry.plan : entry.origin?.plan;
          return (
            plan?.sessionId === backend.id &&
            plan.planId === ref.state.progress!.planId &&
            plan.step === ref.step
          );
        });
        const tools = step.evidence?.tools ?? [];
        return {
          title: `Step ${ref.step} · ${step.status}`,
          text: `${step.text}\n\n${step.note ?? "No progress note."}\n\nStep status is model-reported, not independent verification.\nRecorded edits: ${step.evidence?.reliable ?? 0} · Observed changes: ${step.evidence?.observed ?? 0}${ref.state.progress!.evidenceIncomplete ? "\nEvidence is incomplete; consult Activity and Changes for retained records." : ""}`,
          actions: [
            ...matching.slice(0, 4).map((entry) => ({
              id: changeId(entry),
              title: `Read change: ${title(entry)}`,
              run: async () => {
                backend.current(signal);
                await view.openWorkspaceObject("Changes", changeId(entry));
              },
            })),
            ...tools.slice(0, 4).map((tool) => ({
              id: evidenceId(tool, ref.state.progress!.planId),
              title: `Read evidence: ${tool.name}`,
              run: async () => {
                backend.current(signal);
                await view.openWorkspaceObject(
                  "Plan",
                  evidenceId(tool, ref.state.progress!.planId),
                );
              },
            })),
            {
              id: "changes",
              title: "View all changes",
              run: () => {
                backend.current(signal);
                view.selectWorkspace("Changes");
              },
            },
          ],
        };
      }
      const plan =
        ref.type === "version"
          ? await backend.version(ref.id, signal)
          : ref.state.plan;
      backend.current(signal);
      return {
        title: plan?.title ?? "Plan",
        text: plan
          ? `${plan.steps.map((step, i) => `${i + 1}. ${step}`).join("\n\n")}\n\nValidation\n${plan.validation}${ref.type === "current" && ref.state.incomplete ? "\n\nEarlier plan versions may be incomplete." : ""}`
          : "No plan has been proposed. Enter Plan mode to explore a task before approving execution.",
        actions:
          ref.type === "current" &&
          backend.writable() &&
          backend.capable("plan.set")
            ? [
                command(
                  "mode",
                  ref.state.active
                    ? "Review or leave Plan mode…"
                    : "Enter Plan mode",
                  "/plan",
                  signal,
                ),
              ]
            : [],
      };
    },
  };
  const Context: ObjectSource = {
    title: "Context",
    description:
      "Draft attachments, active model, workspace instructions, skills, and tools",
    async load(signal) {
      backend.current(signal);
      const result: WorkspaceObject[] = [
        { id: "draft", title: "Draft and attachments", group: "Input" },
        { id: "model", title: "Model and context", group: "Model" },
      ];
      try {
        for (const path of new Set(
          parseFileReferences(view.editor.getExpandedText()),
        ))
          result.push({
            id: `attachment:${JSON.stringify(path)}`,
            title: path,
            group: "Draft attachment",
            description: "Explicit reference; validated when submitted",
          });
      } catch {
        // The draft object explains malformed syntax without hiding other context.
      }
      const next = new Map<string, ResourceEntry>();
      if (backend.capable("resources.list")) {
        let offset = 0;
        for (;;) {
          const page = await backend.resources(offset, signal);
          backend.current(signal);
          for (const resource of page.items) {
            const id = `resource:${JSON.stringify([resource.kind, resource.name, resource.path])}`;
            next.set(id, resource);
            result.push({
              id,
              title: resource.name,
              group: resource.kind,
              description: resource.description,
            });
          }
          if (!page.hasMore) break;
          if (!page.items.length) throw Error("Resource page did not advance");
          offset += page.items.length;
        }
      }
      backend.current(signal);
      resources = next;
      return result;
    },
    async detail(item, signal): Promise<ObjectDetail> {
      backend.current(signal);
      if (item.id.startsWith("attachment:")) {
        const path: unknown = JSON.parse(item.id.slice("attachment:".length));
        if (
          typeof path !== "string" ||
          !parseFileReferences(view.editor.getExpandedText()).includes(path)
        )
          throw Error("Attachment is no longer present in this draft");
        const preview = await view.options.previewAttachment?.(path, signal);
        backend.current(signal);
        return {
          title: path,
          text: `Draft attachment\n${attachmentReference(JSON.stringify(path))}\n\n${preview ?? "This reference will be resolved on the execution host and validated when you submit. The file has not been sent."}`,
          actions: [
            {
              id: "remove",
              title: "Remove attachment from draft",
              run: () => {
                backend.current(signal);
                view.removeDraftAttachment(path);
              },
            },
            {
              id: "input",
              title: "Return to input",
              run: () => {
                backend.current(signal);
                view.selectWorkspace("Conversation");
              },
            },
          ],
        };
      }
      if (item.id === "draft") {
        const text = view.editor.getExpandedText();
        let attachments: string;
        try {
          const paths = parseFileReferences(text);
          attachments = paths.length
            ? paths.map((path) => `• ${path}`).join("\n")
            : "No explicit file references.";
        } catch (error) {
          attachments = String(error);
        }
        return {
          title: "Draft and attachments",
          text: `${attachments}\n\nAttachments are resolved and checked when you submit.\n\n${text || "Your draft is empty."}`,
          actions: [
            {
              id: "input",
              title: "Return to input",
              run: () => {
                backend.current(signal);
                view.selectWorkspace("Conversation");
              },
            },
          ],
        };
      }
      if (item.id === "model")
        return {
          title: "Active model",
          text: backend.model(),
          actions:
            backend.writable() && backend.capable("model.read")
              ? [
                  command(
                    "model",
                    "Choose model or provider account…",
                    "/model",
                    signal,
                  ),
                  command(
                    "context",
                    "Inspect model context…",
                    "/context",
                    signal,
                  ),
                ]
              : [],
        };
      const resource = resources.get(item.id);
      if (!resource) throw Error("Resource is no longer loaded");
      return {
        title: resource.name,
        text: `${resource.kind}${resource.path ? `\n${resource.path}` : ""}\n\n${resource.description}`,
        actions: resource.path
          ? [
              {
                id: "reference",
                title: "Reference file in draft",
                run: () => {
                  backend.current(signal);
                  append(attachmentReference(JSON.stringify(resource.path!)));
                },
              },
            ]
          : [],
      };
    },
  };
  return { Changes, Activity, Plan, Context };
}
