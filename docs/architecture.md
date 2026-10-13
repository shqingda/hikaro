# Current scope

TUI and bidirectional Pi integration are active. Electron and Expo delivery plans are withdrawn; their experimental code is retained. Cloud configuration is an optional direction with scope pending. [TODO.md](../TODO.md) is the current implementation ledger.

# Implementation and design review

## Boundaries

- `core`: independent loop, tool broker, event/state contracts, task graph, shared budgets.
- `storage`: SQLite WAL in a worker; atomic session leases, ordered events, message pages, jobs, optional index.
- `provider-pi`: Pi AI provider normalization only. SDKs load when needed.
- `tools`: coding, sandboxed shell/PTY, worker-isolated QuickJS, MCP, LSP, search, optional browser.
- `runtime`: composes the host and official plugins. It does not render UI.
- `protocol`: bounded JSONL, stable command IDs, independent client scopes, public projections.
- `tui`, Electron, Expo: render state. Desktop/mobile share a platform-free session controller.
- `pi-bridge`: external Pi adapter and an interactive Pi extension. Neither is required by the native core.
- `crypto`, `remote`, Cloudflare relay: remote transport, enrollment and revocation.

## Defects corrected during review

| Initial defect                                             | Change                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| QuickJS ran on the host event loop                         | Separate worker, memory budget, shared interrupt flag, tool calls through the host broker |
| Opening history loaded large transcripts                   | Cursor-based pages; bounded visible windows and streaming previews                        |
| Client reconnect could duplicate or lose state             | Snapshot cursor + incremental replay + stable command IDs                                 |
| Each remote device could create a separate execution owner | One host RPC process with independent authenticated device scopes                         |
| Closing a desktop window stopped the host                  | Window closes hide it; application quit explicitly shuts down the host                    |
| Pi completion used incomplete lifecycle assumptions        | `agent_settled`, handled prompts, UI response protocol and cancellation ordering          |
| Shared jobs could execute from the wrong workspace         | Workspace-filtered job claims and execution leases                                        |
| PNG white background was visible on UI surfaces            | Separate alpha-transparent UI asset; original icon preserved                              |

## Interface rules

Use the existing red brand mark, system type, a single conversation column, and details on demand. Status changes appear immediately. There are no decorative infinite animations. Reduced-motion and contrast preferences are supported in the desktop theme. Native Expo controls retain platform interaction behavior. Terminal rendering only requests frames when content/input changes.

Keep completed Markdown components stable while text streams. Preserve the user's scroll position when reading older content. Show when a preview/page is bounded; retain the authoritative history in storage. Do not send provider-native payloads or image bytes in every UI event.

The transparent icon was created with the built-in imagegen background-extraction workflow. Prompt: remove only the outer white square, retain the rounded cream tile, red mark and outline; use actual alpha. The project copy is `brand/hikaro-icon-transparent.png`.
