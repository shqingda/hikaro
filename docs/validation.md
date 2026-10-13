# Validation status

This document distinguishes implemented paths from completed acceptance testing.

## Measured

On the current Apple M3 Pro / 18 GiB Mac, Node **24.21.0**, 30 launches with warm OS caches and the default Anthropic model catalog loaded:

| Metric          | Measurement |
| --------------- | ----------- |
| TUI ready p50   | 121 ms      |
| TUI ready p95   | 124 ms      |
| Process RSS p95 | 90.6 MiB    |

The process measurement includes its SQLite worker. No model request, browser, index, MCP server, or child agent was active. Do not compare these values with a fully active coding workload. Raw repeatable results are generated under ignored `artifacts/` by `pnpm bench`; use `HIKARO_BENCH_LIVE=1` for the configured default provider catalog instead of demo mode.

## Automated coverage

- Own agent loop, tool validation, tool results, cancellation and command IDs.
- Filesystem path checks, concurrent edit checks, actual macOS shell sandbox restrictions.
- QuickJS isolation and host responsiveness during CPU-bound cancellation.
- SQLite event ordering, whole-message pagination, job claims and plugin rollback.
- Real Pi AI adapter against a local OpenAI-compatible SSE fixture.
- Pi RPC completion, handled prompts, queue cancellation and confirmation responses.
- Actual installed Pi 1.2 dedicated bridge entry, offline response, and return to Pi (isolated temporary profiles).
- JSONL UTF-8 framing and size limits; independent RPC scopes.
- Encryption identity checks, tampering, replay, reflection and reconnection.
- Cloudflare runtime integration: authorization, encrypted forwarding, activation and revocation.
- Actual PTY fullscreen entry, Unicode input, resize and terminal restoration.
- Model picker key-release handling, xAI device authorization URL dispatch, conditional reasoning/speed controls, and branded user-message backgrounds.
- Actual Electron renderer → isolated preload → RPC → streamed response.
- Expo iOS/Android JavaScript export and type checking; Cloudflare deployment dry-run.

## Still requires acceptance work

- Provider production accounts and model-specific features, especially OAuth, native provider PTC and automatic provider fallback.
- Actual device Release builds, Android/iOS startup measurements, IME and assistive-technology review.
- Production Cloudflare deployment, pairing against real devices, keychain prompts and push delivery.
- Full 10,000-event interactive load, sustained 100/1,000-chunk bursts, end-to-end input latency and 30-minute steady-state memory.
- Electron startup/RSS across cold launches and a signed distributable.
- Independent security review of the complete remote protocol and third-party plugin behavior.

Manual compaction folds all persisted message pages into a new continuation session using bounded requests. Original events remain in the parent session; generated summaries are not a proof of lossless semantic compression. In-process plugins are trusted code. The initial index has explicit file/chunk quotas. These limits are surfaced rather than hidden behind performance claims.
