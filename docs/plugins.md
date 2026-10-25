# Plugin API v1

A plugin exports a `Plugin` object. Plugins run in the host process and must be trusted. Tool code uses the same broker as built-in tools; plugins themselves are not an OS isolation boundary.

```ts
import { z } from "zod";
import type { Plugin } from "../packages/core/src/types.ts";

export default {
  id: "example",
  apiVersion: 1,
  setup(host) {
    host.registerTool({
      name: "greet",
      description: "Return a greeting.",
      schema: z.object({ name: z.string() }),
      async execute({ name }, context) {
        context.signal.throwIfAborted();
        return { text: `Hello, ${name}` };
      },
    });
    host.registerCommand("hello", async () => "Hello");
    host.registerView("status", async () => "Ready");
    host.onEvent((event) => {
      /* observe; never write protocol data to stdout */
    });
    return async () => {
      /* close owned resources */
    };
  },
} satisfies Plugin;
```

Enable only in the user's config:

```json
{ "plugins": [{ "path": "/absolute/path/plugin.ts", "trusted": true }] }
```

Registrations roll back when setup throws. Async tool failures become tool error results. Event observers cannot throw through the agent loop. Native crashes and arbitrary plugin side effects cannot be isolated inside one process.

Use `host.registerTools(tools)` for a discovered batch. It checks every name before registering any tool. A conflict with an existing tool or within the batch leaves the registry unchanged. `registerTool(tool)` remains available for single tools. MCP collects and validates all discovery pages before submitting its batch, so a failed connection can be retried without leftover tools.

`host.unregisterTools(names)` removes tools registered by that plugin's setup instance, including later dynamic registrations. The whole list must be owned by that instance; foreign names reject the operation before anything is removed. A tool replaced outside that instance is left intact. MCP uses this for disconnect and atomic discovery refresh, and refuses refresh or connection changes while a tool call is active.

Provider factories use `registerProvider(id, async () => adapter)`. Adapters stream normalized text and one final message. They do not control the execution loop. Tool parameters must validate before side effects. `context.invoke()` composes tools with inherited permissions, cancellation, shared budgets, and parent call IDs.

Text views are currently exposed as TUI commands. A native arbitrary-component UI plugin ABI is intentionally not exposed to all clients.

## Cooperative command and view cancellation

Commands receive `(args, context)` and views receive `(context)`. Existing callbacks that ignore the extra argument remain compatible with API v1. `context` contains `invocationId`, `sessionId`, `cwd`, `signal`, and asynchronous `checkpoint()` (cancellation and lease validation). Check it before side effects and after waits. Plugin tools retain their existing `ToolContext.signal`.

The TUI shows each invocation ID. Ctrl+C in a running plugin panel requests cancellation; Esc only closes the view. `/plugin-stop ID` requests cancellation after closing the panel. Attached clients use `plugins.cancel` with the selected session and invocation ID; only the initiating local scope can cancel it. Cancellation is a durable control request, never an automatic replay. The execution lease remains held until the callback settles. Ignoring the signal does not produce a stopped result. A cancelled callback's late return value is not saved as a successful result. Runtime shutdown requests cancellation but cannot forcibly isolate trusted in-process code.

After the callback and final checkpoint finish, the invocation enters `committing`. New cancellation requests are rejected while its result is being saved; shutdown lets this commit settle. A cancellation acknowledged before that boundary still holds the lease and records cancellation, never successful completion.
