import { parentPort, workerData } from "node:worker_threads";
import { getQuickJS } from "quickjs-emscripten";
const aborted = new Int32Array(workerData.abortBuffer);
const deadline = Date.now() + workerData.timeoutMs;
const quick = await getQuickJS();
const vm = quick.newContext();
vm.runtime.setMemoryLimit(32 * 1024 * 1024);
vm.runtime.setMaxStackSize(512 * 1024);
vm.runtime.setInterruptHandler(
  () => Date.now() >= deadline || Atomics.load(aborted, 0) !== 0,
);
const pending = new Map();
let id = 0;
let output = [];
let outputBytes = 0;
let root;
const print = vm.newFunction("print", (...args) => {
  const line = args.map((a) => JSON.stringify(vm.dump(a))).join(" ");
  outputBytes += Buffer.byteLength(line);
  if (outputBytes > 32000) throw Error("Codemode output limit exceeded");
  output.push(line);
});
vm.setProp(vm.global, "print", print);
print.dispose();
const call = vm.newFunction("__call", (name, args) => {
  const tool = vm.getString(name);
  if (tool === "codemode") throw Error("Recursive codemode is disabled");
  if (pending.size >= 8) throw Error("Maximum 8 concurrent tools");
  const raw = vm.getString(args);
  if (Buffer.byteLength(raw) > 100000) throw Error("Tool arguments too large");
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw Error("Tool arguments must be an object");
  const deferred = vm.newPromise();
  const callId = ++id;
  pending.set(callId, deferred);
  parentPort.postMessage({
    type: "invoke",
    id: callId,
    name: tool,
    args: parsed,
  });
  return deferred.handle;
});
vm.setProp(vm.global, "__call", call);
call.dispose();
parentPort.on("message", (message) => {
  if (message.type !== "result") return;
  const deferred = pending.get(message.id);
  if (!deferred) return;
  pending.delete(message.id);
  const handle = message.error
    ? vm.newError(message.error)
    : vm.newString(JSON.stringify(message.result));
  try {
    message.error ? deferred.reject(handle) : deferred.resolve(handle);
  } finally {
    handle.dispose();
    deferred.dispose();
  }
});
try {
  const evaluated = vm.evalCode(
    `globalThis.tools = new Proxy({}, {get: (_, name) => async args => JSON.parse(await __call(String(name), JSON.stringify(args ?? {})))}); (async () => {${workerData.code}\n})()`,
    "codemode.js",
  );
  if (evaluated.error) {
    const error = vm.dump(evaluated.error);
    evaluated.error.dispose();
    throw Error(JSON.stringify(error));
  }
  root = evaluated.value;
  let settled = false;
  let failure;
  void vm.resolvePromise(root).then((result) => {
    settled = true;
    if (result.error) {
      failure = vm.dump(result.error);
      result.error.dispose();
    } else result.value.dispose();
  });
  while (!settled) {
    if (Date.now() >= deadline || Atomics.load(aborted, 0) !== 0)
      throw Error("Codemode cancelled or timed out");
    const jobs = vm.runtime.executePendingJobs();
    if (jobs.error) {
      const error = vm.dump(jobs.error);
      jobs.error.dispose();
      throw Error(JSON.stringify(error));
    }
    if (!settled)
      await new Promise((resolve) => setTimeout(resolve, pending.size ? 4 : 1));
  }
  if (failure) throw Error(JSON.stringify(failure));
  if (pending.size)
    throw Error(
      "Unawaited tool calls: await all tool calls before the script completes",
    );
  parentPort.postMessage({
    type: "done",
    result: { text: output.join("\n") || "(No printed output)" },
  });
} catch (error) {
  parentPort.postMessage({
    type: "done",
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  root?.dispose();
  for (const deferred of pending.values()) deferred.dispose();
  pending.clear();
  vm.dispose();
  parentPort.close();
}
