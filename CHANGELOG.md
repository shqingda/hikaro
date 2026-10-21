# Changelog

## 0.1.0 — release candidate, not yet published

Initial supported host: macOS arm64, Node 24.21 or later. The current distribution is an npm tarball; Node, npm and `rg` are external prerequisites. Other host platforms are not release-qualified. The mobile companion is tracked separately and is not part of this TUI release.

### Included

- Fullscreen TUI with persistent sessions, model selection, subscription sign-in, file/image references, bounded history reading and unsent-draft recovery.
- Workspace file and shell tools with permissions, explicit approval, visible failure and cancellation outcomes. File changes can be reviewed and individually rolled back with conflict checks.
- Shared host and attached TUI, durable command receipts, explicit recovery of queued prompts and unanswered host questions, recent execution history and steering queue controls.
- Read-only planning, structured questions and reviewed execution; optional MCP, skills, plugins and Pi integration within documented compatibility limits.
- macOS arm64 packaging with a production dependency lock, SHA-256 checks, empty-cache install validation and a verified node-forge security backport.

### Upgrade and rollback

Stop all writers and back up the complete data directory before upgrading. Keep the previous install. Rollback requires that install and the pre-upgrade data backup; it does not retain tasks created after the backup. Credentials remain in Keychain and are not included in a data-folder backup. See [installation and rollback](docs/install-release.md).

### Remaining release acceptance

Physical Chinese input-method and assistive-technology results, provider network/rate-limit recovery, distribution on a clean machine and the final public channel remain open. The current engineering record is [release readiness](docs/release-readiness.md); a candidate build is not a completed public release.

### Known boundaries

Steering instructions and usage budgets are not restored across host restarts. Unknown work is not automatically retried. Full history search, clipboard-image capture, portable attachment export, batch rollback/redo, nested task trees and complete third-party plugin compatibility remain outstanding. Closing a plugin result panel does not cancel plugin code. See [the complete backlog](TODO.md).
