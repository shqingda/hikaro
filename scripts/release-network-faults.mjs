// Test-only transport wrapper. Not imported by the app or included in its package.
export function faultFetch(realFetch, readMode, record) {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = init?.method ?? request?.method ?? "GET";
    // Never intercept token refresh, sign-in or any unrelated endpoint.
    if (
      url.origin !== "https://api.x.ai" ||
      url.pathname !== "/v1/responses" ||
      method.toUpperCase() !== "POST"
    )
      return realFetch(input, init);
    const mode = await readMode();
    if (
      !["online", "offline", "rate-limit", "disconnect", "hang"].includes(mode)
    )
      throw Error("Invalid acceptance fault mode");
    await record({ mode, event: "request" });
    if (mode === "offline")
      throw new TypeError("fetch failed", {
        cause: Object.assign(Error("HIKARO_ACCEPTANCE_OFFLINE"), {
          code: "ENETUNREACH",
        }),
      });
    if (mode === "rate-limit")
      return new Response(
        JSON.stringify({
          error: {
            message: "HIKARO_ACCEPTANCE_RATE_LIMIT",
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "1" },
        },
      );
    if (mode === "hang") {
      const signal = init?.signal ?? request?.signal;
      if (!signal)
        throw Error("Acceptance hanging request must be cancellable");
      await new Promise((_, reject) => {
        const abort = () =>
          reject(new DOMException("Request aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }).catch(async (error) => {
        await record({ mode, event: "aborted" });
        throw error;
      });
    }
    const response = await realFetch(input, init);
    if (mode !== "disconnect" || !response.ok || !response.body)
      return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let tail = "",
      cut = false;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          if (cut) {
            await record({ mode, event: "cut-after-text" });
            controller.error(new TypeError("HIKARO_ACCEPTANCE_DISCONNECT"));
            await reader.cancel();
            return;
          }
          const next = await reader.read();
          if (next.done) return controller.close();
          tail = (tail + decoder.decode(next.value, { stream: true })).slice(
            -65536,
          );
          cut = tail.includes("response.output_text.delta");
          controller.enqueue(next.value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  };
}
