# Changelog

## 0.4.0 — 2026-11-01

- Enter while running interjects, as in Codex: a reply the model is still thinking or writing is cut short (what it wrote is kept) and it answers again with your message. A running tool is never interrupted; the instruction applies once it finishes and the step's remaining tool calls are skipped. `/follow` and Ctrl+X Enter queue instead.
- `/context` now shows context usage: used / window, a bar by category and the room left before auto-compact. `/context-window` sets the window size (the old `/context` picker). The Context workbench tab stays reachable from the tab bar.
- `/help` and slash completion come from one command list per mode. In attached mode `/delete` opens the session picker instead of being sent to plugins.
- The header shows when a background session needs attention (Ctrl+O). Menus name the Enter action; settings show each value inline. Text questions show the question while you type.
- Scrolling up shows "↓ PageDown" centered on its own row above the composer, on the terminal background; clicking it returns to the latest message. Offline demo mode accepts images. Pasted images become inline `[Image #N]` tokens that delete as one unit and come back with Ctrl+Z. Pasted images are copied at paste time, so a macOS screenshot thumbnail that disappears can still be sent. Clicking a token previews it in the terminal: full resolution in Kitty-protocol terminals (Warp, Ghostty, kitty, WezTerm), half blocks elsewhere.
- `/exit` works like `/quit`. Session lists label Delete Ctrl+D and Rename Ctrl+R.
- The user-message background follows a terminal or system appearance switch without restarting. Choosing a model also makes it the default for new sessions.
- Sent prompts are no longer restored into the next draft. The Pi extension builds again and its view no longer loses a row.

## 0.3.0 — 2026-10-26

- Install the macOS Apple Silicon CLI with `curl -fsSL https://github.com/shqingda/hikaro/releases/latest/download/install.sh | sh`. The package bundles Node.js 26.12.1; `hk` is a short alias and `hikaro update` reinstalls the latest release, keeping the previous one for rollback.
- Pi reopens the workspace's previous Hikaro session; Ctrl+D or `/back` returns to Pi after Hikaro disconnects. Full notes: [v0.3.0](docs/releases/v0.3.0.md). Sections below marked Unreleased shipped in this release.

## Unreleased — startup latency

- Empty TUI sessions initialize Markdown when the first message is rendered, preserving full formatting on restored history.
- Attached clients avoid rewriting unchanged durable operation journals and paint the first ready frame immediately after restoring session, history and drafts. Standalone startup tail latency remains above the target in some measured runs; see [validation](docs/validation/startup-optimization-20261024.md).

## Unreleased — change reapplication

- TUI `/changes` can reapply a reverted edit after explicit confirmation. Reapplication refuses conflicting newer contents and creates a new undoable journal entry. Shared hosts advertise `changes.redo`; older hosts do not show this action.

## Unreleased — search and portable exports

- TUI: `/search [TEXT]` searches the current session's complete message text in standalone and attached mode. Browse bounded result pages and open the original message in sections.
- TUI: `/export` saves stored message images beside Markdown using relative links. Copy the `.md.assets` directory with the Markdown file. Generic external attachments and tool artifacts are not yet bundled.

## 0.1.0 — release candidate, not yet published

Initial supported host: macOS arm64, Node 24.21 or later. The current distribution is an npm tarball; Node, npm and `rg` are external prerequisites. Other host platforms are not release-qualified.

### Included

- Fullscreen TUI with persistent sessions, model selection, subscription sign-in, file/image references, bounded history reading and unsent-draft recovery.
- Workspace file and shell tools with permissions, explicit approval, visible failure and cancellation outcomes. File changes can be reviewed and individually rolled back with conflict checks.
- Shared host and attached TUI, durable command receipts, explicit recovery of queued prompts, steering and unanswered host questions, recent execution history and steering queue controls. Restored steering requires confirmation from its original client and applies at the next model turn.
- Read-only planning, structured questions and reviewed execution; optional MCP, skills, plugins and Pi integration within documented compatibility limits.
- macOS arm64 packaging with a production dependency lock, SHA-256 checks, empty-cache install validation and a verified node-forge security backport.

### Upgrade and rollback

Stop all writers and back up the complete data directory before upgrading. Keep the previous install. Rollback requires that install and the pre-upgrade data backup; it does not retain tasks created after the backup. Credentials remain in Keychain and are not included in a data-folder backup. See [installation and rollback](docs/install-release.md).

### Remaining release acceptance

The user passed Chinese input, mixed-character editing, multiline paste, resize and the fixed Ctrl+D draft recovery checks. Candidate e0fb56a includes durable steering and the paged diff protocol, and passed clean-machine installation/recovery and same-package real subscription acceptance. Process-local network/rate-limit/stream failures and cancellation recover through explicit subscription requests. Assistive-technology results and final publication remain open. The current engineering record is [release readiness](docs/history/release-readiness-through-20261026.md); a candidate build is not a completed public release.

### Known boundaries

Usage budgets are not restored across host restarts. Unknown work is not automatically retried. The distribution draft targets verified candidate e0fb56a; later product changes require a new validated candidate. Full history search, clipboard-image capture, portable attachment export, batch rollback/redo, nested task trees and complete third-party plugin compatibility remain outstanding. Closing a plugin result panel does not cancel plugin code. See [the complete backlog](TODO.md).
