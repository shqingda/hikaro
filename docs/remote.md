# Remote host and Cloudflare

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
pnpm start --serve --cwd /path/to/project
```

The pairing command prints a QR code in an interactive terminal and a URI for copying. The code expires after five minutes. It contains device credentials; share it only with the device being enrolled. Scan/paste it in Expo and confirm on the computer running `--serve`.

Host identity and relay credentials use the OS keyring (Keychain on macOS). Device credentials use Expo SecureStore. Metadata lives in `~/.hikaro/remote.json`; devices can be revoked with `--revoke DEVICE_ID`.

A remote host owns one RPC process. Device scopes select sessions independently. Disconnecting a handset does not stop a running task. Reconnect restores history, active output and pending approvals. Ambiguous commands are not automatically replayed. Revocation removes the scope and cancels its active run.

Push requires the user's own Expo/EAS project ID in `apps/mobile/app.json` under `extra.eas.projectId`. Push payloads contain a generic status and host ID, never prompts, code, or tool output. Queue delivery is at-least-once; bounded deduplication reduces repeats but cannot guarantee exactly-once delivery across an external push service.
