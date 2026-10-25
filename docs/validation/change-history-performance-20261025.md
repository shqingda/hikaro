# Change history reads — 2026-10-25

Source baseline: `d7af2ed`. macOS arm64, Node 26.12.1; source modules and the existing native secure-file helper. No network or model calls. These are local synthetic measurements, not release-package or device acceptance.

Reproduce with `node --import tsx scripts/bench-change-history.mjs`. The script creates fresh metadata, warms one complete read, measures three reads using the same fixture, and removes its temporary directory. The fixture contains 500 journal records, 500 observations (250 exact call/path/hash matches), and 20 coverage files. Each complete review must return 750 records and 20 warnings. A separate in-memory fixture isolates the matching cost of 5,000 journal records and 5,000 observations, with 2,500 exact matches; it warms once and measures five times.

| Operation         | Before median (ms) | After median (ms) |
| ----------------- | -----------------: | ----------------: |
| Journal list      |            870.730 |            62.154 |
| Observation list  |           1044.908 |            67.596 |
| Coverage warnings |             43.228 |             4.752 |
| Complete review   |           1945.579 |           141.298 |
| Isolated matching |            125.686 |             5.226 |

Complete-review samples: before `[1945.579, 1875.167, 1993.214]`; batching only `[147.816, 136.498, 129.145]`; batching plus Set `[141.298, 146.763, 124.682]`. The matching change is not distinguishable in this smaller disk fixture; its isolated 5,000-record samples changed from `[125.752, 125.686, 127.613, 124.815, 124.515]` to `[7.877, 6.262, 5.226, 5.198, 4.728]`. Retain both measured improvements. No pagination cache, persistent index, or Agent eviction was introduced.

History metadata now shares at most 100 paths per native helper process, keeping the original 64 KiB record and 8 KiB coverage limits. Every read still validates UUIDs, schema and identity; symlinks, oversized files, parse failures and incomplete helper responses reject the whole list. Detail and rollback continue to read and verify snapshots afresh. Matching uses an exact JSON tuple of call ID, path, before hash and after hash, including parent-call matches and empty call IDs.

Regression evidence: the new resource-budget tests failed against the baseline with 201/201/100 native launches for journal/observations/coverage; each now stays within five launches. Injected partial batch failures reject the entire list. Damaged metadata, missing identity, linked files, size limits, fresh subsequent reads and exact matching are covered by the focused history tests. The wall-clock values are measurements, not brittle CI timing limits.
