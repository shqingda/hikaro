# Current scope

TUI and bidirectional Pi integration are active. Portable client state, durable host receipts and an encrypted remote adapter support the confirmed mobile companion direction. The native mobile app, TUI attachment to the same host and device lifecycle acceptance remain pending. See the [TUI/mobile plan](tui-mobile-direction.md). Cloud deployment remains optional. [TODO.md](../TODO.md) is the current implementation ledger.

# Implementation and design review

## Boundaries

- `core`: independent loop, tool broker, event/state contracts, task graph, shared budgets.
- `storage`: SQLite WAL in a worker; atomic session leases, ordered events, message pages, jobs, optional index.
- `provider-pi`: Pi AI provider normalization only. SDKs load when needed.
- `tools`: coding, sandboxed shell/PTY, worker-isolated QuickJS, MCP, LSP, search, optional browser.
- `runtime`: composes the host and official plugins. It does not render UI.
- `protocol`: bounded JSONL, stable command IDs, independent client scopes, public projections.
- `tui`: renders execution state and handles terminal interaction.
- `pi-bridge`: external Pi adapter and an interactive Pi extension. Neither is required by the native core.
- `crypto`, `remote`, Cloudflare relay: remote transport, enrollment and revocation.

## Defects corrected during review

| Initial defect                                             | Change                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| QuickJS ran on the host event loop                         | Separate worker, memory budget, shared interrupt flag, tool calls through the host broker |
| Opening history loaded large transcripts                   | Cursor-based pages; bounded visible windows and streaming previews                        |
| Each remote device could create a separate execution owner | One host RPC process with independent authenticated device scopes                         |
| Pi completion used incomplete lifecycle assumptions        | `agent_settled`, handled prompts, UI response protocol and cancellation ordering          |
| Shared jobs could execute from the wrong workspace         | Workspace-filtered job claims and execution leases                                        |

## Execution and resource invariants

Official file tools use `tools/workspace.ts` for canonical paths, resource-based approval and file updates. Search enumerates filenames before authorizing and scanning contents. Indexing excludes sensitive resources, and retrieval rechecks paths against the same sensitive-path rule. Process execution lives in `tools/process.ts`; Git queries use the sandbox and a minimal environment, ignore global/system Git config, disable fsmonitor/hooks and external diff/text conversion, and ignore submodules. These flags reduce executable extensions; the sandbox remains the process boundary. Git documents [fsmonitor](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsmonitor) and [hook disabling](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corehooksPath).

In-process file updates share a canonical-path queue. Independent Hikaro writers coordinate through an exclusive adjacent lock with no automatic expiry; content goes through a same-directory temporary file and atomic replacement. Existing replacements still require expected content or an unambiguous current match. This coordinates cooperating file tools, not arbitrary editors or already-running shell commands. File locks are deliberately retained after a crash for inspection rather than stolen from a paused process.

Authorized content IO uses `tools/native/secure-file.c`, through `tools/secure-files.ts`. TypeScript first resolves static symlinks and obtains any required approval. The helper then opens each canonical path component relative to an already opened directory with `openat(O_DIRECTORY | O_NOFOLLOW)`. The final regular file is opened with `O_NOFOLLOW | O_NONBLOCK` and read from that descriptor. It never returns a checked pathname for a later host read. Subsequent symbolic-link replacements therefore cause refusal, or the operation remains on the originally opened resource; they cannot redirect the operation to an outside target.

For updates, one helper process retains the parent directory descriptor and exclusive lock across the entire exchange: current snapshot, replacement bytes, staged temporary file, TypeScript lease/cancellation checkpoint, and commit. Creation uses `linkat()` without replacement; existing files use `renameat()`. Version checks, lock/temporary-file creation and cleanup all use the pinned directory descriptor. Normal errors, aborted checkpoints and protocol EOF/SIGTERM clean up through the same descriptor, even when the original parent name has been replaced. Uncooperative same-file writers can still race a version check; this is not a filesystem transaction against arbitrary programs.

Read-file tools, workspace instructions/skill metadata and index reads use the helper. Text search feeds protected byte snapshots to ripgrep over stdin and prefixes its line results with the authorized path. Filename enumeration and ignore-rule handling still use ripgrep; they are not a general isolation boundary. The content/commit protection does not depend on ripgrep traversal or on a second `realpath()` check. The helper accepts bounded frames and ordinary files only, with 2 MB direct reads, 256 kB index reads and 16 MiB search/update snapshots.

The helper is compiled during source installation/build and copied beside the bundled CLI, with no runtime compilation or unsafe fallback. It uses POSIX operations shared by macOS and Linux, with platform-specific timestamp fields. A missing helper, unsupported platform or failed compiler stops the protected operation. Third-party plugins and executable application installations remain trusted code.

Runtime reserves child concurrency before initialization, counts busy agents after startup, and releases reservations on every exit. Parent/job signals are checked after initialization and bound throughout execution. Agent initialization is shared per session. Changing permissions or a session's model/deletion is blocked during initialization. The limit is local to a Runtime; provider factory initialization is not interruptible, but a cancelled or closed Runtime cannot start the resulting Agent. Close waits up to five seconds before releasing resources.

Session execution holds a fencing token `{owner, epoch}`. SQLite acquires or renews the lease under a write transaction, and event append verifies the current token and expiry in the same transaction as the insert. Release retains the epoch; expired holders cannot renew themselves. Agent checks ownership before model/tool execution and on both sides of approval, and before committing file updates after asynchronous waits, aborting when ownership is lost. Fencing protects persisted events. Already-started filesystem/process effects still depend on cancellation cooperation and cannot be rolled back by SQLite.

RPC protocol v2 accepts `session.compact` immediately with `{accepted: true, operationId}`. The scope receives `operation.completed` with the continuation session or `operation.failed` with an error. Clients must handle the completion notification instead of treating the command response as a Session. Ordinary requests queue per scope; cancellation, steering, approval replies, detach and current-state queries bypass that queue. Pending requests are bounded to 32 / 1 MiB per scope and 128 / 2 MiB overall, with eight pending compactions per scope. Agent busy state and session leases reject conflicting execution on the same session. Compact results do not overwrite a newer session selection.

Remote disconnect retains execution for reconnection. Device revocation detaches and cancels every still-active operation owned by that device scope, including sessions it no longer has selected and work retained after a disconnect. Merely viewing another scope's session does not transfer ownership. Third-party in-process plugins remain trusted code; these TypeScript services do not sandbox them.

Context history reports storage omissions and preserves full user turns before model context fitting. Usage and cost/model-call budgets are Agent-lifetime values shared with child agents; they are not restored from session events. Restarting the host or rebuilding an Agent resets the budget. Continuation creation after compaction is still a sequence of storage operations, not a single transaction.

Context fitting accounts for system instructions, current tool definitions, normalized or provider-native message payloads, image allowances, omission notices, output reserve and a 5% safety margin. ASCII letter/digit runs use a conservative three-characters-per-token heuristic; other characters use UTF-8 byte cost, with message-envelope overhead and a fixed image allowance. This is explicitly an estimate, not a tokenizer guarantee. The Pi adapter exposes the same output ceiling it passes to the SDK. An oversized latest turn fails before dispatch; the shared model-call budget is rechecked and decremented together after asynchronous lease/history checks. Manual summary inputs include tool arguments and source event sequence numbers and respect bounded request chunks. Original event history remains authoritative.

TUI draft saving coalesces input on a 300 ms timer, serializes writes, and flushes before submission/session changes/exit. Text is owned by the session whose editor is bound, even while a new Agent initializes. Same-session settings/model rebinds preserve live input; different-session binds restore the destination after flushing the outgoing draft. Completed saves survive process crashes, but the last timer/write window and queued prompts remain outside that guarantee. Session search executes in the SQLite worker over workspace-scoped title/ID matches, uses bounded result pages, and preserves Unicode lowercase matching. It does not search message bodies or change RPC v2 capabilities.

## Interface rules

Use the existing brand colors, a single conversation column, and details on demand. Status changes appear immediately. There are no decorative infinite animations. Terminal rendering only requests frames when content/input changes.

Keep completed Markdown components stable while text streams. Preserve the user's scroll position when reading older content. Show when a preview/page is bounded; retain the authoritative history in storage. Do not send provider-native payloads or image bytes in every UI event.
