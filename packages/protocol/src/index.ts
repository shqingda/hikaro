import * as z from "zod";
import type { AgentEvent, Message } from "../../core/src/types.ts";
import { rpcMethods } from "./contracts.ts";
export { protocolVersion } from "./contracts.ts";
export type AcceptedOperation = { accepted: true; operationId: string };
export type OperationEvent = {
  scope: string;
  operationId: string;
  method: "session.compact";
} & (
  | {
      type: "operation.completed";
      result: import("../../core/src/types.ts").Session;
    }
  | { type: "operation.failed"; error: string }
);
export const isControlMethod = (method: string) =>
  [
    "hello",
    "command.receipt",
    "cancel",
    "approval.respond",
    "client.detach",
    "session.current",
    "steer",
  ].includes(method);
export const Command = z.object({
  id: z.string().min(1).max(128),
  scope: z.string().min(1).max(80).optional(),
  method: z.enum(rpcMethods),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type Command = z.infer<typeof Command>;
/** Provider-native signatures and image bytes belong to storage/provider layers, not every UI frame. */
export function publicMessage(
  message: Message,
): Message & { imageCount?: number } {
  const { providerData, images, ...rest } = message;
  return { ...rest, ...(images?.length ? { imageCount: images.length } : {}) };
}
export function publicEvent(event: AgentEvent): AgentEvent {
  if (event.type === "message")
    return {
      ...event,
      data: {
        ...event.data,
        message: publicMessage(event.data.message as Message),
      },
    };
  if (event.type === "tool.start") {
    const raw = JSON.stringify(event.data.arguments);
    if (raw.length > 12000)
      return {
        ...event,
        data: {
          ...event.data,
          arguments: { preview: raw.slice(0, 12000) },
          argumentsTruncated: true,
        },
      };
  }
  if (event.type === "tool.end") {
    const result = event.data.result as any;
    return {
      ...event,
      data: {
        ...event.data,
        result: {
          text: result.text,
          isError: result.isError,
          data: result.data?.artifact
            ? { artifact: result.data.artifact }
            : undefined,
          imageCount: result.images?.length ?? 0,
        },
      },
    };
  }
  return event;
}
/** LF is the sole framing delimiter; U+2028 and U+2029 remain ordinary JSON characters. */
export class JsonLines {
  private buffer = "";
  private decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(
    private receive: (message: unknown) => void,
    readonly maxBytes = 1_048_576,
  ) {}
  push(chunk: Uint8Array) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line) > this.maxBytes)
        throw Error("Protocol frame too large");
      if (line) this.receive(JSON.parse(line));
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes)
      throw Error("Protocol frame too large");
  }
}
