# Shared host — H1

Status: implemented and locally verified (2026-10-18). See the [startup/recovery guide](../shared-host.md).

One opt-in `--host` process owns a canonical workspace + data-home pair. Standalone TUI retains its measured startup path.

Local IPC uses an owner-only Unix socket directory, socket and bearer metadata, with bounded JSONL input/output and per-connection scope injection. A transactional SQLite host claim checks the owning PID before removing an abandoned endpoint; two live hosts must not both own the same workspace. A missing or unsafe endpoint fails closed. Socket loss detaches a view, never shuts down its host or replays a mutation.


Selections and session grants survive host restart. A reconnected client handshakes, restores the authoritative snapshot and reconciles recorded command IDs. The attached TUI persists client intent metadata before sending mutations; clients can inject a durable IntentStore. Transport loss leaves unknown outcomes and never retries an operation. Reopened unfinished runs remain unknown. Local drafts remain explicitly unsent.

Necessary evidence: storage claim/access isolation, a real shared host with local clients covering restart and lost outcomes, and a real attached TUI flow. Performance is evaluated against a comparable baseline.

The same stable client ID has one active channel: a replacement fences the old socket and stops its automatic reconnect loop. The host injects the authenticated local scope; RPC fields cannot impersonate another client. Stdio approval ownership remains isolated by scope.

Only live Runtime delegation can inherit a root session's approval authority. The presented permission keeps the actual child session ID plus host-assigned `authoritySessionId`; authorization, audience and final decision use that recorded root. Runtime tracks at most its bounded active delegation depth, removing the link on completion. Forks and arbitrary persisted parent IDs do not inherit access, and responders cannot choose authority by supplying RPC parameters.

Necessary evidence is in `tests/shared-host-storage.test.ts`, `tests/shared-host.test.ts` and the durable-intent case in `tests/client-connection.test.ts`. The real TUI case exits while an approval is open, reattaches to that same request, accepts another view's decision, then recovers an unsent multilingual draft after SIGKILL. The encrypted device fixture proves grant enforcement, simultaneous approval, disconnected approval recovery and device revocation. A separately spawned host is force-killed and restarted: selection and run ID recover as unknown, and run.start counts prove no replay. Invalid credentials and insecure metadata fail closed.
