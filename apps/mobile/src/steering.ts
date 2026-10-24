import * as z from "zod";
import type {
  ClientConnection,
  ConnectionOptions,
} from "../../../packages/client-core/src/connection.ts";

const itemSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(100100),
  state: z.string().max(1000),
  detail: z.string().max(110000),
  editText: z.string().max(100000).optional(),
  actions: z
    .array(z.object({ value: z.string().max(32), label: z.string().max(200) }))
    .max(8),
});
export type SteeringItem = z.infer<typeof itemSchema>;
export type SteeringAction = "edit" | "first" | "remove" | "resume";
export type SteeringConnection = {
  state: {
    canAct: boolean;
    session: { id: string } | null;
    sessionRole: "owner" | "control" | "view" | null;
  };
  request: ClientConnection["request"];
};
export const emptySteering = () => ({
  available: false,
  open: false,
  holding: false,
  loading: false,
  pending: false,
  items: [] as SteeringItem[],
  detail: null as SteeringItem | null,
  editText: "",
  error: null as string | null,
  notice: null as string | null,
});
export type SteeringState = ReturnType<typeof emptySteering>;

/** A visible manager owns a short host hold; background work never reacquires it. */
export class MobileSteering {
  state = emptySteering();
  private client: SteeringConnection | null = null;
  private sessionId: string | null = null;
  private token?: string;
  private generation = 0;
  private cancelTimer?: () => void;
  constructor(
    private changed: (state: SteeringState) => void,
    private schedule: ConnectionOptions["schedule"],
  ) {}
  private update(patch: Partial<SteeringState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  bind(client: SteeringConnection | null) {
    const sessionId = client?.state.session?.id ?? null;
    if (client === this.client && sessionId === this.sessionId) return;
    void this.close();
    this.client = client;
    this.sessionId = sessionId;
    this.update({ available: !!client && !!sessionId });
  }
  private guard(
    client: SteeringConnection,
    sessionId: string,
    generation: number,
  ) {
    if (
      generation !== this.generation ||
      client !== this.client ||
      !client.state.canAct ||
      client.state.session?.id !== sessionId ||
      !["owner", "control"].includes(client.state.sessionRole ?? "")
    )
      throw Error("Session changed or control permission unavailable");
  }
  private release(
    client: SteeringConnection,
    sessionId: string,
    token: string,
  ) {
    return Promise.resolve()
      .then(() =>
        client.request(
          "execution.release",
          { sessionId, token },
          {
            beforeSend: () => {
              if (
                !client.state.canAct ||
                client.state.session?.id !== sessionId
              )
                throw Error("Connection changed; host hold will expire");
            },
          },
        ),
      )
      .catch(() => {});
  }
  async close() {
    const client = this.client,
      sessionId = this.sessionId,
      token = this.token;
    this.generation++;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.token = undefined;
    this.update({ ...emptySteering(), available: this.state.available });
    if (client && sessionId && token)
      await this.release(client, sessionId, token);
  }
  async open(sessionId: string) {
    if (this.state.open) throw Error("Manager already open");
    const client = this.client,
      generation = ++this.generation;
    if (!client || sessionId !== this.sessionId)
      throw Error("Current session control required");
    const guard = () => this.guard(client, sessionId, generation);
    guard();
    this.update({ open: true, loading: true, error: null });
    try {
      const { token } = z
        .object({ token: z.string().min(1).max(128) })
        .parse(
          await client.request(
            "execution.hold",
            { sessionId },
            { beforeSend: guard },
          ),
        );
      if (generation !== this.generation) {
        await this.release(client, sessionId, token);
        return;
      }
      this.token = token;
      this.update({ holding: true, loading: false });
      await this.refresh();
    } catch (error) {
      if (generation === this.generation)
        this.update({
          error: "未能打开补充指令队列，请重新打开。",
          holding: false,
        });
      throw error;
    } finally {
      if (generation === this.generation) this.update({ loading: false });
    }
  }
  private context() {
    const client = this.client,
      sessionId = this.sessionId,
      token = this.token,
      generation = this.generation;
    if (!client || !sessionId || !token || !this.state.holding)
      throw Error("Queue hold unavailable; reopen manager");
    const guard = () => this.guard(client, sessionId, generation);
    guard();
    return { client, sessionId, token, generation, guard };
  }
  private arm() {
    this.cancelTimer?.();
    if (!this.state.open || !this.state.holding) return;
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = undefined;
      if (this.state.loading || this.state.pending) this.arm();
      else void this.renew();
    }, 5000);
  }
  private async renew() {
    const generation = this.generation;
    try {
      const c = this.context();
      // Keep native focus and selection intact: lease renewal is not UI loading.
      await c.client.request(
        "execution.read",
        {
          sessionId: c.sessionId,
          token: c.token,
          kind: "steering",
        },
        { beforeSend: c.guard },
      );
      c.guard();
      this.arm();
    } catch {
      if (generation === this.generation)
        this.update({
          holding: false,
          error: "队列锁或连接已失效，请重新打开。未确认操作不会自动重发。",
        });
    }
  }
  async refresh() {
    const c = this.context();
    if (this.state.loading || this.state.pending) return;
    this.update({ loading: true });
    try {
      const items = z
        .array(itemSchema)
        .max(16)
        .parse(
          await c.client.request(
            "execution.read",
            { sessionId: c.sessionId, token: c.token, kind: "steering" },
            { beforeSend: c.guard },
          ),
        );
      c.guard();
      this.update({ items });
      this.arm();
    } catch (error) {
      if (c.generation === this.generation) {
        this.cancelTimer?.();
        this.update({
          holding: false,
          error: "队列锁或连接已失效，请重新打开。未确认操作不会自动重发。",
        });
      }
      throw error;
    } finally {
      if (c.generation === this.generation) this.update({ loading: false });
    }
  }
  async inspect(id: string) {
    const c = this.context();
    if (this.state.pending || this.state.loading)
      throw Error("Queue operation pending");
    this.update({ loading: true });
    try {
      const detail = itemSchema.parse(
        await c.client.request(
          "execution.read",
          { sessionId: c.sessionId, token: c.token, kind: "steering", id },
          { beforeSend: c.guard },
        ),
      );
      c.guard();
      if (detail.id !== id) throw Error("Queue item mismatch");
      this.update({
        detail,
        editText: detail.editText ?? "",
        error: null,
        notice: null,
      });
    } catch (error) {
      if (c.generation === this.generation)
        this.update({ error: "这项指令已变化或暂时无法读取，请刷新队列。" });
      throw error;
    } finally {
      if (c.generation === this.generation) this.update({ loading: false });
    }
  }
  edit(editText: string) {
    if (
      !this.state.detail ||
      this.state.pending ||
      this.state.loading ||
      editText.length > 100000
    )
      throw Error("Cannot edit this queue item");
    this.update({ editText });
  }
  dismissDetail() {
    this.update({ detail: null, editText: "", error: null });
  }
  async act(id: string, action: SteeringAction) {
    const c = this.context(),
      detail = this.state.detail,
      text = this.state.editText;
    if (
      this.state.pending ||
      this.state.loading ||
      detail?.id !== id ||
      !detail.actions.some((a) => a.value === action)
    )
      throw Error("Queue item changed; refresh before deciding");
    if (action === "edit" && !text.trim())
      throw Error("Steering message cannot be empty");
    this.update({ pending: true, error: null, notice: null });
    try {
      const result = await c.client.request(
        "execution.action",
        {
          sessionId: c.sessionId,
          token: c.token,
          kind: "steering",
          id,
          action,
          ...(action === "edit" ? { text } : {}),
        },
        { beforeSend: c.guard },
      );
      z.object({ completed: z.literal(true) }).parse(result);
      c.guard();
      this.update({
        detail: null,
        editText: "",
        notice:
          action === "resume"
            ? "已确认用于下一模型轮，没有启动新任务。"
            : "电脑已确认修改。",
      });
    } catch (error) {
      if (c.generation === this.generation)
        this.update({
          error: `修改未确认，请核对操作回执后刷新。原文已保留，不会自动重发。\n${String(error).slice(0, 1000)}`,
        });
      throw error;
    } finally {
      if (c.generation === this.generation) this.update({ pending: false });
    }
    if (c.generation === this.generation) await this.refresh();
  }
}
