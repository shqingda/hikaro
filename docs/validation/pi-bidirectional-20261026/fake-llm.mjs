// OpenAI chat-completions SSE stub. "slow" in the last user message streams 200 chunks at 50 ms.
import { createServer } from "node:http";
export function startFake() {
  const log = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const j = JSON.parse(body || "{}");
    const msgs = j.messages ?? [];
    const users = msgs.filter((m) => m.role === "user");
    const last = users.at(-1);
    const lastText =
      typeof last?.content === "string"
        ? last.content
        : (last?.content ?? []).map((p) => p.text ?? "").join("");
    log.push({ users: users.length, total: msgs.length, lastText });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta, finish = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    send({ role: "assistant", content: "" });
    const slow = lastText.includes("slow");
    const parts = slow
      ? Array.from({ length: 200 }, (_, i) => `w${i} `)
      : [`reply#${users.length} to: ${lastText}`];
    let closed = false;
    req.on("close", () => (closed = true));
    res.on("close", () => (closed = true));
    for (const p of parts) {
      if (closed) return;
      send({ content: p });
      if (slow) await new Promise((r) => setTimeout(r, 50));
    }
    send({}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({ server, port: server.address().port, log }),
    ),
  );
}
