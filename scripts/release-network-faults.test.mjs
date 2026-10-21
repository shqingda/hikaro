import assert from "node:assert/strict";
import { test } from "node:test";
import { faultFetch } from "./release-network-faults.mjs";
const endpoint = "https://api.x.ai/v1/responses";

test("faults affect only the model POST, never credentials or unrelated requests", async () => {
  const sent = [];
  const fetch = faultFetch(
    async (...args) => {
      sent.push(args);
      return new Response("forwarded");
    },
    () => {
      throw Error("Must not read fault mode");
    },
    () => {
      throw Error("Must not record auth");
    },
  );
  for (const url of [
    "https://auth.x.ai/oauth2/token",
    "https://api.x.ai/v1/models",
    "https://example.com/v1/responses",
  ])
    assert.equal(
      await (await fetch(url, { method: "POST" })).text(),
      "forwarded",
    );
  assert.equal(await (await fetch(endpoint)).text(), "forwarded");
  assert.equal(sent.length, 4);
});

test("offline and 429 faults do not send credentials or payloads over the network", async () => {
  const records = [];
  let mode = "offline";
  const fetch = faultFetch(
    () => {
      throw Error("Unexpected external request");
    },
    () => mode,
    (event) => records.push(event),
  );
  await assert.rejects(
    fetch(endpoint, { method: "POST" }),
    (error) => error.cause.code === "ENETUNREACH",
  );
  mode = "rate-limit";
  const response = await fetch(
    new Request(endpoint, {
      method: "POST",
      headers: { authorization: "private-test-value" },
      body: "private-test-payload",
    }),
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.deepEqual(records, [
    { mode: "offline", event: "request" },
    { mode: "rate-limit", event: "request" },
  ]);
});

test("a hanging request observes cancellation without a network request", async () => {
  const abort = new AbortController();
  const records = [];
  const fetch = faultFetch(
    () => {
      throw Error("Unexpected external request");
    },
    () => "hang",
    (event) => records.push(event),
  );
  const pending = fetch(endpoint, { method: "POST", signal: abort.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  abort.abort();
  await rejected;
  assert.deepEqual(records, [
    { mode: "hang", event: "request" },
    { mode: "hang", event: "aborted" },
  ]);
});

test("disconnect cuts an actual stream after text and cancels its source", async () => {
  let cancelled = false;
  const records = [];
  const data = new TextEncoder().encode(
    'event: response.output_text.delta\ndata: {"delta":"partial"}\n\n',
  );
  const fetch = faultFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(data);
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    () => "disconnect",
    (event) => records.push(event),
  );
  const reader = (await fetch(endpoint, { method: "POST" })).body.getReader();
  assert.deepEqual((await reader.read()).value, data);
  await assert.rejects(reader.read(), /HIKARO_ACCEPTANCE_DISCONNECT/);
  assert.equal(cancelled, true);
  assert.deepEqual(records, [
    { mode: "disconnect", event: "request" },
    { mode: "disconnect", event: "cut-after-text" },
  ]);
});
