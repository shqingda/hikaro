# Shared host — H1

Status: implementation in progress (2026-10-18).

One opt-in `--host` process owns a canonical workspace + data-home pair. `--attach` renders the existing TUI against that host; `--serve` bridges authenticated remote devices to the same endpoint. Standalone TUI retains its measured startup path. No automatic service installation, privilege escalation, or native mobile app is part of H1.

Local IPC uses an owner-only Unix socket directory, socket and bearer metadata, with bounded JSONL input/output and per-connection scope injection. A transactional SQLite host claim checks the owning PID before removing an abandoned endpoint; two live hosts must not both own the same workspace. A missing or unsafe endpoint fails closed. Socket loss detaches a view, never shuts down its host or replays a mutation.

Shared mode explicitly authorizes sessions: local owner clients may manage grants; paired devices retain ownership of sessions they create but require a persisted view/control grant to join another session. Only control participants viewing that session receive its approvals. The host rechecks membership and request identity before applying a response; a resolved/stale request cannot apply twice. Revoking a participant removes that view/approval access without denying another participant's still-pending decision. Device revocation also cancels that device's own work.

Selections and session grants survive host restart. A reconnected client handshakes, restores the authoritative snapshot and reconciles recorded command IDs. Client intent metadata is persisted before sending mutations; transport loss leaves unknown outcomes and never retries an operation. Reopened unfinished runs remain unknown. Local drafts remain explicitly unsent.

Necessary evidence: storage claim/access isolation; one real shared host with local + authenticated-remote adapter covering shared run, approval race/revocation and disconnect/restart; one PTY attached TUI flow. Keep existing RPC compatibility checks, portable typecheck, startup p95 <=200 ms, input <=16 ms, ready RSS <=100 MiB, and the unchanged 10k core/storage harness. Record the separate warm-host attach measurement rather than extrapolating standalone TUI numbers.
