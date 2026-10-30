# Task workbench · 2026-10-30

Implementation: `90489d8`, following [the approved contract](../specs/task-workbench.md). No public release or push.

## Delivered

- `packages/cli` replaces `apps/cli`; binary and installation paths remain compatible.
- Official forge 1.4.2 replaces the installed backport. Historical patch material is archival only.
- Session navigation, five workspace views, object readers, actions and independent input/queue controls.
- Up to eight native/attached session handles, background attention, durable drafts, run-bound intervention and cancellation.
- Models/Providers center and capability-aware Pi adapters, using the host's single TUI/Markdown instance.

## Verification and limits

TypeScript, build, focused behavior/PTY checks and real installed Pi smoke passed. Script tests: 25 passed. Relevant checks cover background approvals, run identity, attachment intent, focus restoration, history streaming, auth cancellation, queue operations and existing file rollback boundaries.

The existing release chain passed once on the final implementation: packaging, all 15 release checks, installation, clean source installation and installation with lifecycle scripts disabled. Official forge integrity and signature/DER/PEM Buffer checks passed. Candidate SHA-256: `02ad67500bf56e9bdcdefed3dbf92b4235e928f2ff27177487c865eb7269d64d`. Packaged audits report zero vulnerabilities; the root audit retains one `qs` moderate finding and zero high/critical findings. See [forge verification](forge-official-20261030.md).

Existing performance gates passed sequentially on `90489d8`, without other builds/tests and without changing budgets. Native startup p95: 173.09 ms; attached: 176.86 ms (200 ms advisory). Input p95: 1.30/1.25 ms (16 ms gate). Streaming passed all native/attached scenarios; worst stream p95: 23.82 ms (33 ms gate), interaction p95: 1.83 ms. Startup used 30 measured runs/3 warmups; streaming used 3/1. Raw local reports remain in `artifacts/benchmark{,-shared-host,-stream}.json`.

`pnpm check` was executed repeatedly. The remaining full-suite issue is the existing `foreground-process-boundary` natural-exit observation timing test: it passes alone but failed under full-suite load. Its original test, timeouts and assertions were restored; no skip, weakened gate or concurrency setting was introduced. Two completion fixtures were adjusted to give the editor actual focus, and passed their focused rerun. A completely green final full-suite run is **not** claimed.

[Capture notes](task-workbench-20261030/CAPTURE-NOTES.md) distinguish the 24 production PTY captures from 90 component cases. Only representative images are retained. Capture records predate the final cosmetic cursor/neutral-color fixes. These are automated terminal-cell recordings, not manual IME/selection acceptance. The earlier Terminal access denial was respected; native IME candidate windows, physical mouse selection and terminal transparency remain unverified.

## Work log

1. Moved CLI paths and verified build/type compatibility (`e5c8e31`).
2. Replaced forge backport with official integrity verification and retained security behavior checks (`36d73d3`).
3. Bound steering/cancellation to the observed run, preserving legacy clients (`f37e439`).
4. Implemented workspace UI and per-session adapters; retained existing protocol/storage and Pi boundaries (`90489d8`).
5. Fixed observed interaction defects, adapted existing PTY workflows, and stopped expanding validation at the user's request. Unrelated process-observation investigation was reverted.

The requested ub-mode was applied during final convergence. No crapper/dryer/mutator tools were available; no replacement toolchain was introduced. Existing no-publish instructions were retained.

## Input hierarchy correction

After reviewing the user's terminal screenshot, moved Pi completion rows above the composer and reordered the existing mouse-coordinate mapping alongside them. Navigation now reserves the Beam selection background for keyboard focus; removed zero status counts, redundant Ready labels, repeated Actions hints and verbose empty-state instructions. No new component or dependency.

Updated the existing completion-click regression: it failed before the fix and passed afterward, including draft/cursor preservation and no accidental submission. The ten editor tests, typecheck and build passed. Physical IME/mouse acceptance remains unverified. Applied ub-mode subtraction and apple-design spatial grouping; no animations or extra test matrix.

## Quiet default workspace

Reviewed Grok Build's `views/welcome/top_bar.rs`: location metadata is one compact line. Applied that hierarchy to Hikaro rather than importing its renderer. Session navigation now opens explicitly instead of consuming a permanent column; the current view stays visible while the full tab selector appears on focus. Added a blank row between navigation and content, and suppressed the placeholder New session in the header. Existing F6, mouse view switching and session controls remain available. Two relevant suites (13 checks), typecheck and build passed; no expanded matrix or manual terminal claim.
