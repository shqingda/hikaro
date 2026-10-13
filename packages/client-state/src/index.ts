import type {
  AgentEvent,
  Message,
  PermissionRequest,
  Session,
} from "../../core/src/types.ts";

export type MessageRow = { seq: number; message: Message };
export type SessionSnapshot = {
  session?: Session | null;
  busy: boolean;
  approvals: PermissionRequest[];
  cursor: number;
  stream: string;
  streamTruncated?: boolean;
};
export interface ClientTransport {
  request(method: string, params?: Record<string, unknown>): Promise<any>;
  subscribe(listener: (message: any) => void): () => void;
}
export type ClientState = {
  status: string;
  recovering: boolean;
  sessions: Session[];
  moreSessions: boolean;
  session?: Session;
  rows: MessageRow[];
  hasOlder: boolean;
  hasNewer: boolean;
  stream: string;
  streamTruncated: boolean;
  busy: boolean;
  approvals: PermissionRequest[];
  actionPending: boolean;
  historyPending: boolean;
  error: string;
};
const PAGE = 40;
const WINDOW = 160;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Platform-free state shared by desktop and mobile. No process or UI ownership. */
export class SessionController {
  private state: ClientState = {
    status: "disconnected",
    recovering: false,
    sessions: [],
    moreSessions: false,
    rows: [],
    hasOlder: false,
    hasNewer: false,
    stream: "",
    streamTruncated: false,
    busy: false,
    approvals: [],
    actionPending: false,
    historyPending: false,
    error: "",
  };
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  private epoch = 0;
  private cursor = 0;
  private queued: any[] = [];
  private preferred?: string;
  private disposed = false;
  private streamFrame?: ReturnType<typeof setTimeout>;
  private liveStream = "";
  constructor(
    private transport: ClientTransport,
    private onSession?: (session: Session) => void,
  ) {
    this.unsubscribe = transport.subscribe((message) => this.receive(message));
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<ClientState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setPreferredSession(id?: string) {
    this.preferred = id;
  }
  setError(error: unknown) {
    this.update({ error: errorText(error) });
  }
  clearError() {
    this.update({ error: "" });
  }
  private receive(message: any) {
    if (this.disposed) return;
    if (message.type === "connection") {
      if (message.status === "connected") void this.recover();
      else {
        this.epoch++;
        this.queued = [];
        this.update({
          status: message.status,
          recovering: false,
          actionPending: false,
          error: message.error ?? this.state.error,
        });
      }
      return;
    }
    if (message.type === "error") {
      this.setError(message.error);
      return;
    }
    if (this.state.recovering) {
      this.queued.push(message);
      return;
    }
    this.applyMessage(message);
  }
  private applyMessage(message: any) {
    if (message.type === "approval") {
      const request = message.request as PermissionRequest;
      this.update({
        approvals: [
          ...this.state.approvals.filter((a) => a.id !== request.id),
          request,
        ],
      });
    } else if (message.type === "approval.resolved") {
      this.update({
        approvals: this.state.approvals.filter((a) => a.id !== message.id),
      });
    } else if (message.type === "event") this.applyEvent(message.event);
  }
  private applyEvent(event: AgentEvent) {
    if (event.sessionId !== this.state.session?.id || event.seq <= this.cursor)
      return;
    this.cursor = event.seq;
    if (event.type === "run.start") {
      this.liveStream = "";
      this.update({
        busy: true,
        stream: "",
        streamTruncated: false,
        error: "",
      });
    }
    if (event.type === "text.delta") {
      this.liveStream += String(event.data.text ?? "");
      let truncated = this.state.streamTruncated;
      if (this.liveStream.length > 100_000) {
        this.liveStream = this.liveStream.slice(-100_000);
        truncated = true;
      }
      // One text update per frame budget; permission and lifecycle events never wait.
      if (!this.streamFrame)
        this.streamFrame = setTimeout(() => {
          this.streamFrame = undefined;
          this.update({ stream: this.liveStream, streamTruncated: truncated });
        }, 16);
    }
    if (event.type === "message") {
      const row = { seq: event.seq, message: event.data.message as Message };
      if (
        !this.state.hasNewer &&
        !this.state.rows.some((r) => r.seq === event.seq)
      ) {
        const rows = [...this.state.rows, row];
        this.update({
          rows: rows.slice(-WINDOW),
          hasOlder: this.state.hasOlder || rows.length > WINDOW,
        });
      }
      if (row.message.role === "assistant") {
        clearTimeout(this.streamFrame);
        this.streamFrame = undefined;
        this.liveStream = "";
        this.update({ stream: "", streamTruncated: false });
      }
    }
    if (event.type === "run.end") {
      clearTimeout(this.streamFrame);
      this.streamFrame = undefined;
      this.update({
        busy: false,
        approvals: [],
        stream: this.liveStream,
        error: event.data.error ? String(event.data.error) : this.state.error,
      });
      if (!this.state.recovering)
        void this.refreshSessions().catch((error) => this.setError(error));
    }
  }
  async refreshSessions(more = false) {
    const offset = more ? this.state.sessions.length : 0;
    const page: Session[] = await this.transport.request("session.list", {
      offset,
      limit: PAGE,
    });
    const sessions = more ? [...this.state.sessions, ...page] : page;
    this.update({
      sessions: [...new Map(sessions.map((s) => [s.id, s])).values()],
      moreSessions: page.length === PAGE,
    });
  }
  async recover(preferred = this.preferred) {
    const epoch = ++this.epoch;
    clearTimeout(this.streamFrame);
    this.streamFrame = undefined;
    this.queued = [];
    this.update({ status: "connected", recovering: true, error: "" });
    try {
      let snapshot: SessionSnapshot =
        await this.transport.request("session.current");
      if (epoch !== this.epoch) return;
      if (!snapshot.session) {
        if (preferred) {
          try {
            await this.transport.request("session.resume", {
              sessionId: preferred,
            });
          } catch {
            await this.transport.request("session.create");
          }
        } else await this.transport.request("session.create");
        snapshot = await this.transport.request("session.current");
      }
      if (!snapshot.session) throw Error("The host did not open a session.");
      const page = await this.transport.request("messages.read", {
        sessionId: snapshot.session.id,
        limit: PAGE,
      });
      if (epoch !== this.epoch) return;
      this.cursor = snapshot.cursor;
      this.liveStream = snapshot.stream ?? "";
      this.update({
        session: snapshot.session,
        rows: page.items,
        hasOlder: page.hasOlder,
        hasNewer: page.hasNewer,
        busy: snapshot.busy,
        approvals: snapshot.approvals ?? [],
        stream: this.liveStream,
        streamTruncated: snapshot.streamTruncated ?? false,
      });
      let after = snapshot.cursor;
      for (;;) {
        const events: AgentEvent[] = await this.transport.request(
          "events.read",
          { sessionId: snapshot.session.id, after, limit: 200 },
        );
        if (epoch !== this.epoch) return;
        for (const event of events) {
          this.applyEvent(event);
          after = event.seq;
        }
        if (events.length < 200) break;
      }
      // Replay live events only after the snapshot so a delayed page cannot overwrite them.
      for (const message of this.queued) this.applyMessage(message);
      this.queued = [];
      this.preferred = snapshot.session.id;
      this.onSession?.(snapshot.session);
      this.update({ recovering: false });
      await this.refreshSessions();
    } catch (error) {
      if (epoch === this.epoch)
        this.update({ recovering: false, error: errorText(error) });
    }
  }
  async select(id?: string) {
    if (
      this.state.busy ||
      this.state.recovering ||
      this.state.actionPending ||
      this.state.status !== "connected"
    )
      return false;
    this.update({ actionPending: true, error: "" });
    try {
      await this.transport.request(
        id ? "session.resume" : "session.create",
        id ? { sessionId: id } : {},
      );
      await this.recover();
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    } finally {
      this.update({ actionPending: false });
    }
  }
  async history(older = true) {
    if (
      !this.state.session ||
      this.state.historyPending ||
      this.state.recovering ||
      this.state.status !== "connected"
    )
      return;
    const epoch = this.epoch;
    this.update({ historyPending: true });
    try {
      const page = await this.transport.request("messages.read", {
        sessionId: this.state.session.id,
        limit: PAGE,
        ...(older && this.state.rows[0]
          ? { before: this.state.rows[0].seq }
          : {}),
      });
      if (epoch !== this.epoch) return;
      const rows: MessageRow[] = older
        ? [...page.items, ...this.state.rows]
        : page.items;
      this.update({
        rows: rows.slice(0, WINDOW),
        hasOlder: page.hasOlder,
        hasNewer: older
          ? this.state.hasNewer || rows.length > WINDOW
          : page.hasNewer,
      });
    } catch (error) {
      if (epoch === this.epoch) this.setError(error);
    } finally {
      if (epoch === this.epoch) this.update({ historyPending: false });
    }
  }
  async send(text: string) {
    if (
      !text.trim() ||
      !this.state.session ||
      this.state.status !== "connected" ||
      this.state.recovering ||
      this.state.actionPending
    )
      return false;
    this.update({ actionPending: true, error: "" });
    try {
      await this.transport.request(this.state.busy ? "steer" : "prompt", {
        text: text.trim(),
      });
      return true;
    } catch (error) {
      this.setError(error);
      return false;
    } finally {
      this.update({ actionPending: false });
    }
  }
  async cancel() {
    try {
      await this.transport.request("cancel");
    } catch (error) {
      this.setError(error);
    }
  }
  async respond(id: string, allow: boolean) {
    if (this.state.actionPending || this.state.status !== "connected") return;
    this.update({ actionPending: true });
    try {
      await this.transport.request("approval.respond", { id, allow });
      this.update({
        approvals: this.state.approvals.filter((a) => a.id !== id),
      });
    } catch (error) {
      this.setError(error);
    } finally {
      this.update({ actionPending: false });
    }
  }
  dispose() {
    this.disposed = true;
    this.epoch++;
    this.unsubscribe();
    clearTimeout(this.streamFrame);
    this.listeners.clear();
    this.queued = [];
  }
}
