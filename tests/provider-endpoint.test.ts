import { afterEach, expect, it, vi } from "vitest";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createPiProvider } from "../packages/provider-pi/src/index.ts";
import {
  endpointCredentialId,
  normalizeEndpointUrl,
  saveEndpointApiKey,
} from "../packages/provider-pi/src/endpoint.ts";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
async function endpoint() {
  const requests: IncomingHttpHeaders[] = [];
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    requests.push(req.headers);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `data: ${JSON.stringify({
        id: "endpoint-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "test",
        choices: [
          { index: 0, delta: { content: "OK" }, finish_reason: "stop" },
        ],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing port");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, bodies };
}
async function request(options: Parameters<typeof createPiProvider>[0]) {
  const provider = await createPiProvider(options);
  const events = [];
  for await (const event of provider.stream({
    system: "test",
    messages: [{ role: "user", text: "Hi", timestamp: 1 }],
    tools: [],
    signal: AbortSignal.timeout(5000),
  }))
    events.push(event);
  expect(events.some((event) => event.type === "done")).toBe(true);
}

it("uses the saved API key bound to the exact compatible endpoint", async () => {
  const target = await endpoint();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(endpointCredentialId(target.baseUrl), async () => ({
    type: "api_key",
    key: "endpoint-test-key",
  }));
  await request({ provider: "openai", model: "test", ...target, credentials });
  expect(target.requests[0]?.authorization).toBe("Bearer endpoint-test-key");
});

it("sends image bytes to a compatible endpoint without dropping unknown-model image input", async () => {
  const target = await endpoint();
  const provider = await createPiProvider({
    provider: "local",
    model: "vision-fixture",
    ...target,
  });
  const image = {
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1sAAAAASUVORK5CYII=",
  };
  const events = [];
  for await (const event of provider.stream({
    system: "test",
    tools: [],
    signal: AbortSignal.timeout(5000),
    messages: [
      {
        role: "user",
        text: "Describe the attached screenshot",
        images: [image],
        timestamp: 1,
      },
    ],
  }))
    events.push(event);
  expect(provider.supportsImages).toBeUndefined();
  expect(events.some((event) => event.type === "done")).toBe(true);
  expect(
    target.bodies[0].messages.find(
      (message: { role: string }) => message.role === "user",
    ).content,
  ).toEqual([
    { type: "text", text: "Describe the attached screenshot" },
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${image.data}` },
    },
  ]);
});

it("never forwards provider or other endpoint credentials to a custom URL", async () => {
  const target = await endpoint();
  const credentials = new InMemoryCredentialStore();
  vi.stubEnv("OPENAI_API_KEY", "provider-env-test-key");
  await credentials.modify("openai", async () => ({
    type: "api_key",
    key: "provider-saved-test-key",
  }));
  await credentials.modify(
    endpointCredentialId(target.baseUrl + "/other"),
    async () => ({
      type: "api_key",
      key: "other-endpoint-test-key",
    }),
  );
  await request({ provider: "openai", model: "test", ...target, credentials });
  expect(target.requests[0]?.authorization).toBeUndefined();
});

it("allows an explicit endpoint key to override its saved credential", async () => {
  const target = await endpoint();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(endpointCredentialId(target.baseUrl), async () => ({
    type: "api_key",
    key: "saved-test-key",
  }));
  await request({
    provider: "local",
    model: "test",
    ...target,
    credentials,
    apiKey: "explicit-test-key",
  });
  expect(target.requests[0]?.authorization).toBe("Bearer explicit-test-key");
});

it("canonicalizes the configured URL when saving and using its key", async () => {
  const target = await endpoint();
  const credentials = new InMemoryCredentialStore();
  await saveEndpointApiKey(credentials, target.baseUrl + "/", "saved-test-key");
  await request({ provider: "local", model: "test", ...target, credentials });
  expect(target.requests[0]?.authorization).toBe("Bearer saved-test-key");
  expect(await credentials.list()).toEqual([
    { providerId: endpointCredentialId(target.baseUrl), type: "api_key" },
  ]);
  expect(normalizeEndpointUrl("HTTPS://EXAMPLE.COM:443/v1///")).toBe(
    "https://example.com/v1",
  );
});

it("keeps the shared catalog's provider auth out of the custom endpoint", async () => {
  const target = await endpoint();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({
    type: "api_key",
    key: "production-test-key",
  }));
  const collection = builtinModels({ credentials });
  await request({
    provider: "openai",
    model: "test",
    ...target,
    collection,
  });
  expect(target.requests[0]?.authorization).toBeUndefined();
  expect(await collection.getAuth("openai")).toMatchObject({
    auth: { apiKey: "production-test-key" },
  });
});

it("fails closed when the endpoint credential store cannot be read", async () => {
  const target = await endpoint();
  const credentials = new InMemoryCredentialStore();
  vi.spyOn(credentials, "read").mockRejectedValue(Error("Keychain denied"));
  await expect(
    request({ provider: "local", model: "test", ...target, credentials }),
  ).rejects.toThrow("API key auth failed for provider local");
  expect(target.requests).toHaveLength(0);
});

it("does not reuse an OAuth credential as a compatible endpoint API key", async () => {
  const target = await endpoint();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(endpointCredentialId(target.baseUrl), async () => ({
    type: "oauth",
    access: "oauth-test-access",
    refresh: "oauth-test-refresh",
    expires: Date.now() + 3600000,
  }));
  await expect(
    request({ provider: "local", model: "test", ...target, credentials }),
  ).rejects.toThrow("API key auth failed for provider local");
  expect(target.requests).toHaveLength(0);
});

it.each([
  "file:///tmp/api",
  "https://user:secret@example.com/v1",
  "https://example.com/v1?token=secret",
  "https://example.com/v1#secret",
])(
  "rejects ambiguous or credential-bearing endpoint URLs: %s",
  async (baseUrl) => {
    const credentials = new InMemoryCredentialStore();
    await expect(
      saveEndpointApiKey(credentials, baseUrl, "test-key"),
    ).rejects.toThrow();
    expect(await credentials.list()).toEqual([]);
  },
);

it.each(["", "   ", "key\nheader", "key\rheader"])(
  "rejects an empty or invalid endpoint API key",
  async (key) => {
    const credentials = new InMemoryCredentialStore();
    await expect(
      saveEndpointApiKey(credentials, "https://example.com/v1", key),
    ).rejects.toThrow("Endpoint API key");
    expect(await credentials.list()).toEqual([]);
  },
);
