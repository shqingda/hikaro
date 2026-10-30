import { randomUUID } from "node:crypto";
import type { AgentEvent, SessionLease } from "./types.ts";

export type PendingSteering = { id: string; text: string; scope?: string };
export interface PendingSteeringStore {
  pendingSteering(sessionId: string): Promise<PendingSteering[]>;
  insertPendingSteering(
    sessionId: string,
    item: PendingSteering,
  ): Promise<void>;
  updatePendingSteering(
    sessionId: string,
    id: string,
    text: string,
  ): Promise<void>;
  prioritizePendingSteering(sessionId: string, id: string): Promise<void>;
  takePendingSteering(sessionId: string, id: string): Promise<boolean>;
  consumePendingSteering(
    sessionId: string,
    id: string,
    lease: SessionLease,
  ): Promise<AgentEvent | undefined>;
}
type Item = PendingSteering & {
  /** Live-run guard only; persisted entries always require explicit recovery. */
  expectedRunId?: string;
  recovered: boolean;
  blocked?: boolean;
  error?: string;
};
const validText = (text: string) => {
  if (!text.trim()) throw Error("Steering message cannot be empty");
  if (text.length > 100000) throw Error("Steering message is too long");
};

/** Mutations run on Agent's queue serializer; block() is synchronous on cancel. */
export class SteeringQueue {
  private items: Item[] = [];
  constructor(
    private sessionId: string,
    private store?: PendingSteeringStore,
  ) {}
  get ready() {
    return this.items.some((item) => !item.recovered && !item.blocked);
  }
  pending() {
    return this.items.map(({ id, text, recovered, blocked, error }) => ({
      id,
      text,
      recovered: recovered || !!blocked,
      error,
    }));
  }
  private item(id: string) {
    const item = this.items.find((item) => item.id === id);
    if (!item)
      throw Error("Steering message is no longer pending; refresh the list.");
    return item;
  }
  async restore() {
    for (const item of (await this.store?.pendingSteering(this.sessionId)) ??
      [])
      if (!this.items.some((existing) => existing.id === item.id))
        this.items.push({ ...item, recovered: true });
  }
  async add(text: string, scope?: string, expectedRunId?: string) {
    validText(text);
    if (this.items.length >= 16) throw Error("Steering queue is full");
    const item = {
      id: randomUUID(),
      text,
      scope,
      expectedRunId,
      recovered: false,
    };
    await this.store?.insertPendingSteering(this.sessionId, item);
    this.items.push(item);
    return item.id;
  }
  async update(id: string, text: string) {
    const item = this.item(id);
    validText(text);
    await this.store?.updatePendingSteering(this.sessionId, id, text);
    item.text = text;
  }
  async prioritize(id: string) {
    const item = this.item(id);
    await this.store?.prioritizePendingSteering(this.sessionId, id);
    this.items.splice(this.items.indexOf(item), 1);
    this.items.unshift(item);
  }
  async remove(id: string) {
    const item = this.item(id);
    await this.store?.takePendingSteering(this.sessionId, id);
    this.items.splice(this.items.indexOf(item), 1);
  }
  resume(id: string, scope?: string) {
    const item = this.item(id);
    if (item.scope !== scope)
      throw Error("Restore from the original client identity");
    if (item.blocked) throw Error("Steering cancellation is still pending");
    if (!item.recovered) throw Error("Steering message is already queued");
    // Explicit recovery is a fresh instruction, not continuation of its old run.
    item.expectedRunId = undefined;
    item.recovered = false;
    item.error = undefined;
  }
  block(matches: (item: Item) => boolean) {
    for (const item of this.items) if (matches(item)) item.blocked = true;
  }
  expireRun(runId: string) {
    for (const item of this.items) {
      if (item.expectedRunId !== runId) continue;
      item.recovered = true;
      item.error =
        "Target run ended before this intervention was applied. Review it before sending again.";
    }
  }
  async discard(matches: (item: Item) => boolean) {
    const failures: string[] = [];
    for (const item of [...this.items]) {
      if (!matches(item)) continue;
      item.blocked = true;
      try {
        await this.remove(item.id);
      } catch (error) {
        item.recovered = true;
        item.blocked = false;
        item.error = `Cancellation was not saved: ${String(error)}. Confirm again or remove this message.`;
        failures.push(item.error);
      }
    }
    if (failures.length) throw Error(failures.join("\n"));
  }
  async consume(
    lease: SessionLease | undefined,
    publish: (event: AgentEvent) => void,
    append: (text: string) => Promise<unknown>,
  ) {
    const item = this.items.find((item) => !item.recovered && !item.blocked);
    if (!item) return false;
    try {
      if (this.store) {
        if (!lease) throw Error("Session lease required to consume steering");
        const event = await this.store.consumePendingSteering(
          this.sessionId,
          item.id,
          lease,
        );
        if (!event) {
          this.items.splice(this.items.indexOf(item), 1);
          throw Error(
            "Steering was claimed or removed elsewhere; it will not be replayed",
          );
        }
        publish(event);
      } else await append(item.text);
      this.items.splice(this.items.indexOf(item), 1);
      return true;
    } catch (error) {
      item.recovered = true;
      item.error = `Could not apply steering: ${String(error)}`;
      throw error;
    }
  }
}
