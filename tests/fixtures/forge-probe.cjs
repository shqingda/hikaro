// Diagnostic only: fail on ANY forge API call, including indirect verification.
const Module = require("node:module");
const fs = require("node:fs");
const { createRequire } = Module;
const sandboxRequire = createRequire(
  require.resolve("@anthropic-ai/sandbox-runtime"),
);
const originalForge = sandboxRequire("node-forge");
const evidence = { loaded: false, calls: [] };
const proxies = new WeakMap();
function observe(value, path) {
  if (!value || !["object", "function"].includes(typeof value)) return value;
  if (proxies.has(value)) return proxies.get(value);
  const proxy = new Proxy(value, {
    get(target, key) {
      evidence.loaded = true;
      return observe(Reflect.get(target, key), `${path}.${String(key)}`);
    },
    apply(_target, _self, _args) {
      evidence.calls.push(path);
      throw Error(`Unexpected node-forge API: ${path}`);
    },
    construct() {
      evidence.calls.push(path);
      throw Error(`Unexpected node-forge constructor: ${path}`);
    },
  });
  proxies.set(value, proxy);
  return proxy;
}
// ESM can retain the original CommonJS exports object. Instrument its
// properties in place so both require and import observe the same hooks.
for (const key of Object.keys(originalForge)) {
  originalForge[key] = observe(originalForge[key], `forge.${key}`);
}
process.on("exit", () =>
  fs.writeFileSync(process.env.HIKARO_FORGE_PROBE, JSON.stringify(evidence)),
);
