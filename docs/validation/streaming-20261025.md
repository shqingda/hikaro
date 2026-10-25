# Provider-to-terminal streaming validation — 2026-10-25

The new `pnpm bench:stream:check` exercises the packaged CLI through a real PTY,
using a local trusted fixture provider in a temporary profile. The provider embeds
monotonic timestamps immediately before yielding markers; the driver records when
PTY output first contains them. This excludes model/network latency and display
pixel presentation. Durable deltas must reconstruct the exact fixture response and
final message, and every marker must reach terminal output.

The scenarios cover standalone/attached sessions, normal pacing, bursts of 100 and
1,000 deltas, long Markdown, 10,000 restored messages, and input/scroll/cancel during
generation. Each performance cell uses one warmup and three measured runs of 20
markers. The existing p95 budgets remain **33 ms streaming** and **16 ms input**.
Deliberately hidden output while scrolling away does not enter the streaming gate.

## Results and retained change

The frozen pre-change build failed the streaming budget across the matrix:
standalone normal/Markdown were 34.99/47.27 ms; attached normal/Markdown were
34.18/46.56 ms. Input during generation passed at 6.06/6.75 ms. Correctness and
clean process exits passed in all scenarios.

A focused paired comparison reduced the core coalescing window from 24 to 12 ms,
leaving more time for the TUI's existing 16 ms frame scheduling:

| Standalone scenario | 24 ms window p95 | 12 ms window p95 |
| --- | ---: | ---: |
| Normal stream | 36.98 ms | 31.49 ms |
| Long Markdown | 48.21 ms | 35.33 ms |

**The 33 ms goal is not fully met.** The smaller window is retained for its measured
improvement, without adding a new renderer or parsing cache. A deterministic
regression confirms paused provider text flushes within 12 ms (old code failed;
new code passed). The benchmark correctness test also passed.

The attached half of the focused comparison was contaminated by an independently
started iOS simulator: system load average rose from 5.9 to 65.1. Both variants
showed large tail delays, so those samples cannot establish a regression or budget
compliance. Measurement stopped; an 8 ms artifact was built but never sampled or
retained. A final integrated run should wait for normal host load.

## Reproduction

```sh
pnpm build
HIKARO_STREAM_OUTPUT=artifacts/benchmark-stream.json pnpm bench:stream:check
```

`HIKARO_STREAM_ENTRY` can select another packaged `hikaro.mjs`; its sibling worker
and native helpers must be present. Reports include artifact fingerprints, host
information, raw timings, correctness, and exits. Local detailed evidence is in
`artifacts/slimming-20261025/stream-before.json` and
`artifacts/slimming-20261025/stream-window-comparison.json`; generated reports and
large fixture output are intentionally not committed.
