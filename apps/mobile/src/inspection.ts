import * as z from "zod";
import type { ClientConnection } from "../../../packages/client-core/src/connection.ts";
import {
  contentPage,
  contentRequestOffset,
  type ContentPage,
} from "./content.ts";

export const MAX_IMAGE_CHARS = 16 * 1024 * 1024;
const imageSchema = z.object({
  data: z
    .string()
    .max(65536)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  total: z
    .number()
    .int()
    .positive()
    .max(MAX_IMAGE_CHARS, "图片超过 12 MiB 预览限制，请在电脑查看。"),
  nextOffset: z.number().int().nonnegative().nullable(),
  encoding: z.literal("base64"),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
});
const entrySchema = z.object({
  id: z.string().uuid(),
  path: z.string().max(65536),
  timestamp: z.number(),
  before: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  after: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["prepared", "committed", "reverting", "reverted"]),
});
export type ChangeEntry = z.infer<typeof entrySchema>;
type InspectionConnection = Pick<ClientConnection, "request" | "supports"> & {
  state: { canAct: boolean; session: { id: string } | null };
};
export const emptyInspection = () => ({
  canImages: false,
  canChanges: false,
  kind: null as "image" | "changes" | null,
  loading: false,
  error: null as string | null,
  image: null as {
    seq: number;
    index: number;
    count: number;
    uri: string | null;
    loaded: number;
    total: number;
  } | null,
  changes: null as {
    items: ChangeEntry[];
    offset: number;
    more: boolean;
    previous: number[];
  } | null,
  diff: null as {
    entry: ChangeEntry;
    offset: number;
    page: ContentPage | null;
  } | null,
});
export type InspectionState = ReturnType<typeof emptyInspection>;

/** Session-scoped, memory-only reading; invalidation never resumes a read. */
export class MobileInspection {
  state = emptyInspection();
  private client: InspectionConnection | null = null;
  private sessionId: string | null = null;
  private generation = 0;
  constructor(private changed: (state: InspectionState) => void) {}
  private update(patch: Partial<InspectionState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  bind(client: InspectionConnection | null) {
    const sessionId = client?.state.session?.id ?? null;
    if (client === this.client && sessionId === this.sessionId) return;
    this.close();
    this.client = client;
    this.sessionId = sessionId;
    this.update({
      canImages: !!sessionId && !!client?.supports("messages.content"),
      canChanges:
        !!sessionId &&
        !!client?.supports("changes.list") &&
        !!client?.supports("changes.diff"),
    });
  }
  close() {
    this.generation++;
    const { canImages, canChanges } = this.state;
    this.update({ ...emptyInspection(), canImages, canChanges });
  }
  private begin(method: "messages.content" | "changes.list" | "changes.diff") {
    const client = this.client,
      sessionId = this.sessionId;
    if (!client?.state.canAct || !sessionId || !client.supports(method))
      throw Error("当前任务不可读取，或电脑版本尚不支持。");
    const generation = ++this.generation;
    const guard = () => {
      if (
        generation !== this.generation ||
        client !== this.client ||
        !client.state.canAct ||
        client.state.session?.id !== sessionId
      )
        throw Error("Reading context changed");
    };
    return { client, sessionId, generation, guard };
  }
  private fail(generation: number, error: unknown) {
    if (generation === this.generation)
      this.update({
        loading: false,
        error: `无法读取，请核对任务授权后重试。\n${String(error).slice(0, 500)}`,
      });
  }
  async readImage(seq: number, index: number, count: number) {
    if (
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 1025 ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= count
    )
      throw Error("Invalid image selection");
    const c = this.begin("messages.content");
    const image = { seq, index, count, uri: null, loaded: 0, total: 0 };
    this.update({
      kind: "image",
      loading: true,
      error: null,
      image,
      changes: null,
      diff: null,
    });
    try {
      const chunks: string[] = [];
      let offset = 0,
        total: number | undefined,
        mimeType: string | undefined;
      do {
        c.guard();
        const page = imageSchema.parse(
          await c.client.request(
            "messages.content",
            {
              sessionId: c.sessionId,
              seq,
              image: index,
              field: "image",
              offset,
              limit: 65536,
            },
            { beforeSend: c.guard },
          ),
        );
        c.guard();
        const end = Math.min(page.total, offset + 65536);
        if (
          page.total % 4 ||
          page.data.length !== end - offset ||
          (total !== undefined && total !== page.total) ||
          (mimeType !== undefined && mimeType !== page.mimeType) ||
          page.nextOffset !== (end < page.total ? end : null) ||
          (end < page.total && page.data.includes("="))
        )
          throw Error("Inconsistent image page");
        total = page.total;
        mimeType = page.mimeType;
        chunks.push(page.data);
        offset = end;
        this.update({ image: { ...image, loaded: offset, total } });
      } while (offset < total!);
      c.guard();
      this.update({
        loading: false,
        image: {
          ...image,
          loaded: offset,
          total: total!,
          uri: `data:${mimeType};base64,${chunks.join("")}`,
        },
      });
    } catch (error) {
      this.fail(c.generation, error);
      throw error;
    }
  }
  async listChanges(offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000)
      throw Error("Invalid change page");
    const c = this.begin("changes.list"),
      current = this.state.changes;
    const previous = !offset
      ? []
      : current && offset > current.offset
        ? [...current.previous, current.offset]
        : (current?.previous.filter((n) => n < offset) ?? []);
    this.update({
      kind: "changes",
      loading: true,
      error: null,
      image: null,
      diff: null,
    });
    try {
      const page = z
        .object({ items: z.array(entrySchema).max(100), more: z.boolean() })
        .parse(
          await c.client.request(
            "changes.list",
            { sessionId: c.sessionId, offset },
            { beforeSend: c.guard },
          ),
        );
      c.guard();
      if (
        page.more &&
        (!page.items.length || offset + page.items.length >= 10000)
      )
        throw Error("Incomplete change page");
      this.update({ loading: false, changes: { ...page, offset, previous } });
    } catch (error) {
      this.fail(c.generation, error);
      throw error;
    }
  }
  async readDiff(id: string, offset = 0) {
    z.uuid().parse(id);
    const requestOffset = contentRequestOffset(offset),
      c = this.begin("changes.diff");
    const expected =
      this.state.diff?.entry.id === id
        ? this.state.diff.entry
        : this.state.changes?.items.find((e) => e.id === id);
    this.update({
      kind: "changes",
      loading: true,
      error: null,
      image: null,
      diff: expected ? { entry: expected, offset, page: null } : null,
    });
    try {
      const raw = await c.client.request(
        "changes.diff",
        { sessionId: c.sessionId, id, offset: requestOffset, limit: 8192 },
        { beforeSend: c.guard },
      );
      c.guard();
      const { entry } = z.object({ entry: entrySchema }).parse(raw);
      if (
        entry.id !== id ||
        (expected && JSON.stringify(entry) !== JSON.stringify(expected))
      )
        throw Error("Change record changed; refresh the list");
      this.update({
        loading: false,
        diff: { entry, offset, page: contentPage(raw, offset) },
      });
    } catch (error) {
      this.fail(c.generation, error);
      throw error;
    }
  }
  closeDiff() {
    this.generation++;
    this.update({ diff: null, error: null, loading: false });
  }
}
