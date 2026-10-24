import type { PendingQuestion } from "../../runtime/src/pending-questions.ts";
import type { PendingPrompt } from "../../core/src/pending-prompts.ts";
import type { PendingSteering } from "../../core/src/steering-queue.ts";
import type {
  DurableCommandReceipt,
  RpcMethod,
  MessageSearchPage,
  QuestionDraft,
  QuestionDraftSnapshot,
  QuestionDraftSaveResult,
} from "../../protocol/src/contracts.ts";
import type { Chunk } from "../../tools/src/indexer.ts";
import type { Job } from "../../core/src/jobs.ts";
import { Worker } from "node:worker_threads";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  EventStore,
  Session,
  AgentEvent,
  Message,
  MessagePage,
  ModelSelection,
  SessionLease,
  ContextCheckpoint,
  ContextCheckpointInput,
  ContextHistory,
} from "../../core/src/types.ts";
export type RunHistoryRecord = {
  id: string;
  /** Metadata is bounded for display; output remains in the session transcript. */
  start?: AgentEvent;
  end?: AgentEvent;
};
export type ToolArtifactPage = {
  items: Array<{
    seq: number;
    name: string;
    callId: string;
    references: Array<{ path: string } | { invalid: true }>;
  }>;
  after: number;
  hasMore: boolean;
};
export class SQLiteStore implements EventStore {
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private next = 0;
  private failure?: Error;
  private closed = false;
  private constructor(private worker: Worker) {
    worker.on("message", ({ id, result, error }) => {
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (error) p?.reject(new Error(error));
      else p?.resolve(result);
    });
    const fail = (e: Error) => {
      this.failure ??= e;
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    };
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (!this.closed && !this.failure)
        fail(new Error(`Storage worker exited (${code})`));
    });
  }
  static async open(path: string) {
    if (path !== ":memory:")
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return new SQLiteStore(
      new Worker(new URL("./worker.mjs", import.meta.url), {
        workerData: { path },
      }),
    );
  }
  private request<T>(
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(Error("Storage is closed"));
    if (this.pending.size >= 1024)
      return Promise.reject(Error("Storage queue capacity exceeded"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }
  saveQuestion(question: PendingQuestion) {
    return this.request<void>("saveQuestion", { question });
  }
  pendingQuestions(sessionId: string, scope: string) {
    return this.request<PendingQuestion[]>("pendingQuestions", {
      sessionId,
      scope,
    });
  }
  questionDraft(input: {
    id: string;
    sessionId: string;
    scope: string;
    workspace?: string;
  }) {
    return this.request<QuestionDraftSnapshot>("questionDraft", input);
  }
  saveQuestionDraft(input: {
    id: string;
    sessionId: string;
    scope: string;
    workspace?: string;
    expectedRevision: number;
    draft: QuestionDraft;
  }) {
    return this.request<QuestionDraftSaveResult>("saveQuestionDraft", input);
  }
  settleQuestion(input: {
    id: string;
    sessionId: string;
    scope: string;
    hostInstanceId: string;
    answers?: Record<string, string>;
    workspace?: string;
    draftRevision?: number;
    /** Trusted lifecycle state: the original waiter ended after cancellation could not be saved. */
    recover?: boolean;
  }) {
    return this.request<{ recovered: boolean }>("settleQuestion", input);
  }
  pendingPrompts(sessionId: string) {
    return this.request<PendingPrompt[]>("pendingPrompts", { sessionId });
  }
  saveChildTask(record: {
    id: string;
    parentId: string;
    task: string;
    state: string;
    output: string;
  }) {
    return this.request<void>("saveChildTask", record);
  }
  childTaskTree(parentId: string) {
    return this.request<
      Array<{
        id: string;
        parentId: string;
        task: string;
        state: string;
        output: string;
        createdAt: number;
      }>
    >("childTaskTree", { parentId });
  }
  pendingSteering(sessionId: string) {
    return this.request<PendingSteering[]>("pendingSteering", { sessionId });
  }
  insertPendingSteering(sessionId: string, item: PendingSteering) {
    return this.request<void>("insertPendingSteering", { sessionId, item });
  }
  updatePendingSteering(sessionId: string, id: string, text: string) {
    return this.request<void>("updatePendingSteering", { sessionId, id, text });
  }
  prioritizePendingSteering(sessionId: string, id: string) {
    return this.request<void>("prioritizePendingSteering", { sessionId, id });
  }
  takePendingSteering(sessionId: string, id: string) {
    return this.request<boolean>("takePendingSteering", { sessionId, id });
  }
  consumePendingSteering(sessionId: string, id: string, lease: SessionLease) {
    return this.request<AgentEvent | undefined>("consumePendingSteering", {
      sessionId,
      id,
      lease,
    });
  }
  insertPendingPrompt(sessionId: string, item: PendingPrompt) {
    return this.request<void>("insertPendingPrompt", { sessionId, item });
  }
  updatePendingPrompt(sessionId: string, id: string, text: string) {
    return this.request<void>("updatePendingPrompt", { sessionId, id, text });
  }
  prioritizePendingPrompt(sessionId: string, id: string) {
    return this.request<void>("prioritizePendingPrompt", { sessionId, id });
  }
  takePendingPrompt(sessionId: string, id: string) {
    return this.request<boolean>("takePendingPrompt", { sessionId, id });
  }
  createSession(
    cwd: string,
    title?: string,
    parentId?: string,
    modelSelection?: ModelSelection,
  ) {
    return this.request<Session>("createSession", {
      cwd,
      title,
      parentId,
      modelSelection,
    });
  }
  setSessionModel(sessionId: string, modelSelection: ModelSelection) {
    return this.request<Session>("setSessionModel", {
      sessionId,
      modelSelection,
    });
  }
  sessions(
    offset = 0,
    limit = 100,
    cwd?: string,
    query?: string,
    scope?: string,
  ) {
    return this.request<Session[]>("sessions", {
      offset,
      limit,
      cwd,
      query,
      scope,
    });
  }
  claimHost(workspace: string, instanceId: string) {
    return this.request<boolean>("claimHost", { workspace, instanceId });
  }
  releaseHost(workspace: string, instanceId: string) {
    return this.request<void>("releaseHost", { workspace, instanceId });
  }
  setSessionAccess(
    workspace: string,
    sessionId: string,
    scope: string,
    role: "owner" | "view" | "control" | null,
  ) {
    return this.request<void>("setSessionAccess", {
      workspace,
      sessionId,
      scope,
      role,
    });
  }
  sessionRole(workspace: string, sessionId: string, scope: string) {
    return this.request<"owner" | "view" | "control" | null>("sessionRole", {
      workspace,
      sessionId,
      scope,
    });
  }
  sessionAccess(workspace: string, sessionId: string) {
    return this.request<
      Array<{ scope: string; role: "owner" | "view" | "control" }>
    >("sessionAccess", { workspace, sessionId });
  }
  attachView(
    workspace: string,
    scope: string,
    sessionId: string,
    local: boolean,
  ) {
    return this.request<"owner" | "view" | "control" | null>("attachView", {
      workspace,
      scope,
      sessionId,
      local,
    });
  }
  saveClientView(workspace: string, scope: string, sessionId: string) {
    return this.request<void>("saveClientView", {
      workspace,
      scope,
      sessionId,
    });
  }
  clientView(workspace: string, scope: string) {
    return this.request<string | null>("clientView", { workspace, scope });
  }
  revokeScope(workspace: string, scope: string) {
    return this.request<void>("revokeScope", { workspace, scope });
  }
  forkSession(id: string) {
    return this.request<Session>("forkSession", { id });
  }
  session(id: string) {
    return this.request<Session | undefined>("session", { id });
  }
  deleteSession(id: string) {
    return this.request<void>("deleteSession", { id });
  }
  rememberSession(id: string) {
    return this.request<void>("rememberSession", { id });
  }
  lastSession(cwd: string) {
    return this.request<Session | undefined>("lastSession", { cwd });
  }
  renameSession(id: string, title: string) {
    return this.request<Session>("renameSession", { id, title });
  }
  draft(id: string) {
    return this.request<string>("draft", { id });
  }
  saveDraft(id: string, text: string) {
    return this.request<void>("saveDraft", { id, text });
  }
  messagePage(
    sessionId: string,
    options: {
      before?: number;
      after?: number;
      limit?: number;
      bounded?: boolean;
    } = {},
  ) {
    return this.request<MessagePage>("messagePage", { sessionId, ...options });
  }
  searchMessages(
    sessionId: string,
    query: string,
    before?: number,
    limit = 20,
  ) {
    return this.request<MessageSearchPage>("searchMessages", {
      sessionId,
      query,
      before,
      limit,
    });
  }
  messageContent(
    sessionId: string,
    seq: number,
    field: "text" | "thinking" | "image" | "artifact" | "toolCalls",
    offset: number,
    limit: number,
    image = 0,
  ) {
    return this.request<{
      data: string;
      total: number;
      nextOffset: number | null;
      encoding: string;
      mimeType?: string;
    }>("messageContent", { sessionId, seq, field, offset, limit, image });
  }
  toolArtifactPage(
    sessionId: string,
    options: { after: number; through: number; limit?: number },
  ) {
    return this.request<ToolArtifactPage>("toolArtifactPage", {
      sessionId,
      ...options,
    });
  }
  latestSeq(sessionId: string) {
    return this.request<number>("latestSeq", { sessionId });
  }
  append(
    sessionId: string,
    type: string,
    data: Record<string, unknown>,
    lease?: SessionLease,
  ) {
    return this.request<AgentEvent>("append", { sessionId, type, data, lease });
  }
  events(sessionId: string, after = 0, limit = 200) {
    return this.request<AgentEvent[]>("events", { sessionId, after, limit });
  }
  messages(sessionId: string, limit = 200) {
    return this.request<Message[]>("messages", { sessionId, limit });
  }
  contextHistory(sessionId: string, options: { after?: number } = {}) {
    return this.request<ContextHistory>("contextHistory", {
      sessionId,
      ...options,
    });
  }
  contextSourcePage(
    sessionId: string,
    options: { after: number; through: number; limit?: number },
  ) {
    return this.request<Array<{ seq: number; message: Message }>>(
      "contextSourcePage",
      { sessionId, ...options },
    );
  }
  async commitContextCheckpoint(
    sessionId: string,
    checkpoint: ContextCheckpointInput,
    lease: SessionLease,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    // The worker may be blocked on SQLite's writer lock. A shared flag lets
    // cancellation win without waiting for the worker's message queue.
    const cancellation = signal
      ? new Int32Array(new SharedArrayBuffer(4))
      : undefined;
    const abort = () => {
      if (cancellation) Atomics.compareExchange(cancellation, 0, 0, 1);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.request<ContextCheckpoint>("commitContextCheckpoint", {
        sessionId,
        ...checkpoint,
        lease,
        cancellation: cancellation?.buffer,
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  indexReplace(workspace: string, path: string, chunks: Chunk[]) {
    return this.request<void>("indexReplace", { workspace, path, chunks });
  }
  indexFiles(workspace: string) {
    return this.request<Array<{ path: string; hash: string }>>("indexFiles", {
      workspace,
    });
  }
  indexPrune(workspace: string, paths: string[]) {
    return this.request<void>("indexPrune", { workspace, paths });
  }
  indexSearch(
    workspace: string,
    query: string,
    vector?: number[],
    model?: string,
  ) {
    return this.request<Chunk[]>("indexSearch", {
      workspace,
      query,
      vector,
      model,
    });
  }
  putJob(job: Job) {
    return this.request<void>("putJob", job);
  }
  jobs() {
    return this.request<Job[]>("jobs");
  }
  claimJob(owner: string, cwd?: string) {
    return this.request<Job | undefined>("claimJob", { owner, cwd });
  }
  finishJob(id: string, owner: string, state: Job["state"], error?: string) {
    return this.request<void>("finishJob", { id, owner, state, error });
  }
  renewJob(id: string, owner: string) {
    return this.request<boolean>("renewJob", { id, owner });
  }
  acquire(sessionId: string, owner: string) {
    return this.request<boolean>("acquire", { sessionId, owner });
  }
  acquireLease(sessionId: string, owner: string) {
    return this.request<SessionLease | undefined>("acquireLease", {
      sessionId,
      owner,
    });
  }
  renewLease(sessionId: string, lease: SessionLease) {
    return this.request<boolean>("renewLease", { sessionId, lease });
  }
  assertLease(sessionId: string, lease?: SessionLease) {
    return this.request<void>("assertLease", { sessionId, lease });
  }
  releaseLease(sessionId: string, lease: SessionLease) {
    return this.request<void>("releaseLease", { sessionId, lease });
  }
  release(sessionId: string, owner: string) {
    return this.request<void>("release", { sessionId, owner });
  }
  recentRunEvents(sessionId: string) {
    return this.request<AgentEvent[]>("recentRunEvents", { sessionId });
  }
  runHistoryPage(
    sessionId: string,
    cursor: { snapshot?: number; before?: number } = {},
  ) {
    return this.request<{
      items: RunHistoryRecord[];
      snapshot: number;
      nextBefore: number | null;
    }>("runHistoryPage", { sessionId, ...cursor });
  }
  runHistoryDetail(sessionId: string, id: string, snapshot?: number) {
    return this.request<RunHistoryRecord | null>("runHistoryDetail", {
      sessionId,
      id,
      snapshot,
    });
  }
  latestRunEvent(sessionId: string) {
    return this.request<AgentEvent | undefined>("latestRunEvent", {
      sessionId,
    });
  }
  acceptCommand(args: {
    workspace: string;
    scope: string;
    id: string;
    method: RpcMethod;
    digest: string;
    hostInstanceId: string;
    sessionId: string | null;
    operationId?: string;
  }) {
    return this.request<{ inserted: boolean; receipt: DurableCommandReceipt }>(
      "acceptCommand",
      args,
    );
  }
  commandReceipt(args: {
    workspace: string;
    scope: string;
    id: string;
    hostInstanceId: string;
  }) {
    return this.request<DurableCommandReceipt | null>("commandReceipt", args);
  }
  finishCommand(args: {
    workspace: string;
    scope: string;
    id: string;
    hostInstanceId: string;
    status: "completed" | "failed";
    sessionId?: string;
    runId?: string;
    operationId?: string;
    error?: string;
  }) {
    return this.request<void>("finishCommand", args);
  }
  claim(commandId: string, sessionId: string) {
    return this.request<boolean>("claim", { commandId, sessionId });
  }
  async close() {
    if (this.closed) return;
    await this.request("close");
    this.closed = true;
    await this.worker.terminate();
  }
}
