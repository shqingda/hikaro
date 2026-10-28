# hikaro

Independent TypeScript coding agent. Current executable clients: fullscreen TUI and bidirectional Pi integration. See [TODO.md](TODO.md) for implementation and acceptance status. The confirmed direction is [TUI plus a mobile companion](docs/tui-mobile-direction.md): the phone remotely views, approves, supplements and stops work on the computer. The [native M0 companion](docs/mobile.md) now provides pairing, secure credentials and read-only task recovery; physical-device/release acceptance remains pending. Cloud configuration remains optional.

## Run

Install the macOS Apple Silicon CLI (bundles its own Node.js runtime):

```sh
curl -fsSL https://github.com/shqingda/hikaro/releases/latest/download/install.sh | sh
```

Run `hikaro` or `hk`; update with `hikaro update`. Details: [TUI installation guide](docs/install-release.md).

Building from source requires **Node 26.12.1+**, **pnpm 12.14.0**, and `rg`. macOS is the initial supported host.

Installing or building from source also requires a C11 compiler: Xcode Command Line Tools on macOS, or `build-essential` on Linux. Installation and build compile the small file-operation helper; the built CLI includes that executable. After pulling native helper changes, run `pnpm build` or `pnpm install` before using either `pnpm dev` or `pnpm start`. File tools refuse to run if it is unavailable.

```sh
pnpm install
pnpm build
pnpm start --demo
```

Interactive `--demo` starts a fresh offline session unless an offline session is explicitly selected; it cannot restore a live-model session implicitly. The demo model never calls tools. An explicit `!COMMAND` still runs a real sandboxed command under the normal permission policy.

For a real model, start the TUI and enter `/login`. For an xAI subscription, choose **xAI → Sign in with SuperGrok or X Premium**. Existing subscribers can use their saved login directly; no API key is required:

```sh
pnpm start --provider xai --model grok-4.7
```

`--models` lists the installed Pi AI catalog. `--base-url` supports OpenAI-compatible local or hosted servers. Provider credentials stay in the host process. Browsing `/model` lists built-in and cached models without reading Keychain; saved-provider status comes from metadata, not credential validation. Credentials are read when using a provider or explicitly connecting/refreshing it. Interactive provider sign-in saves credentials in Keychain; only provider/type metadata is written to `auth-index.json`. Enter saves the model with the active session. Ctrl+S also saves the default for new sessions. `/context`, `/thinking`, and `/speed` separate **active** and **default**: Enter applies the chosen value immediately; Ctrl+S also saves the default. Add `default` to edit only defaults for new sessions. `/settings` saves display, completion bell and startup preferences immediately. Plain `pnpm start` restores the last opened session in this workspace, including its model settings. Use `/new` or `pnpm start --new` for a new session. `--session ID` selects a specific session. No task is automatically replayed.

```sh
pnpm start --provider local --model your-model --base-url http://localhost:11434/v1
pnpm start --trust                         # permit workspace file edits
pnpm start -p 'Explain this project'       # noninteractive; approvals denied
pnpm start --rpc                          # versioned JSONL client protocol
```

Native TUI permissions default to **Ask for approval**: workspace file edits and sandboxed commands are allowed; external file access, unrestricted commands, MCP and browser actions ask for approval. `/permissions` selects **Ask for approval**, **Approve for me**, or **Full Access**, and saves the choice for the current canonical workspace in `~/.hikaro/permissions.json` (or the selected home). Enter applies it immediately while agents are idle. `/permissions ask`, `/permissions auto`, and `/permissions full` select a mode directly.

**Approve for me** uses conservative local rules, with no extra model request. Ordinary workspace file operations and literal directory commands can pass automatically. File reads and text searches share per-resource authorization, including canonical paths; sensitive resources require approval before content is scanned. Shell content scans and Git queries ask because they can read multiple sensitive files. The optional index excludes sensitive paths and rechecks cached hits. Git control files require approval even in Ask mode; Git queries always use the workspace sandbox with execution hooks disabled. Commands remain in the macOS workspace sandbox with no network. **Full Access** permits external file tools and runs shell/PTY commands on the host with network access, without approval. Existing processes retain the access they had when started.

When approval is needed, a panel above the editor shows the tool, target or command, and reason. Use ↑/↓ to choose **Allow once** or **Deny**, then Enter; Esc or Ctrl+C denies. PgUp/PgDn scroll long details. Your draft stays intact. If the window cannot show the controls and details, resize it before allowing. Ordinary workspace files such as `README.md` do not require manual approval in **Approve for me**; a guessed path outside the workspace still does.

Noninteractive/RPC hosts keep the existing `--trust` and per-operation approval behavior; they do not inherit the TUI's saved mode. Third-party in-process plugins are trusted code. The external Pi backend owns its own permissions; Hikaro's selector cannot change those.

The current permission mode stays visible independently of the usage footer. Short menus use arrow keys without a search field; model, provider and session lists retain search. Settings keep the selected row after each save.

Ctrl+S appears only on actual model choices and active model-setting values. Provider/authentication steps and default-only settings use Enter. Narrow panels wrap values and descriptions, keep the selected choice and reserve Enter/Esc hints. If the available space cannot show the selected content, the panel asks you to resize. Real PTY acceptance at 36×18, 60×18 and 100×24 covers keyboard navigation, resizing, cancellation, draft retention and status feedback. See [validation evidence](docs/validation.md). macOS Terminal appearance, IME and assistive-technology acceptance remain pending.

File candidates use the required `rg` executable and respect ignore rules. Type `@rdme` for fuzzy matches or `@docs/` to narrow the directory; paths containing spaces are quoted automatically. Search is asynchronous and cancellable, capped at 20,000 file paths / 4 MiB of listing output and 20 displayed candidates; narrow the directory in very large workspaces. File contents and permission checks are handled only when submitting. `pnpm dev` runs source directly; after pulling changes, use `pnpm build` before `pnpm start`.

## Terminal controls

| Command | Action |
| --- | --- |
| `/new`, `/sessions [QUERY]`, `/resume [ID]` | Session picker searches titles and IDs across the current workspace, with bounded result pages; Delete/Ctrl+D opens confirmation; Enter deletes, Esc cancels |
| `/rename TITLE` | Rename the current session; Ctrl+R renames a selected session in `/sessions` |
| `/export` | Export all saved text messages as Markdown; hidden thinking stays excluded |
| `/skill:NAME [TASK]` | Invoke a discovered Skill; Skill and plugin commands appear in completion |
| `/fork`, `/compact` | Branch history or create a continuation summary |
| `/attach PATH`, `@file`, `@"path with spaces"` | Attach UTF-8 files or PNG/JPEG/GIF/WebP images; `@` opens fuzzy file search, ↑/↓ selects, Tab/Enter completes, Esc closes |
| `/model`, `/login` | Search models or connect a provider |
| `/settings` | Tool details, thinking visibility, usage footer, completion bell and startup behavior |
| `/permissions [ask\|auto\|full]` | Select workspace permissions; Enter applies and saves; Esc closes |
| `/context`, `/thinking`, `/speed` | Choose and apply a model setting immediately; append `default` for new-session defaults |
| `!COMMAND` | Run a terminal command under the current permission mode, without a model request |
| `/resources`, `/status` | Skills/instructions and current session/model usage |
| `/model provider/model` | Switch model directly while idle |
| `/steer text` | Add instructions to the active run |
| `/older`, `/newer`, `/latest` | Page through history |
| `/read NUMBER PART` | Read a long message in bounded sections |
| `/tools` | Toggle tool details |
| `Ctrl+C` | Cancel; exit when idle |
| `Ctrl+D`, `/quit` | Exit |
| `Shift+Enter` | New line |
| `Ctrl+Shift+F` | Search the visible terminal document |

Draft edits are coalesced and scheduled for saving after 300 ms, including during continuous typing. Saves are serialized per TUI instance, flushed on submission/session switches/orderly exit, and restored after a process crash. The last interval plus any pending storage write can still be lost; this is not recovery of in-memory queued prompts or an interrupted model run. Expanded pasted text is saved, while transient extension-dialog answers are excluded. Storage failures appear near the editor. The existing 100,000-character draft limit remains. The last session can be deleted; deleting the current session opens a fresh blank session.

File references are loaded on submission, including `--prompt`. External and sensitive files follow the current permission policy and protected reads. Failed or cancelled preparation keeps the draft. Limits remain eight references, 128 KiB per text file, 256 KiB combined text and 4 MiB combined attachment bytes. Images require explicitly supported provider capabilities. General binary files are saved with the turn for portable `/export`; their bytes never enter model requests or UI snapshots. Attached submissions must also fit the host's 1 MiB frame; oversized input is rejected before sending. Export includes an `.assets` directory and explains unavailable files. macOS clipboard-image capture is available. See the [input contract](docs/specs/prompt-attachments.md).

The editor's top border shows an animated **Working**, **Thinking**, **Running TOOL**, or **Compacting** indicator. It pauses while waiting for approval/input and stops on completion, cancellation, session binding and exit. Thinking status is independent of whether reasoning text is displayed.

Data defaults to `~/.hikaro`; override with `--home` or `HIKARO_HOME`. Sessions are SQLite event streams. Large tool results are saved as artifacts. Process logs have a 50 MiB cap, reported when reached.

Custom `--base-url` endpoints use credentials bound to their normalized URL, separately from built-in providers. Save a key from an environment variable with `--base-url https://example.com/v1 --endpoint-key-env MY_ENDPOINT_KEY`; subsequent runs using the same home and endpoint reuse it from Keychain. Without an endpoint key, requests are anonymous. Provider keys are never automatically sent to a custom endpoint. URLs must use HTTP(S), without embedded credentials, query parameters or fragments.

Optionally add `--endpoint-capabilities '{"contextWindow":64000,"maxOutputTokens":8192,"images":false,"reasoning":["off","high"]}'` on the host. The declaration belongs to that endpoint and model and is saved with the session or model default. Omitted fields remain unknown: the existing 32,768-token context and 8,192-token output fallbacks apply, and image input is refused until `images:true` is declared. Explicit `images:false` also rejects image input. Reasoning levels declare standard OpenAI `reasoning_effort` values; compatible endpoints expose only the default speed tier. Settings panels label unknown capabilities instead of borrowing capabilities from an identically named built-in model. Changing the endpoint or model does not copy the old declaration.

Official file updates serialize by canonical path, acquire an exclusive `<file>.hikaro-lock`, and replace content atomically. A second process receives a conflict instead of silently overwriting an update. A crash can leave a lock containing the writer PID: inspect the writer and file before manually removing it. Editors, shell commands and third-party plugins do not participate in this lock protocol.

File reads and updates use opened directory handles, rejecting symbolic links introduced after path authorization. Updates, locks and temporary-file cleanup stay attached to the authorized directory even if another process renames it. Search and index retrieval use the same protected file reads; search passes the resulting bytes to ripgrep rather than reopening filenames. Direct reads remain limited to 2 MB, index files to 256 kB, and search/update snapshots to 16 MiB.

Usage and model-call/cost budgets belong to the in-memory Agent and its shared child-agent budget, not to persistent session history. Reconstructing an Agent or restarting the host creates a fresh budget; resuming history does not restore usage limits. Context fitting accounts for system instructions, tool definitions, message payloads, image allowances, output reserve and a safety margin. Its conservative token estimate is not a model tokenizer. At 85% of the available input budget, or before old turns would be omitted, automatic compaction summarizes completed turns into a transactional checkpoint in the same session. Original messages remain available; the current user turn and tool pairs stay exact. Summary requests consume the shared budget, respect cancellation and leases, and must fit before a checkpoint commits. Restart restores the checkpoint. An oversized current turn fails visibly. Manual `/compact` still creates a continuation session. See the [compaction contract](docs/specs/auto-compaction.md).

The client reboot now includes `hello` capability negotiation, a portable `packages/client-core` state layer, run identity snapshots and scoped durable command receipts. `command.receipt` reconciles lost responses; repeated mutation IDs never execute again, and different payloads conflict. Unknown outcomes remain unknown without automatic resend. See the [receipt contract](docs/specs/command-receipts.md) for status and retention boundaries. The shared raw remote adapter and bounded client library APIs are implemented. The opt-in shared host, attached TUI, per-session approval grants and durable local client intents are implemented. Start `pnpm start --host --demo`, then `pnpm start --attach` in another terminal; configured `--serve` attaches the encrypted remote bridge to that same host. Use identical `--cwd` / `--home` values. Ctrl+D detaches the TUI while work continues. See the [shared-host guide](docs/shared-host.md). The [M0 native client](docs/mobile.md) uses this same host. Run `pnpm mobile:ios` once, then `pnpm dev:sim` to reuse the existing iPhone 18 Pro and automatically open the serve-sim browser preview at localhost:3200, without launching DeviceHub or creating another simulator; `pnpm dev:mobile` starts Expo separately. Native-device acceptance remains in the [TUI/mobile plan](docs/tui-mobile-direction.md).

## Pi integration

Hikaro uses `pi-ai` and `pi-tui`, but **does not use Pi's agent loop**.

```sh
hikaro --install-pi                         # Persistent Pi entry; opens Hikaro by default
hikaro --install-pi --pi-command /path/to/pi --home /path/to/hikaro-home
pi                                         # Automatically enter the installed Hikaro view
pi --pi-native                             # Stay in native Pi for this launch
hikaro --backend pi                         # Hikaro interface, external Pi execution
```

For a source checkout, run `pnpm build`, then use `pnpm start --install-pi`.
The installer probes `pi --version` and Pi's public `get_state` contract, then uses
Pi's official `install` command to register a small owned entry in the selected
Hikaro home. `--home` selects Hikaro data, not Pi's profile. Pi chooses its profile
normally (or through `PI_CODING_AGENT_DIR`). Other Hikaro bridge settings are
preserved, and automatic entry is enabled only after installation succeeds.

The extension loads from the current Hikaro installation, without copying a
second package or bundling Pi's TUI. **After upgrading or moving Hikaro, rerun the
same `--install-pi` command with the same home** to update its entry. To remove the
registration, run `pi remove /absolute/hikaro-home/pi-extension.mjs`.

Inside Pi, `/hikaro` opens the view, `/hikaro default on` and `/hikaro default off`
control subsequent automatic entry, and `/back` returns to Pi. Automatic entry
only runs in interactive Pi, once per process. A one-off source extension remains
available with `pi -e /absolute/path/hikaro/extensions/pi/index.ts`.

Compatibility is validated against **Pi 1.4.0's public RPC and extension
interfaces**. Other version lines display a warning and must pass the basic RPC
contract before connecting. Failures never silently execute a prompt with another
agent. Pi executable extensions are not interchangeable with Hikaro plugins;
external Pi owns its permissions and sandbox.

## Optional integrations

Copy the relevant entries from [config.example.json](templates/config.example.json) into `~/.hikaro/config.json`. All integrations are disabled unless configured. Project files cannot silently enable executable plugins or servers.

- MCP: stdio and Streamable HTTP; deferred tool discovery through `tool_search`.
- Skills: `.agents/skills` and `.hikaro/skills`; workspace `AGENTS.md` instructions.
- LSP: definitions, references, document symbols, diagnostics with version/staleness metadata.
- Index: bounded local keyword search; optional hybrid vector retrieval with explicit embedding-provider approval.
- Browser: isolated Playwright profile; run `pnpm exec playwright install chromium` before enabling it.
- Plugins: tools, commands, providers, event listeners, and text views. See [plugin API](docs/plugins.md).
- Orchestration: bounded subagents, dependency graphs, shared budgets, persistent one-shot scheduled jobs. A running host is required. Interrupted jobs do not replay automatically.

For configured MCP servers, `/mcp` shows connection state, discovered tool count, active calls and the latest error. Use `/mcp connect SERVER`, `/mcp disconnect SERVER`, `/mcp reconnect SERVER` or `/mcp refresh SERVER` to manage them explicitly. In the attached TUI, open `/plugins` and choose the `mcp` command with the same arguments, or the `mcp-status` view. These user commands run through the existing trusted plugin flow; model calls to `mcp_connect` still require approval and accept the same optional `action`. Active calls and competing management operations block connection changes. Failed refreshes retain the previous tools; disconnect and unexpected connection loss remove them. Reconnection is explicit.

## Remote access

See [Cloudflare setup](docs/remote.md). The relay carries encrypted frames; tools run on your computer. No cloud execution, central Hikaro account, or cloud history backup is included.

## Validation

Use the affected test path or filter once, for example `pnpm exec vitest run tests/session-search.test.ts`. Skip tests for documentation and pure styling. Full suites and benchmarks run only when explicitly needed. Correctness CI runs on pull requests and pushes to main; performance measurement is an explicit local command. See the [harness and performance guide](docs/harness-performance.md) for workloads, budgets and evidence limitations.

`pnpm test` runs the application suites in `tests/` with Vitest, then the release/build script checks with Node's test runner. Use `pnpm test:scripts` for the script checks alone. Generated acceptance workspaces under `artifacts/` are evidence, not application test suites.

Optional cloud configuration can be checked with `pnpm check:relay` and `pnpm --filter @hikaro/relay build` (local dry-run, no deployment).

Read [validation status](docs/validation.md) for measured results and remaining acceptance checks. The core and TUI are implemented; remaining daily-use and Pi acceptance work is tracked in TODO.md.

Source installation, macOS arm64 candidate tarballs (`pnpm release:pack` / `pnpm check:release`), upgrade/rollback precautions and isolated installation checks: [TUI installation guide](docs/install-release.md).

Local preflight: `pnpm ci:check`. Android device builds: `pnpm build:android:release` (checks first, then a signed local APK). GitHub Actions are reserved for explicitly approved releases. See [local validation](docs/local-validation.md).
