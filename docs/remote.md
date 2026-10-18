# Remote host and Cloudflare

For one-command iOS simulator pairing, grants and recovery checks, use `pnpm mobile:lab`; see [the local lab guide](mobile-lab.md). It runs this relay locally over TLS in an isolated workspace. The deployment steps below are for a public relay used by physical devices across networks.

Cloudflare stores connection/device metadata and hashed bearer tokens. Application commands and events use authenticated NaCl encryption between paired devices. Each connection performs a mutual challenge handshake and checks direction and sequence. Keys are pinned by the pairing code. This protocol does **not** claim forward secrecy.

## Deploy your relay

Use your own Cloudflare account. No account or service has been deployed by this implementation task.

```sh
pnpm --filter @hikaro/relay exec wrangler login
pnpm --filter @hikaro/relay exec wrangler queues create hikaro-notifications
pnpm --filter @hikaro/relay exec wrangler secret put BOOTSTRAP_TOKEN
pnpm --filter @hikaro/relay deploy
```

Use a randomly generated secret for `BOOTSTRAP_TOKEN`, distinct from Cloudflare deployment credentials. Keep it local. The Worker configuration declares a SQLite Durable Object per host and a queue for generic push notifications.

## Pair

```sh
export HIKARO_RELAY_BOOTSTRAP='the-bootstrap-secret'
pnpm start --pair --relay wss://your-worker.workers.dev
# Terminal 1: owns execution. Put provider/model/endpoint options here.
pnpm start --host --cwd /path/to/project
# Terminal 2: attaches the encrypted relay bridge; does not spawn another Runtime.
pnpm start --serve --cwd /path/to/project
# Terminal 3: a view of those same tasks.
pnpm start --attach --cwd /path/to/project
```

The pairing command prints a QR code in an interactive terminal and a URI for copying. The code expires after five minutes. It contains device credentials; share it only with the device being enrolled. The [M0 native companion](mobile.md) scans or pastes this URI and reviews the pinned host identity before saving credentials. Enrollment requires confirmation on the computer running `--serve`; explicitly grant each session separately. Physical-device/release acceptance remains pending.

Host identity and relay credentials use the OS keyring (Keychain on macOS). The M0 client uses system SecureStore for device credentials. Metadata lives in `~/.hikaro/remote.json`; devices can be revoked with `--revoke DEVICE_ID`.

The independent `--host` owns one Runtime; `--serve` only bridges to its private Unix socket. All entries must use the same `--cwd` and `--home`. Device scopes select sessions independently and can own sessions they create. Existing sessions require an explicit local-owner grant: `/share DEVICE_ID view|control|off` in the attached TUI. Pairing alone does not grant access to another session or its approvals. Only control participants viewing the same session can answer its current approval; the host rejects stale or concurrent second decisions.

Disconnecting a view or stopping `--serve` leaves the task running. Reconnect restores the authoritative snapshot; durable intent IDs reconcile against receipts without mutation replay. M0 injects a bounded SQLite WAL/FULL `IntentStore` before any session selection; foreground/recreated views reconcile receipts without replay. Device revocation removes grants and cancels only that device's active/queued work, preserving another owner's run. A host crash leaves unmatched runs unknown. See [startup and recovery](shared-host.md).

M0 also uses an authenticated, bounded device-status probe to distinguish revoked enrollment from temporary disconnection after reopening. Deploy the updated relay before using M0; no deployment is performed by the mobile app.

The optional relay retains Expo push-token support for later clients. This repository no longer includes mobile push registration or an EAS project configuration. Push payloads contain a generic status and host ID, never prompts, code, or tool output. Queue delivery is at-least-once; bounded deduplication reduces repeats but cannot guarantee exactly-once delivery across an external push service.
