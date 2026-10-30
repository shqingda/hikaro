# Hikaro task workbench

Approved 2026-10-30. Replaces the single-column presentation in tui-workbench.md;
retains its palette, editor, rendering, approval, performance and Pi boundaries.

## Delivery contract

- CLI lives in packages/cli; historical validation references retain their original paths.
- Official node-forge 1.4.2 replaces the backport, with verified release contents and strict audits.
- Workspace navigation and Conversation / Changes / Activity / Plan / Context are independent views.
- At 144 columns navigation and inspector coexist; at 100–143 an inspector replaces navigation;
  below 100 navigation and inspector are full-page views. Short terminals reserve usable input.
- Actions are discoverable through Ctrl+P, sessions through Ctrl+O, focus through F6.
- Enter submits run-bound steering while busy; Ctrl+X Enter queues. Attachments require queue.
- Reading never holds execution. Mutating queue entries briefly holds and revalidates them.
- Up to eight monitored sessions retain drafts, scroll, execution and pending approvals.
  Closing a view does not stop execution. Offline actions are never replayed automatically.
- Model selection and provider login/relogin/logout share /model; old authentication commands
  are compatibility routes. Credentials retain their real home and backend ownership.
- Native and attached provide the full workbench; external Pi and embedded Hikaro expose only
  their capabilities. Pi supplies the embedded TUI instance; /back remains available.
- New run-bound steering is additive and negotiated; no session database format change.

## Verification

Sizes: 144x40, 120x40, 80x24, 60x18, 40x12; dark/light/transparent/NO_COLOR.
Verify CJK/IME, emoji, selection, paste, undo, completion, focus, scrolling, concurrent
tools, background approvals, model/auth races and disconnect recovery. Run focused tests,
pnpm check, pnpm test:pi and existing startup/attached/stream gates without weakening them.
Record actual PTY evidence separately from component fixtures and human-only checks.
