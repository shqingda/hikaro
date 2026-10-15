import { it, expect, vi } from "vitest";
import { createServer } from "node:http";
import { createPiProvider } from "../packages/provider-pi/src/index.ts";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

it("maps reasoning off to the simple adapter's disabled value", async () => {
  const collection = builtinModels();
  const model = collection.getModels().find((model) => !model.reasoning)!;
  const stream = vi.spyOn(collection, "streamSimple").mockImplementation(() => {
    throw Error("Stopped before network access");
  });
  const provider = await createPiProvider({
    provider: model.provider,
    model: model.id,
    collection,
    settings: { reasoning: "off" },
  });
  const events = provider.stream({
    system: "test",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
  });
  await expect(events[Symbol.asyncIterator]().next()).rejects.toThrow(
    "Stopped before network access",
  );
  expect(stream.mock.calls[0]![2]?.reasoning).toBeUndefined();
});
it("streams through the real Pi OpenAI-compatible adapter without an agent loop dependency", async () => {
  let request: any;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    request = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "local-test",
    };
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello " }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "你好" }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as any).port;
    const provider = await createPiProvider({
      provider: "local",
      model: "local-test",
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    const events = [];
    for await (const event of provider.stream({
      system: "test",
      messages: [{ role: "user", text: "Hi", timestamp: 1 }],
      tools: [],
      signal: AbortSignal.timeout(5000),
    }))
      events.push(event);
    expect(request.model).toBe("local-test");
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.text)
        .join(""),
    ).toBe("Hello 你好");
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.message.text).toBe("Hello 你好");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}, 10000);
