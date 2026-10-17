# Client core — C0 contract

This first slice is a portable execution-state reducer, not a GUI or a new execution owner. It imports only the portable Zod wire contracts; no Node, DOM, socket, clock, storage, credential, or model API. Native transports remain outside this package.

## Contract before implementation

1. `hello` is an additive protocol-v2 control method. An optional bounded `protocolVersions` list must include v2. Its response enumerates actual RPC methods, `session.current` as the snapshot method, globally monotonic event sequence filtered by session, and explicit limits. Existing ready frames/methods retain their meaning. Run IDs are recoverable only from observed events, not the existing snapshot.
2. `ClientState.beginConnection()` advances a connection epoch. Unanswered commands become `unknown`; a disconnected client cannot send. `command(id, method, params)` only prepares a frame. The caller writes it once; this package never sends, retries, reconnects, or replays an operation.
3. Feed **all complete raw RPC frames in wire order** to `receive(epoch, frame)`. A correlated `hello` response enables `session.current`; its correlated response establishes snapshot state synchronously. Do not feed promise results after later events: use the raw observer on ProcessClient or an equivalent transport parser. While awaiting a snapshot, buffer at most 128 notifications/1 MiB. The host adds a per-scope revision to notifications and snapshots: discard buffered revisions covered by the snapshot, then apply strictly contiguous newer revisions. This also handles a remote wrapper delivering later notifications before its snapshot response. Buffer overflow requires another snapshot.
4. Scope/session mismatches and duplicate/old sequence numbers never change the selected state. A notification revision gap disables new mutations until a fresh snapshot. New frames after the barrier update stream, run state and approvals. A snapshot clears any inferred run ID; `busy` does not imply a known operation identity.
5. Pending approvals belong to the scope and session captured by the host. Resolution removes by ID. Disconnect or a gap makes `canAct` false; cached state may be displayed but never treated as an actionable approval.
6. SQLite event sequence numbers may skip values consumed by other sessions; only scope notification revision gaps require a snapshot. Keep only the last 64 event summaries, a 100,000-character stream, at most 64 approvals, and 64 command receipts. Evict only settled receipts or unknown read-only requests; if pending/unknown mutation receipts exhaust the bound, reject new commands rather than discard uncertainty. Command IDs must remain unique across the caller's lifetime; an evicted settled receipt is not durable deduplication.
7. Transport loss or timeout means unknown, not failed or safe to resend. A snapshot does not resolve unknown commands. Receipt lookup, durable payload-digest conflict checks, host instance identity, runId snapshots and attachment management are later slices.
8. Validate incoming recognized frames and reject oversized/malformed state. Never store arbitrary RPC results or unbounded history in this reducer. `messages.read`/artifact browsing remains a separate paginated layer.

## Verification plan

Targeted tests only: `tests/client-core.test.ts` for duplicates/gaps/epochs/approvals/unknown/bounds and `tests/rpc-handshake.test.ts` for the real serveRpc handler + SQLite + offline demo, with no spawned CLI or provider network. Run existing `tests/rpc-control.test.ts` once after implementation for control-method compatibility. A package-local `tsconfig.json` with ES2023 and no ambient Node/DOM types proves the portable import closure.

## Connecting an existing local transport

`ProcessClient.observe` receives raw responses and notifications in wire order even when no `request()` promise owns the ID. Use `send(state.command(...))` once and feed the observer to `state.receive(epoch, frame)`. On transport failure call `state.disconnected(epoch)`; on a new transport call `beginConnection()` and explicitly send `hello`, then `session.current`. Catch validation errors in the observer to show an error state. Calling `request()` and `send()` for the same prepared command would send twice: use one path.

A remote adapter must expose the same raw frame stream and bind `ClientState.scope` to the authenticated device ID; do not replace the server-selected scope with a handset-provided value. This package does not replace the existing crypto handshake or credential storage. The existing remote request wrapper has not yet gained a raw observer, so full mobile transport wiring remains a later slice.

## Implemented verification

The handshake test first failed because the old protocol rejected `hello`; portable tests first failed because the package did not exist. Targeted tests now cover the real RPC handler, real SQLite event sequence consumed by two independent scopes, offline demo completion/reconnect, raw ProcessClient response ordering, malformed image rejection before run.start, and the reducer's bounded state/recovery rules. Existing RPC control tests remain compatible. Exact run counts are reported in the work summary; no full suite or performance benchmark is implied.

`pnpm exec tsc -p packages/client-core/tsconfig.json` checks the import closure with `lib: ["ES2023"]` and `types: []`. The snapshot's `runId` is deliberately `null`: do not infer a run ID or command success from `busy` or a restored transcript.
