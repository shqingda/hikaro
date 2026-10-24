# Changelog

## Unreleased — change reapplication

- TUI `/changes` can reapply a reverted edit after explicit confirmation. Reapplication refuses conflicting newer contents and creates a new undoable journal entry. Shared hosts advertise `changes.redo`; older hosts do not show this action.

## Unreleased — search and portable exports

- TUI: `/search [TEXT]` searches the current session's complete message text in standalone and attached mode. Browse bounded result pages and open the original message in sections.
- TUI: `/export` saves stored message images beside Markdown using relative links. Copy the `.md.assets` directory with the Markdown file. Generic external attachments and tool artifacts are not yet bundled.
- Mobile: task message search, paginated results and original-message reading are implemented. Type checks, reader tests and both platform bundles pass; native search interaction remains unverified.

## Unreleased — mobile companion

- Read task images on demand with previous/next and zoom controls; browse recorded file changes and Unicode-safe, paged diffs. A negotiated read-only `changes.diff` method shares the TUI diff implementation. Reading clears on context loss and does not resume automatically. View-only host integration and native iOS image/diff/lifecycle acceptance pass.
- Add instructions for the next model turn and manage their queue: read, edit, move first, delete and explicitly confirm restored items. Management pauses dispatch until close; lost replies are reconciled without replay.
- Keep queue lease renewal from interrupting the native editor. Host integration, native iOS submission/reordering/deletion/close-release, typechecks and both platform exports pass.
- Native iOS approval/denial, stop confirmation and actual process termination, queue edit/save/discard, original-client restore confirmation and background release now pass in the existing simulator. Queue receipt messages no longer show an unrelated previous stop notice before a receipt query. Keyboard/IME, Android, physical devices and signed distribution remain unqualified.
- Send requests from a native multiline editor and queue them while the computer is busy.
- Save task drafts locally, including offline editing and reopening. Connection recovery never automatically sends drafts.
- Preserve text and command identity until acceptance is confirmed; reconcile lost replies without replaying requests. Removing a pairing clears its drafts.
- Controller integration with a real host and both platform exports passed. Native iOS multiline paste, explicit send, offline draft editing, background/process recovery and reconnection without replay passed in the existing simulator. Keyboard/IME, Android, physical devices and signed distribution remain unqualified.
- `pnpm dev:sim` starts or reuses the simulator and preview without opening the system browser. Open the printed URL in Codex; `--open-browser` explicitly opts into the system browser.

## 0.1.0 — release candidate, not yet published

Initial supported host: macOS arm64, Node 24.21 or later. The current distribution is an npm tarball; Node, npm and `rg` are external prerequisites. Other host platforms are not release-qualified. The mobile companion is tracked separately and is not part of this TUI release.

### Included

- Fullscreen TUI with persistent sessions, model selection, subscription sign-in, file/image references, bounded history reading and unsent-draft recovery.
- Workspace file and shell tools with permissions, explicit approval, visible failure and cancellation outcomes. File changes can be reviewed and individually rolled back with conflict checks.
- Shared host and attached TUI, durable command receipts, explicit recovery of queued prompts, steering and unanswered host questions, recent execution history and steering queue controls. Restored steering requires confirmation from its original client and applies at the next model turn.
- Read-only planning, structured questions and reviewed execution; optional MCP, skills, plugins and Pi integration within documented compatibility limits.
- macOS arm64 packaging with a production dependency lock, SHA-256 checks, empty-cache install validation and a verified node-forge security backport.

### Upgrade and rollback

Stop all writers and back up the complete data directory before upgrading. Keep the previous install. Rollback requires that install and the pre-upgrade data backup; it does not retain tasks created after the backup. Credentials remain in Keychain and are not included in a data-folder backup. See [installation and rollback](docs/install-release.md).

### Remaining release acceptance

The user passed Chinese input, mixed-character editing, multiline paste, resize and the fixed Ctrl+D draft recovery checks. Candidate e0fb56a includes durable steering and the paged diff protocol, and passed clean-machine installation/recovery and same-package real subscription acceptance. Process-local network/rate-limit/stream failures and cancellation recover through explicit subscription requests. Assistive-technology results and final publication remain open. The current engineering record is [release readiness](docs/release-readiness.md); a candidate build is not a completed public release.

### Known boundaries

Usage budgets are not restored across host restarts. Unknown work is not automatically retried. The distribution draft targets verified candidate e0fb56a; later product changes require a new validated candidate. Full history search, clipboard-image capture, portable attachment export, batch rollback/redo, nested task trees and complete third-party plugin compatibility remain outstanding. Closing a plugin result panel does not cancel plugin code. See [the complete backlog](TODO.md).
