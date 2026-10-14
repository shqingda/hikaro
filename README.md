# hikaro

Independent TypeScript coding agent. Current scope: fullscreen TUI and bidirectional Pi integration. See [TODO.md](TODO.md) for implementation and acceptance status. Desktop and mobile experiments and their dedicated tests have been removed. Cloud configuration remains optional.

## Run

Requires **Node 24.21+**, **pnpm 12.11.2**, and `rg`. macOS is the initial supported host.

```sh
pnpm install
pnpm build
pnpm start --demo
```

Interactive `--demo` starts a fresh offline session unless an offline session is explicitly selected; it cannot restore a live-model session implicitly. The demo model never calls tools. An explicit `!COMMAND` still runs a real sandboxed command under the normal permission policy.

For a real model, set its provider environment variable, then run:

```sh
export ANTHROPIC_API_KEY='your-key'
pnpm start --provider anthropic --model claude-sonnet-4-6
```

`--models` lists the installed Pi AI catalog. `--base-url` supports OpenAI-compatible local or hosted servers. Provider credentials stay in the host process. Interactive `/model` and `/login` save credentials in Keychain; only provider/type metadata is written to `auth-index.json`. Enter saves the model with the active session. Ctrl+S also saves the default for new sessions. `/context`, `/thinking`, and `/speed` separate **active** and **default**: Enter applies the chosen value immediately; Ctrl+S also saves the default. Add `default` to edit only defaults for new sessions. `/settings` saves display, completion bell and startup preferences immediately. Plain `pnpm start` restores the last opened session in this workspace, including its model settings. Use `/new` or `pnpm start --new` for a new session. `--session ID` selects a specific session. No task is automatically replayed.

```sh
pnpm start --provider local --model your-model --base-url http://localhost:11434/v1
pnpm start --trust                         # permit workspace file edits
pnpm start -p 'Explain this project'       # noninteractive; approvals denied
pnpm start --rpc                          # versioned JSONL client protocol
```

Native TUI permissions default to **Ask for approval**: workspace file edits and sandboxed commands are allowed; external file access, unrestricted commands, MCP and browser actions ask for approval. `/permissions` selects **Ask for approval**, **Approve for me**, or **Full Access**, and saves the choice for the current canonical workspace in `~/.hikaro/permissions.json` (or the selected home). Enter applies it immediately while agents are idle. `/permissions ask`, `/permissions auto`, and `/permissions full` select a mode directly.

**Approve for me** uses conservative local rules, with no extra model request. Ordinary workspace file operations and known literal read commands can pass automatically. Sensitive paths, shell expansion, unknown commands/tools and expanded access still ask. Commands remain in the macOS workspace sandbox with no network. **Full Access** permits external file tools and runs shell/PTY commands on the host with network access, without approval. Existing processes retain the access they had when started.

Noninteractive/RPC hosts keep the existing `--trust` and per-operation approval behavior; they do not inherit the TUI's saved mode. Third-party in-process plugins are trusted code. The external Pi backend owns its own permissions; Hikaro's selector cannot change those.

The current permission mode stays visible independently of the usage footer. Short menus use arrow keys without a search field; model, provider and session lists retain search. Settings keep the selected row after each save.

Ctrl+S appears only on actual model choices and active model-setting values. Provider/authentication steps and default-only settings use Enter. Narrow panels wrap values and descriptions, keep the selected choice and reserve Enter/Esc hints. If the available space cannot show the selected content, the panel asks you to resize. Layout text has been inspected at 36×18, 60×18 and 100×24; real-terminal acceptance remains pending.

## Terminal controls

| Command | Action |
| --- | --- |
| `/new`, `/sessions`, `/resume [ID]` | Session picker with page navigation and page-local title/description/ID search; Delete/Ctrl+D opens confirmation; Enter deletes, Esc cancels |
| `/rename TITLE` | Rename the current session; Ctrl+R renames a selected session in `/sessions` |
| `/export` | Export all saved text messages as Markdown; hidden thinking stays excluded |
| `/skill:NAME [TASK]` | Invoke a discovered Skill; Skill and plugin commands appear in completion |
| `/fork`, `/compact` | Branch history or create a continuation summary |
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

Drafts are saved on session switches and orderly exit. They are not crash recovery or per-keystroke autosave. The last session can be deleted; deleting the current session opens a fresh blank session.

The editor's top border shows an animated **Working**, **Thinking**, **Running TOOL**, or **Compacting** indicator. It pauses while waiting for approval/input and stops on completion, cancellation, session binding and exit. Thinking status is independent of whether reasoning text is displayed.

Data defaults to `~/.hikaro`; override with `--home` or `HIKARO_HOME`. Sessions are SQLite event streams. Large tool results are saved as artifacts. Process logs have a 50 MiB cap, reported when reached.

## Pi integration

Hikaro uses `pi-ai` and `pi-tui`, but **does not use Pi's agent loop**.

```sh
pnpm start --backend pi                    # Hikaro interface, external Pi execution
pi -e /absolute/path/hikaro/extensions/pi/index.ts
```

Inside Pi:

```text
/hikaro
/hikaro default on
/hikaro default off
```

Persist the extension using Pi's package/extension settings if you want it loaded every launch. `pi --pi-native` skips automatic Hikaro entry when the extension is loaded. `/back` leaves the bridge. Automatic entry only runs in interactive Pi, once per process. No failure silently executes the prompt with another agent.

Compatibility targets Pi **1.2.0's public RPC and extension interfaces**. Arbitrary executable Pi extensions are not interchangeable with Hikaro plugins. External Pi owns its permissions and sandbox.

## Optional integrations

Copy the relevant entries from [config.example.json](templates/config.example.json) into `~/.hikaro/config.json`. All integrations are disabled unless configured. Project files cannot silently enable executable plugins or servers.

- MCP: stdio and Streamable HTTP; deferred tool discovery through `tool_search`.
- Skills: `.agents/skills` and `.hikaro/skills`; workspace `AGENTS.md` instructions.
- LSP: definitions, references, document symbols, diagnostics with version/staleness metadata.
- Index: bounded local keyword search; optional hybrid vector retrieval with explicit embedding-provider approval.
- Browser: isolated Playwright profile; run `pnpm exec playwright install chromium` before enabling it.
- Plugins: tools, commands, providers, event listeners, and text views. See [plugin API](docs/plugins.md).
- Orchestration: bounded subagents, dependency graphs, shared budgets, persistent one-shot scheduled jobs. A running host is required. Interrupted jobs do not replay automatically.

## Remote access

See [Cloudflare setup](docs/remote.md). The relay carries encrypted frames; tools run on your computer. No cloud execution, central Hikaro account, or cloud history backup is included.

## Validation

Use the affected test path or filter once, for example `pnpm exec vitest run tests/session-settings.test.ts -t 'session picker'`. Skip tests for documentation and pure styling. Full suites and benchmarks run only when explicitly needed; CI is manual.

Optional cloud configuration can be checked with `pnpm check:relay` and `pnpm --filter @hikaro/relay build` (local dry-run, no deployment).

Read [validation status](docs/validation.md) for measured results and remaining acceptance checks. The core and TUI are implemented; remaining daily-use and Pi acceptance work is tracked in TODO.md.
