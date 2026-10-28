# Remote host and Cloudflare

Default service: `wss://hikaro-relay.shqingda.workers.dev`. Normal use requires only Hikaro: start the TUI and enter `/pair`. Tailscale is deferred; see [ADR-001](decisions/001-mobile-connectivity.md). The user explicitly waived a separate mainland-network stability precheck.

Use `pnpm dev:sim` for the existing iPhone 18 Pro browser preview; it opens localhost:3200 without launching DeviceHub or provisioning another simulator. Pairing and task grants use the relay configured below. The encrypted local relay fixture remains available to headless tests (`pnpm mobile:lab:check`); it does not provision or change simulators.

Cloudflare stores connection/device metadata and hashed transport bearer tokens; the short-lived pairing exchange also holds the phone-generated bearer token until expiry, so the authenticated host can enroll it. Private identity keys never enter the new pairing exchange. Application commands and events use authenticated NaCl encryption between paired devices. Each connection performs a mutual challenge handshake and checks direction and sequence. Keys are pinned by the pairing code. This protocol does **not** claim forward secrecy.

## Optional: deploy your own relay

For self-hosting, use your own Cloudflare account. The bundled configuration enables public host registration; set `PUBLIC_REGISTRATION` to `"false"` if your private deployment should require the legacy bootstrap secret.

```sh
pnpm --filter @hikaro/relay exec wrangler login
pnpm --filter @hikaro/relay exec wrangler queues create hikaro-notifications
pnpm --filter @hikaro/relay exec wrangler secret put BOOTSTRAP_TOKEN
pnpm --filter @hikaro/relay run deploy
```

Use a randomly generated secret for `BOOTSTRAP_TOKEN`, distinct from Cloudflare deployment credentials. Keep it local. The Worker configuration declares a SQLite Durable Object per host and a queue for generic push notifications.

## Pair in the TUI (normal use)

Run `hikaro` / `hk` (or `pnpm start` from this checkout), then enter `/pair`.
First use registers the host automatically with the default service. No relay address or bootstrap prompt appears. The same terminal starts or reuses the shared host and relay bridge. Existing configured relay addresses remain usable if the service implements the new pairing endpoints.

The fullscreen screen shows a QR and six-digit code; Tab shows the short code and Esc returns to the task. The code remains visible if the QR cannot fit. Scan or enter the code within five minutes, compare the verification fingerprint on both screens, then explicitly allow the phone in the TUI. The phone generates its own identity; the QR pins the host public key. Cancelled or unused enrollments expire. Existing sessions still require `/share DEVICE_ID view|control|off` — pairing does not silently grant access.

Subsequent normal starts reuse the saved connection configuration. Keep this terminal open while using the phone. Quitting closes this view's bridge and a host started by this view; it does not stop an externally managed host. First-time switching requires idle tasks/background operations, preserves the current session, and carries local drafts/preferences into the attached view. The original CLI flags below remain available for deliberate headless/background operation.

The phone tries advertised private IPv4 LAN addresses first, then falls back to the default secure WebSocket relay. Local frames remain NaCl encrypted and authenticated; LAN does not send the relay bearer token. The desktop listens on port 43187 while the mobile bridge runs. If that port is unavailable, the relay remains usable. Fresh pairing currently needs the default service even on the same Wi-Fi; previously paired LAN sessions can connect directly. Address changes require a new pairing to refresh the advertised LAN addresses.

## Advanced: separate host and relay processes

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
