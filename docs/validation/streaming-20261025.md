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
| ------------------- | ---------------: | ---------------: |
| Normal stream       |         36.98 ms |         31.49 ms |
| Long Markdown       |         48.21 ms |         35.33 ms |

**The 33 ms goal is not fully met.** The smaller window is retained for its measured
improvement, without adding a new renderer or parsing cache. A deterministic
regression confirms paused provider text flushes within 12 ms (old code failed;
new code passed). The benchmark correctness test also passed.

The attached half of the focused comparison was contaminated by an independently
started iOS simulator: system load average rose from 5.9 to 65.1. Both variants
showed large tail delays, so those samples cannot establish a regression or budget
compliance. Measurement stopped; an 8 ms artifact was built but never sampled or
retained. A final integrated run should wait for normal host load.

## Stable-prefix streaming Markdown — 2026-10-26

While streaming, the preview is now split at the last blank-line block boundary that
later text cannot change (outside fences, after the full blank run, before a complete
line that does not open a list, table, quote or indented block; disabled when a
reference definition exists). The prefix keeps one parsed `Markdown`; each delta
re-parses only the live tail. The preview start moves in 2,000-character steps so
the prefix stays reusable past 16,000 characters. A seeded fuzz test checks that every
growing prefix renders byte-for-byte like the final message (≈240k extra checks
across three seeds also matched locally).

In-process, a growing 12 KB fixture frame fell from 3–5 ms to 0.2–0.5 ms. Same-day
P3 also stopped re-colouring unchanged user rows (~0.4 ms per visible row per frame)
and stopped clearing the footer's wrap cache with identical text.

Full `pnpm bench:stream:check`, host load 3.2–3.6 on 11 cores, build of this change:

| Scenario                |      Standalone p95 |     Attached p95 |
| ----------------------- | ------------------: | ---------------: |
| Normal                  |            29.16 ms |         27.73 ms |
| Burst 100 / 1,000       |    30.26 / 31.25 ms | 29.23 / 30.27 ms |
| Long Markdown           | **33.38 ms (fail)** |         32.16 ms |
| 10,000 history          |            25.90 ms |         28.43 ms |
| Input during generation |             1.15 ms |          1.03 ms |

**Standalone long Markdown still misses 33 ms by 0.38 ms.** Excluding each run's
first marker, its p95 is 28.63 ms, matching the normal stream (28.65 ms). The three
samples above the budget are the first marker of each run (62.4, 45.6, 60.3 ms):
the fixture sends its 12 KB prefix at time zero in a fresh process, and the first
frame pays one-time initialisation in pi-tui text width — V8 compiling
`/^\p{RGI_Emoji}$/v` and ICU's first non-ASCII segmentation (≈18 ms emoji, ≈10 ms
CJK, ≈35 ms for the first 12 KB frame cold vs 4–5 ms warm). Warming that code is
possible, but the startup gate types immediately after the first frame and a run-start
warm-up mostly moves the same one-time cost; it is left as an open decision rather
than tuned against the benchmark. Report: `artifacts/slimming-20261026/stream-after.json`
(not committed).

## Submit-time text-shaping warm-up — 2026-10-26

`warmTextShaping()` renders one small CJK/emoji Markdown sample once per process
(~24 ms) when the user submits a prompt or command, before it is dispatched. A first
variant warmed on `run.start` instead: the stream gate passed, but attached first
markers regressed (plain burst1000 ~27 → ~47 ms) because the host is already
streaming when the client sees `run.start`, so that variant was not kept.

Full `pnpm bench:stream:check` with the submit-time warm-up, host load ~2.1–2.6,
report status `passed` (`artifacts/slimming-20261026/stream-warm-submit.json`):

| Scenario                |   Standalone p95 |     Attached p95 |
| ----------------------- | ---------------: | ---------------: |
| Normal                  |         26.43 ms |         27.83 ms |
| Burst 100 / 1,000       | 28.33 / 27.24 ms | 27.70 / 28.89 ms |
| Long Markdown           |         30.10 ms |         29.04 ms |
| 10,000 history          |         24.67 ms |         24.80 ms |
| Input during generation |          1.00 ms |          2.68 ms |

Each run's first marker is no worse than before in any cell: long Markdown
45–62 → 30–34 ms standalone and ~57 → 27–29 ms attached.

The startup gate (`pnpm bench:check`) was attempted afterwards, but an independently
started iOS simulator raised load from 17 to 104 during the run (p95 1,003 ms startup,
17.25 ms input; invalid). The startup driver never submits, so the warm-up path does
not run there, but **P4 stays open until both gates pass on a quiet host.**

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
