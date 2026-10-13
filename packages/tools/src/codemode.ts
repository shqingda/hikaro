import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { Plugin, ToolResult } from "../../core/src/types.ts";
export function codemodePlugin(options: { timeoutMs?: number } = {}): Plugin {
  return {
    id: "hikaro.codemode",
    apiVersion: 1,
    setup(host) {
      host.registerTool({
        name: "codemode",
        description:
          "Run isolated JavaScript in a worker to compose tools. await tools.NAME(args) returns a structured result; print(value) emits bounded output. No Node, filesystem, or direct network. Tools use normal permissions. Await every call; failures do not roll back side effects.",
        schema: z.object({ code: z.string().max(32000) }),
        async execute({ code }, ctx) {
          const timeoutMs = options.timeoutMs ?? 30000;
          const abortBuffer = new SharedArrayBuffer(4);
          const abortFlag = new Int32Array(abortBuffer);
          const child = new AbortController();
          const worker = new Worker(
            new URL("./codemode-worker.mjs", import.meta.url),
            {
              workerData: { code, abortBuffer, timeoutMs },
              resourceLimits: { maxOldGenerationSizeMb: 64 },
            },
          );
          let completed = false;
          const tasks = new Set<Promise<void>>();
          try {
            return await new Promise<ToolResult>((resolve, reject) => {
              const finish = (error: unknown, result?: ToolResult) => {
                if (completed) return;
                completed = true;
                clearTimeout(timer);
                ctx.signal.removeEventListener("abort", cancel);
                child.abort();
                Atomics.store(abortFlag, 0, 1);
                error ? reject(error) : resolve(result!);
              };
              const cancel = () => finish(Error("Codemode cancelled"));
              const timer = setTimeout(
                () => finish(Error("Codemode timed out")),
                timeoutMs + 1000,
              );
              ctx.signal.addEventListener("abort", cancel, { once: true });
              if (ctx.signal.aborted) {
                cancel();
                return;
              }
              worker.on("message", (message) => {
                if (completed) return;
                if (message.type === "done") {
                  finish(
                    message.error ? Error(message.error) : undefined,
                    message.result,
                  );
                  return;
                }
                if (
                  message.type !== "invoke" ||
                  typeof message.name !== "string" ||
                  !Number.isSafeInteger(message.id)
                ) {
                  finish(Error("Invalid codemode worker request"));
                  return;
                }
                const task = ctx
                  .invoke(message.name, message.args, child.signal)
                  .then(
                    (result) => {
                      if (!completed) {
                        const bounded = JSON.stringify(result);
                        worker.postMessage(
                          bounded.length > 250000
                            ? {
                                type: "result",
                                id: message.id,
                                error:
                                  "Tool result exceeds codemode transfer limit; inspect its artifact instead.",
                              }
                            : { type: "result", id: message.id, result },
                        );
                      }
                    },
                    (error) => {
                      if (!completed)
                        worker.postMessage({
                          type: "result",
                          id: message.id,
                          error: String(error),
                        });
                    },
                  )
                  .finally(() => tasks.delete(task));
                tasks.add(task);
              });
              worker.once("error", (error) => finish(error));
              worker.once("exit", (code) => {
                if (!completed)
                  finish(Error(`Codemode worker exited (${code})`));
              });
            });
          } finally {
            child.abort();
            Atomics.store(abortFlag, 0, 1);
            await worker.terminate();
            await Promise.race([
              Promise.allSettled(tasks),
              new Promise((resolve) => {
                const timer = setTimeout(resolve, 500);
                timer.unref();
              }),
            ]);
          }
        },
      });
    },
  };
}
