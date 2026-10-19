# Durable RPC command receipts — C0 second slice

2026-10-18. Additive protocol v2; no native client or new execution owner.

## Acceptance and identity

Every mutating method (`session.create/resume/fork/compact`, `prompt`, `steer`, `cancel`, `approval.respond`, `client.detach`) commits an intent before executing. SQLite WAL and `synchronous=FULL` remain enabled. The unique key is `(resolved runtime workspace, authenticated scope, commandId)`; remote scope and host-side ID namespace come from authenticated device identity. The digest is SHA-256 over method and params, with recursively sorted object keys; arrays and JSON values remain significant. Prompt/image content is hashed, never copied into the ledger.

Only the atomic claim's inserter executes. Same ID and digest returns `{ duplicate: true, receipt }` without executing, binding a session, approving or cancelling again. Different method or digest is a conflict. The actual selected session and operation ID are captured independently of the original payload; changing the scope selection does not reinterpret a duplicate implicit-session command. After reconnect, select a session with a new explicit `session.resume` command if necessary.

RPC controls have separate bounded waiting counts/bytes because durable acceptance can wait on SQLite. Normal controls allow 64 globally / 8 per scope, 1.5 MB globally / 768 KiB per scope; cancellation, approval and detach retain reserved capacity up to 80 / 12 and 2 MB / 1 MiB. Existing ordinary request limits are unchanged.

Records contain bounded metadata: method, digest, instance/session/run/operation identities, status, timestamps and at most 4,096 error characters. There is no automatic pruning or ID reuse: at 100,000 records per workspace, new mutations are refused while queries remain available. Legacy unscoped prompt claims have no verifiable digest: matching IDs within the workspace return `unknown`, suppress execution, and disclose no original session.

## Status is evidence, not a retry policy

- `accepted`: intent committed. Execution may not have started; it is not safe to replay.
- `completed`: the method finished. For prompt/compact, asynchronous work finished; for cancel/steer/approval/detach, only the control handler applied. It does not assert that cancellation has settled, steering has been consumed, or an approved tool has finished.
- `failed`: the handler/work failed. Earlier side effects may have occurred; failure does not mean rollback.
- `unknown`: an accepted intent belongs to a different host incarnation, or is a legacy claim. Never silently re-execute it. A different incarnation may even still be active against the same DB; queries project unknown without rewriting its stored state.

Terminal updates require the original host instance and an accepted record. A compact receipt points to its continuation child session, while its run ID identifies the source session’s compression run. Run association matches both authenticated scope and command ID, including commands queued for a shared session. Async completion is persisted before `operation.completed/failed` notifications. RPC shutdown cancels work and flushes outcomes while SQLite is still open, with a bounded deadline. A crash between an effect/event and its receipt commit can still leave unknown. Persisted history is inspectable; this slice does not guess completion from nearby events or promise exactly-once external tool effects.

## Recovery API and portable client

`command.receipt({ commandId })` returns `{ receipt: record | null }` within the current workspace and scope. A null result is absence of evidence, not proof an operation was never attempted; query the same host data store. The remote bridge maps the handset ID into the authenticated namespace for lookup, then restores the handset ID in the reply.

`hello`, snapshots and RPC envelopes carry a random `hostInstanceId` for this RPC process incarnation. It is not a stable machine identity or an authorization credential. To retain strict old-v2 handshake compatibility, `runIdentity: "events-only"` remains the legacy marker; `runSnapshotIdentity: true` and `durableCommandReceipts: true` advertise the additions. New snapshots include `runId/runStatus`. On reopen, the latest indexed run event restores a terminal status; an unmatched start restores unknown with `busy:false`, without claiming another process is still running. The normal lease remains the execution authority.

ClientState validates epoch, scope, host identity when present, and snapshot identity. Old hosts and remote response wrappers without envelope identity retain their previous compatibility limits. Unknown or acknowledged local receipts can be explicitly reconciled, including accepted→completed polling, even while a snapshot is required; no method is automatically resent. At most 60 unresolved mutations leave four bounded slots for handshake/snapshot/receipt reads. Completed/failed records and settled reads may be evicted; unresolved mutations cannot.

## Essential evidence

Three storage tests cover concurrent claim, conflicts/isolation, reopen/owner projection and legacy privacy. A real CLI + SQLite + demo test covers completion, restart, query, canonical payload keys, no duplicate execution and run snapshots. Existing deferred RPC control tests cover acceptance, cancellation during claim, late compact/prompt completion, original-command ownership and bounded waiting controls with cancellation reserve. Portable reducer tests cover host/epoch fencing, receipt reconciliation and recovery capacity. Performance evidence is recorded in `docs/validation.md`; native transport wiring, GUI lifecycle, signed packages and physical-device acceptance remain later stages.
