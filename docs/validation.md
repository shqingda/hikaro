# Validation status

## M0 native read-only companion: 2026-10-18

M0 now implements reviewed QR/manual pairing, pinned encrypted connection, SecureStore credentials, bounded SQLite WAL/FULL intent metadata, granted-task pagination and read-only history/active-output restoration. The mobile controller has no prompt, approval or cancellation transport escape hatch. Session selection is durably journaled and never automatically replayed. Background releases the connection and hides content; revoked/invalid identities lock the view and erase credentials and intent metadata. Credential commits, journal writes and deletion are serialized, with lifecycle epochs fencing stale results, including a reproduced late-selection-error/revocation race.

Necessary evidence:

- Four controller tests cover review before enrollment, secret-free public state, read-only methods, bounded history, background/secure-load races, expired QR versus persisted identity, terminal revocation and stale selection errors. The real shared Runtime/SQLite plus encrypted adapter case verifies grants, lost selection acknowledgment, no replay, recreated client, host restart and revoked view clearing.
- The existing Cloudflare Miniflare relay test now exercises authenticated device-status, wrong token, pending confirmation, online host and actual revoke returning 401. Authenticated status responses explicitly use `Cache-Control: no-store`, guarded by a reproduced red/green regression, so cached status cannot mask revocation. Existing client/protocol/TUI/shared-host tests pass: the focused 8-file run contains 49 tests; the subsequent shared-host/handshake run contains 9. Three tooling tests prevent cross-project Metro or unrelated-preview takeover and verify safe reuse. No full suite or duplicate UI snapshot tests were added.
- Expo 58 / React Native 0.88 iOS development build compiled and installed successfully. Through serve-sim 0.1.48 in the Codex browser, a disposable iOS 27.0 simulator imported a temporary pairing via its native secure field, reviewed identity, saved credentials, established real loopback TLS/WebSocket encryption through the actual relay and host bridge, and displayed the granted synthetic task and history. Background return and terminating/reopening the app restored the saved host and selected task. After the fixture invalidated that enrollment, foreground status probing produced the locked/cleared view. This last check is invalid enrollment after fixture reset, not a claim of production device-revoke delivery.
- Native SQLite inspection confirmed WAL, one installation marker and a bounded intent row with no token/private key/pairing URI. Temporary credentials, CA and the disposable simulator were removed. The user's normal simulator was preserved. [Native evidence](design/mobile-m0/README.md).
- Repository, mobile, relay and no-Node/no-DOM client-core typechecks; iOS/Android production Hermes JS export; dependency compatibility and peer checks pass. Expo Go was tried first but lacked native modules in this environment; the successful native evidence uses a local development build. The preview's direct touch and key input were verified; browser bulk paste did not forward, so native secure-field input used individual ASCII key events.

Real-device camera QR decoding, Android native runtime, physical network/lock-screen lifecycle, release performance and 30-minute stability remain open. The injected simulator camera displayed a QR feed but did not establish successful barcode decoding; it is not counted as scanner acceptance. No production relay deployment, external model request, signing or store release occurred. M0 requires the updated relay device-status endpoint; see [mobile setup](mobile.md).

The latest original 200 ms startup gate is **not passed**: final same-graph standalone 230.86 ms / attached 203.82 ms. Input and RSS gates pass; shared host + TUI RSS p95 falls from 126.39 to 124.78 MiB in the fresh comparison. All runs, including earlier passing and failing results, are retained. See [performance evidence](harness-performance.md); M0 functional verification does not close performance acceptance.

Dependency audit reports three upstream development-tool advisories: uuid through Expo's Xcode tooling ([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)), node-forge through Expo CLI ([GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)), and braces through Metro's file matcher ([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)). They are not imported into the mobile credential/transport runtime. The audit supplies no patched release for the latter two; uuid's available major update requires upstream compatibility work. No advisories were ignored or force-overridden. This remains a development prototype, with release acceptance open.

## H1 shared task host and recoverable views: 2026-10-18

Implemented `--host`, `--attach` and a `--serve` bridge to that same Runtime. Canonical workspace/home ownership is elected transactionally; private Unix socket credentials enforce local/device scope injection. Per-session view/control grants and selection are durable. Only authorized control participants viewing the session receive its approvals; the host rechecks the request at decision time. Revocation removes a device's own queued/active work without canceling another owner's run. Replaced view identities stop reconnecting rather than fighting for the socket. See [startup, grants and recovery](shared-host.md).

The attached TUI commits ID/method intent metadata before sending, keeps drafts per view, and restores snapshots/receipts without replay. An injected portable `IntentStore` supports the same contract on future native clients; actual native storage/UI remains M0.

Necessary verification, without a full suite:

- One real two-connection SQLite case covers single-host election, wrong-owner release, workspace/scope access, filtered listing and persisted selection/revocation. Its first-open failure exposed SQLite journal-mode BUSY outside the busy handler; only that initialization has a bounded retry, with WAL/FULL retained.
- `tests/shared-host.test.ts`: **4 real integration cases**. Unix socket + Runtime + SQLite + encrypted adapter cover denied foreign access, view/control grants, shared run ID, approval races, revoked membership, dropped replies and offline device revocation. A device's queued prompt cannot cancel the local owner's pending run. A recreated view recovers durable intent, and a separately spawned host is SIGKILLed/restarted: its original selection/run ID return as unknown; persisted run.start count proves no replay. Invalid credentials and insecure metadata fail closed. Reusing a view identity fences the older channel. The delegated-task case retains the real child session ID while validating decisions against live root-task authority; arbitrary fork lineage does not receive that delegation mapping.
- The real PTY case exits with an approval open, reattaches to the same request, receives another view's decision, then restores an unsent multilingual draft after SIGKILL. Its initial timeout exposed Ctrl+D being swallowed by the approval panel; attached views now explicitly detach before panel input handling, with no denial sent to the host.
- The portable connection case holds an intent commit across a new connection epoch and proves the old mutation is never sent. The affected core/client/RPC/lease/library selection passed **9 files / 61 tests**; subsequent adapter/scope checks passed **5 files / 13 tests**, and the later host/TUI/bridge change passed **2 files / 6 tests**. Final control/Runtime review added a deterministic stalled-receipt/resume race: it first reproduced cancellation of a view-only replacement session, then passed after post-acceptance selection/control fencing. The final host/control/handshake run passed **3 files / 28 tests**, including the real delegated tool approval. Repository and portable typechecks passed after these changes. Counts overlap; they are not a full-suite total.
- Repository typecheck, no-Node/no-DOM portable typecheck, production build and diff check passed. No deployment, physical mobile device or external provider was used; relay sockets/provider output in the new shared-run case are deterministic fixtures.

Sequential final startup measurements at `30c4697`: original independent TUI **164.67 ms startup p95 / 1.268 ms input / 70.80 MiB RSS**, attached TUI **175.03 ms / 1.080 ms / 59.88 MiB**; 30 measured launches and 3 warmups each. Original thresholds and unchanged 10k core/storage assertions pass (the 10k run is at `0881c95`, with unchanged core/storage execution paths afterward). Shared host RSS is separately **66.25 MiB** and host + TUI combined RSS p95 **126.00 MiB** (excluding relay bridge / external tools), exceeding the old single-process footprint; the new view's RSS pass is not a combined-memory pass. Exact graph fingerprint, raw reports and limits are in [the performance ledger](harness-performance.md).

Native mobile UI, secure storage integration, real network/background/kill/revocation behavior, cold host startup budget, combined-memory optimization and the full independent TUI command surface remain subsequent work. H1 does not change the existing lifetime-only cost budgets or make already executed file effects reversible.

## TUI/mobile direction and shared client APIs: 2026-10-18

The confirmed product direction is TUI plus a mobile companion for viewing, approval, steering and cancellation. Product scope and dependencies are recorded in the [TUI/mobile plan](tui-mobile-direction.md). Only standalone phone layout references are retained. No native mobile app or service deployment is claimed.

Shared work retained: ordered remote raw frames and a portable connection controller; session metadata/search, model and draft APIs; bounded message/image/tool-call content, paged Markdown export and restricted native-helper artifact reads. An invalidation arriving after a snapshot's watermark is buffered and forces a new snapshot rather than reopening actions against stale metadata. Model endpoints remain host-configured and are omitted from session projections.

Verification on macOS arm64 / Node 26.12.0 / pnpm 12.11.2:

- Client-state/connection, local+encrypted-remote fixture, library, RPC controls/handshake/scopes/receipts and remote-host controls: **9 files, 50 tests passed**. The fixture uses the real spawned CLI and SQLite, with an in-process encrypted socket instead of a production relay. It covers duplicate/gap notifications, a lost prompt response, reconnect without replay, durable receipt reconciliation and 65 additional settled draft writes without exhausting unresolved-intent capacity.
- The later compatibility/isolation adjustment passed **2 files, 3 tests**, overlapping the above selection: older hosts without receipt queries still return successful mutations, and a broken state listener does not break the protocol. Typecheck and the no-Node/no-DOM portable import check passed after that adjustment.
- Large multilingual history, base64 image ranges, complete paged text export, provider-payload exclusion, artifact change detection and symlink denial have focused coverage. An initial artifact read failed on macOS's symlinked temporary-directory ancestor; the fix canonicalizes only the trusted home and retains the helper's no-symlink walk below it.
- `pnpm build`, install/lockfile cleanup and `git diff --check` passed. No full suite or new mobile platform tests were added.

Final TUI startup gate: **30 measured launches + 3 warmups**, fresh V8 cache and data home per launch; startup p95 **174.02 ms**, input p95 **1.765 ms**, ready RSS p95 **70.86 MiB**. All original thresholds pass. Raw report: `artifacts/benchmark-tui-mobile-final.json`, graph SHA-256 `ce18b7f2c605f17c73fe9f7c50c35837680a5e702ce26654ffa603a9cc1257d0`. The 10k storage/core gate also passes unchanged (`artifacts/benchmark-harness-tui-mobile-direction.json`). The earlier 178.12 ms startup observation (`artifacts/benchmark-tui-mobile-direction.json`) overlapped briefly with the harness driver and is retained. The final startup run followed formatting of the distributed worker and a rebuild, and ran separately; it is not a selected subset of the first report. No 30-minute soak, native mobile/network acceptance or summary-quality claim follows from these measurements.

The attachment/IPC/approval/local-intent gaps recorded at this stage were subsequently implemented in H1 above. Native device storage, UI and lifecycle verification remain pending.

## Context, session recovery and performance: 2026-10-18

Implemented complete-request context accounting, conservative token estimation, whole-turn trimming, output reserves aligned with the Pi adapter, and source-aware bounded manual summaries. Oversized requests fail before consuming a model call. A synchronized regression caught and fixed concurrent child agents spending the same final shared call. Automatic compaction, exact tokenizer accounting and cross-restart budgets remain pending.

The session picker now searches all current-workspace titles and IDs with bounded pages, Unicode case folding and stale-result suppression. Draft edits schedule a coalesced save after 300 ms without indefinitely postponing continuous input; writes and submission clears are serialized. Expanded paste text is retained; transient dialog answers are excluded. Independent review found and fixed an empty-flush microtask race and same-session model/settings rebind overwriting newer typing. Completed saves survive process termination; pending input/write windows and in-memory prompt queues do not gain transactional recovery.

Verification on macOS arm64, Node 26.12.0 / pnpm 12.11.2:

- Context/core/model-settings/provider/session-settings/runtime-lifecycle: **6 files, 80 tests passed** after context changes. Fifteen new context tests cover complete overhead, default built-in tools with skill metadata, quota contention, provenance and multilingual/escaped summary chunking. Deliberately inverting the overflow comparison through a temporary test transform caused 13 failures; restoring the normal transform returned all 15 to green.
- `tests/session-search.test.ts`: **4 passed**, including a target beyond page one, paging filtered results, literal wildcard characters, workspace isolation, Unicode case folding and superseded queries. The initial implementation failed the new behavior tests as expected; one existing pagination shortcut test was updated to navigate to the page action with arrow keys because typing now searches session data.
- Final draft-recovery/session-settings/real draft-recovery PTY selection: **26 passed**. Six draft unit/integration cases plus one actual CLI scenario cover SIGKILL, reconnecting to the saved demo session, restored input and clearing after submission. This count overlaps session-settings in the 80-test selection above; it is not an additional independent total.
- Final TUI interaction/performance-harness/performance-startup selection: **3 files, 19 passed**. Includes expanded paste, transient dialogs, search/menu compatibility, benchmark parameter/measurement/cleanup guards and lazy SDK loading.
- Final `pnpm typecheck`, `pnpm build` and `git diff --check`: passed. `pnpm start` build artifacts updated. No full suite, production model, hosted CI or native mobile acceptance was claimed.

Performance: lazy provider SDK loading reduced the 30-run offline startup p50 **291.64 → 229.37 ms**, p95 **405.24 → 324.81 ms**, and ready RSS p95 **96.70 → 81.39 MiB**. Input echo p95 was **3.26 ms**. The **200 ms startup target remains unmet**; the benchmark preserves it and reports failure. Fixed 10k storage/core workload budgets passed, including lossless live and persisted text checks. See [harness-performance.md](harness-performance.md) for raw report locations, workload details, retained/rejected experiments and remaining measurements. Real provider startup and 30-minute stability were not measured.

[Static mobile layout references](design/mobile-controller/README.md) are design artifacts, not released clients. They do not prove native lifecycle, secure storage, production connectivity or performance. The brand candidate is separate from `brand/identity` and still requires final small-size optical work.

## Approval panel: 2026-10-17

Native TUI approvals now use a fixed panel above the editor instead of requiring typed `allow`. The panel shows the tool, file target or shell command, and request reason. Arrow keys choose Allow once / Deny; Enter confirms; Esc or Ctrl+C denies. PgUp/PgDn scroll long details. The editor retains its text and cursor while the panel owns focus. Aborting, rebinding or disposing resolves the pending decision once. Initial Enter is ignored for 500 ms unless the user has navigated the choices; insufficient space prevents approval and asks for a resize. Permission policy and RPC/Pi protocols are unchanged; session grants are not implemented.

Completed checks on macOS, Node 26.12.0 / pnpm 12.11.2:

- Before implementation, the new panel tests failed against the typed-allow UI; the ordinary workspace README read assertion already passed.
- `pnpm exec vitest run tests/approval-panel.test.ts tests/permissions.test.ts tests/tui-interactions.test.ts -t 'TUI approval panel|permissions|activity indicator animates|TUI immediate cancellation feedback'`: **16 passed**, 8 excluded by filter. Covers selection, Enter guard, cancellation, draft/focus restoration, scrolling, resize behavior and existing permission policy. The auto-mode case explicitly reads workspace `README.md` with no manual approval call.
- `pnpm exec vitest run tests/pty.test.ts -t 'TUI approval panel'`: **1 passed**, 6 excluded by filter. Actual CLI, isolated workspace/home, no production account: denied shell operation leaves no file; allowed operation writes the expected file. Controls remain visible through 36×18, 60×18 and 100×24 resize events. No typed `allow` is sent.
- Focused strict TypeScript checking of the changed TUI source and panel test passed. The initial standalone check omitted the project's Node types and found a readonly test-fixture annotation; rerunning with explicit `--types node` after correcting that fixture passed. Only the affected panel tests were rerun: **8 passed**.
- `pnpm build`: passed; `pnpm start` output updated. A batched full-layout render at 36×18, 60×18 and 100×24 confirmed the panel, editor draft and permission status fit together.

No full suite or performance benchmark ran. The user restarted in their Codex sidebar terminal and confirmed the prior conversation and Approve for me mode were preserved. Their manual check confirmed the command/reason and Allow once / Deny were visible; Allow once closed the panel, produced the expected output and restored input; Esc produced Permission denied with no execution output and restored input. Native Terminal and IME acceptance remain pending.

Pre-merge verification on 2026-10-17: `pnpm typecheck`, the same focused test filter across the four files above (**18 passed**, 13 excluded), and `pnpm build` passed. One review of the implementation, tests and documentation found no blocking correctness, security, architecture or performance issues. No full suite or benchmark was added to this verification.

## Directory-replacement race repair: 2026-10-16

Replaced pathname-based content IO with a small POSIX helper that retains opened directory descriptors. Reads reject symlink components introduced after canonical authorization. File snapshots, exclusive locks, staging, version checks, atomic commit and cleanup use the same pinned directory; the TypeScript cancellation/lease checkpoint remains between staging and commit. Search and index content reads also use this service. Source install/build compiles the helper and the CLI bundle includes it.

The original path-only implementation failed six deterministic regressions: replacement, creation, editing, reading, and two commit/cleanup cases. Tests use a separate Node process to rename the checked directory and replace its old name with an outside symlink, paused at actual approval or commit boundaries. The final suite adds ten path-race cases, including search, indexing, cached retrieval and ordinary-file behavior, plus seven helper protocol cases for byte framing, symlinks, FIFO/size limits, cancellation, rejected checkpoints, leaf replacement and caller EOF. Existing conflict/lease regressions now use the commit checkpoint rather than an obsolete host `stat()` interception.

Completed verification: `pnpm check` passed **27 files / 187 tests**, TypeScript checking and build on macOS with Node 26.12.0 / pnpm 12.11.2. Relay type checking passed. Deliberately removing directory `O_NOFOLLOW` flags made four approval-race regressions fail; the original source/binary were restored and all 17 new tests passed afterward. This confirms the tests exercise the directory-resolution boundary. A separate review also exercised directory replacement during commit and repeated cancellation cleanup. The actual bundled CLI completed a `read_file` call against a temporary workspace through a loopback-only model fixture, confirming it loads the helper from `dist`; no production service or credentials were used. GitHub Linux/macOS jobs have been updated for native compilation; hosted CI has not been run from this local branch.

## Referenced code-review fixes: 2026-10-16

Applied the review of `c3ffcb49121427b50a0cc6eb533de6e598474857` on top of `2906efd`, retaining and checking its existing file-queue/context-history fixes. All seven concrete findings now have regression coverage: Git control-file/process boundaries, resource authorization for search/index reads, conflicting file updates, child/job initialization cancellation, child concurrency reservations, responsive RPC control and exact-endpoint authentication. CI now runs on PRs and pushes to main, with Linux checks and a separate full macOS job.

Additional cross-tool and fault-injection review covered Git clean filters reading sensitive files, detached device revocation, remote forwarding of `baseUrl`, old lease epochs, renewal while waiting on a SQLite writer lock, approval-to-execution ownership loss, file-commit ownership loss, terminal initialization cancellation, and descendants surviving a cancelled process leader. RPC compaction now uses the v2 asynchronous operation contract documented in [architecture.md](architecture.md).

Validation completed on macOS with Node 26.12.0 / pnpm 12.11.2:

- `pnpm check`: **25 files, 170 tests passed**, plus full TypeScript checking and build. This includes the real macOS sandbox, independent-process file coordination, real SQLite connections, loopback HTTP authentication, RPC subprocesses and PTY tests.
- `pnpm check:relay`: passed.
- Built CLI offline prompt smoke: passed.
- Changed-source formatting and `git diff --check`: passed.
- Deliberately removing the exclusive file-lock flag made the independent-process regression fail; the original implementation was restored. Cancellation, initialization, lease and authentication tests were also observed failing before their fixes.

No production API, actual Keychain sign-in, Cloudflare deployment or live handset acceptance ran. GitHub-hosted CI was configured but not dispatched from this local branch. File locks coordinate cooperating file tools and can remain after a crash; already-started process effects are not made transactional by SQLite fencing. The later directory-replacement repair is recorded above. Third-party plugins remain trusted. Runtime initialization/close limits, Agent-lifetime budgets and continuation-persistence boundaries are explicit in [architecture.md](architecture.md).

Updated: 2026-10-15. Implementation, test coverage, completed verification and pending acceptance are separate states. See [TODO.md](../TODO.md) for delivery order. Documentation and styling edits have no independent tests or benchmarks. Critical TUI workflow verification is recorded below.

## Final cancellation review before push: 2026-10-15

Reviewed cancellation propagation, immediate panel closure, stale panel cleanup, draft/focus restoration and dialog status updates. The review found one remaining boundary: a provider could return a final result after cancellation and incorrectly produce a completed run. Prompt and compaction now check cancellation before committing completion. Catch paths reuse `throwIfAborted()` instead of constructing duplicate cancellation errors. New regression cases cover both late-result paths and confirm that a later prompt can complete.

`pnpm exec vitest run tests/core.test.ts -t 'cancel|manual tool|atomic tool registration|rolls back registrations'` ran once: **7 passed**, 12 excluded by filter. The affected view cases ran once with `pnpm exec vitest run tests/tui-interactions.test.ts -t 'TUI immediate cancellation feedback|keeps the current permission mode'`: **5 passed**, 7 excluded by filter. The view tests now share a complete typed `Terminal` stub, replacing two incomplete assertions. Strict TypeScript checking of explicit core/TUI/MCP source and test paths passed after that fixture correction. No full suite or repeated PTY E2E ran in this review; the earlier PTY evidence remains recorded below.

## Live PTY acceptance: 2026-10-15

Ran the actual CLI in isolated `node-pty` processes at **36×18**, **60×18** and **100×24**, using keyboard bytes and real terminal resize events. A loopback-only SSE fixture held model responses open for streaming and cancellation. No production account or external model service was used. One batched inspection and one confirmation pass produced **21 screen frames**, with no frame exceeding its terminal dimensions. The frames come from `TuiAltScreen.getScreenLines()` after terminal writes; they are not native terminal screenshots.

Verified settings navigation, consecutive saves with stable selection, wrapped Startup values and permission descriptions, model search, session rename cancellation, Enter/Esc hints, Unicode/emoji, draft retention, stream resize and Ctrl+C cancellation. A real `!sleep 30` displayed `Running shell` and stopped on Ctrl+C. The indicator stopped on cancellation. Both manual PTYs exited with code 0 and restored the alternate screen.

Three corrections followed the inspection:

- Cancelled streams previously displayed both `Stopped` and a red `Request was aborted`. The core now reports cancelled operations as `AbortError`; the view keeps cancellation quiet while retaining actual errors.
- Cancelling a loading panel now closes it and restores editor focus immediately. A held catalog lookup confirmed that typing resumes before the lookup finishes. Its later cleanup cannot close a newer panel.
- Dismissing an extension input dialog now refreshes status before awaiting its backend response. A targeted regression case covers the delayed response.

Each verification command ran once, with no failure or repair retry:

```sh
pnpm exec vitest run tests/tui-interactions.test.ts tests/core.test.ts -t 'TUI |records cancellation|normalizes provider cancellation'
pnpm exec vitest run tests/pty.test.ts -t 'cancels the active stream and accepts a subsequent prompt'
```

Results: **14 targeted cases passed** (15 excluded by filter), plus **1 PTY E2E passed** (5 excluded by filter). The E2E covers narrow-menu keyboard flows, rename cancellation, streaming resize, draft retention, cancellation and a subsequent prompt. `node scripts/build.mjs` passed and refreshed the startup artifacts. No full suite, other E2E, benchmark or production-account check ran. Environment: macOS arm64, Node **26.11.1**, pnpm **12.11.2**.

Local evidence is saved under ignored `artifacts/terminal-acceptance-2026-10-15/`: `manifest.json`, frame JSON/text files, and raw before/after ANSI streams. The manifest records dimensions and fullscreen restoration. The PTY E2E asserts workflow output; the separate saved-frame inspection checks row counts and cell widths.

Native macOS Terminal control was unavailable under the computer-use policy. Native font rendering, color appearance, IME composition, physical keyboard modifier handling and assistive technology remain unverified. Programmatic Unicode input does not establish IME support.

## TUI simplification verification: 2026-10-15

Shared selection completion in `ModelPanel` and terminal text sanitization across the message view and picker. The existing `sanitize` export remains available from the TUI entry point. Control-character filtering, selection result fields and pending-state clearing order are preserved.

Workspace: `/Users/shqingda/Projects/hikaro`, macOS, Node **26.11.1**, installed local Vitest. Each command below ran once for its corresponding code increment.

| Command / filter                                                                                                                                                                                                                                     | Result                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `vitest run tests/tui-interactions.test.ts`                                                                                                                                                                                                          | 5 passed after selection completion extraction                     |
| `vitest run tests/tui-text.test.ts tests/tui-interactions.test.ts tests/model-settings.test.ts -t 'sanitizes terminal text\|cleans picker labels\|TUI shortcut capabilities\|TUI interaction fixes\|uses a full-width brand-tinted user background'` | 12 passed, 4 excluded by filter after text sanitization extraction |
| `vitest run tests/pty.test.ts -t 'searches session titles and preserves settings focus with a persistent permission mode'`                                                                                                                           | 1 E2E passed, 5 excluded by filter                                 |

The E2E used an isolated profile and a real PTY. It verified session title search, selection, consecutive settings toggles, hidden usage, permission display and persisted settings. Other E2E scenarios were reviewed and retained: message isolation during session switching, stream cancellation, compaction, tool permissions/activity, terminal lifecycle/Unicode and provider authentication navigation cover distinct integration risks.

Targeted formatting and diff whitespace checks passed. No full suite, build, benchmark or Pi smoke test ran for this refactor. These results do not establish that every E2E passes.

## Current delivery scope

- Independent agent core, fullscreen TUI and bidirectional Pi integration. Hikaro does not adopt Pi's agent loop.
- The native mobile app is not shipped. Mobile release, notification, store and performance acceptance have their own stages.
- Cloud configuration remains optional. Configuration sync is not implemented; sync, distribution and remote connection scope still needs a decision.
- Native provider PTC, automatic cross-provider fallback, advanced plugin UI, browser/index expansion and generic executable Pi extension adaptation remain optional. They are not core TUI acceptance gates.

## Historical measurements

The existing local `artifacts/benchmark.json` records the following values. It is an ignored artifact, not a versioned report; it contains no measurement date or commit. These values do not confirm current-version performance.

| Metric          | Historical value |
| --------------- | ---------------- |
| TUI ready p50   | 124.39 ms        |
| TUI ready p95   | 148.49 ms        |
| Process RSS p95 | 90.59 MiB        |

The JSON records Node **24.21.0**, **30** launches, warm OS caches and the default Anthropic catalog loaded without a model request. Earlier notes identify the host as an Apple M3 Pro / 18 GiB Mac; hardware is not recorded in the JSON. RSS includes the SQLite worker and excludes external tools. No active coding workload, live model request, browser, index, MCP server or child agent was measured.

The previous documentation's p50 **121 ms** and p95 **124 ms** do not match the available raw artifact. They have been replaced by the artifact values, rather than treated as a separate verified run. Recent changes have not been remeasured.

`scripts/bench.mjs` writes `artifacts/benchmark.json`. Its default mode is offline demo; `HIKARO_BENCH_LIVE=1` loads the configured default provider catalog. Benchmarks require a separate plan for a concrete bottleneck and are not part of documentation verification.

## Performance targets: not completed measurements

| Metric                                 | Target                                              |
| -------------------------------------- | --------------------------------------------------- |
| Startup to input ready                 | p95 ≤200 ms                                         |
| Input to refresh                       | p95 ≤16 ms                                          |
| Streaming increment to terminal output | p95 ≤33 ms, excluding model network latency         |
| Total idle RSS                         | ≤100 MiB, including storage worker and one provider |
| Steady-state memory                    | ≤10% growth over 30 minutes after warm-up           |

Input latency, streaming latency, 10,000-event sessions, sustained 100/1,000-chunk bursts, scrolling during generation and steady-state memory still require acceptance. Record Pi, MCP, tool and optional index overhead separately and report total overhead under the same conditions.

## Existing automated coverage

The following describes existing tests and previously recorded coverage, not a fresh pass against the current worktree:

- Independent agent loop, tool validation/results, cancellation and command IDs.
- Filesystem path checks, concurrent edits and macOS shell sandbox restrictions.
- QuickJS isolation and host responsiveness during CPU-bound cancellation.
- SQLite event ordering, whole-message pagination, job claims and plugin rollback.
- Real Pi AI adapter against a local OpenAI-compatible SSE fixture; offline reasoning/speed request capture.
- Pi RPC completion, handled prompts, queue cancellation and confirmation responses.
- Pi 1.2 dedicated bridge entry, offline response and return to Pi via the existing isolated-profile smoke script.
- JSONL UTF-8 framing, size limits and independent RPC scopes.
- Model picker key-release handling, xAI authorization URL dispatch, conditional model controls and user-message backgrounds.
- PTY fullscreen entry, Unicode input, resize and terminal restoration. The original PTY scenario was not rerun; the new critical workflow results are recorded below.

Optional remote coverage remains separate: encryption identity checks, tampering, replay, reflection, reconnection, relay authorization/forwarding/activation/revocation and historical Cloudflare deployment dry-run. None establishes production acceptance of cloud configuration.

## Recorded targeted verification

These records are carried forward from the earlier TODO and were not rerun for this documentation update:

| Verification                                              | Recorded result                    | Limits                                                                                             |
| --------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| Session-related targeted checks                           | 9 passed, 6 skipped; one run       | Original record does not retain the full filter                                                    |
| `tests/session-settings.test.ts -t 'interactive startup'` | 4 passed, 15 skipped; build passed | Reran only after endpoint forwarding changed; no full suite, E2E or benchmark in that verification |

New implementation and verification results must record the affected path/filter, outcome and remaining acceptance work. A skipped case is not a pass.

## Current targeted verification: 2026-10-13

Workspace: Hikaro on macOS; Node **26.11.1**, pnpm **12.11.2**. The three new scenarios use a local SSE fixture and isolated profiles. No real account or external network was used.

| Run / filter in `tests/pty.test.ts`                                            | Result                        | Change before the next run                                                              |
| ------------------------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------- |
| `critical TUI workflows`, initial run                                          | 3 failed, 1 skipped           | Preseed A/B and pace fixture chunks to exercise incremental output                      |
| `critical TUI workflows`, repair cycle 1                                       | 2 passed, 1 failed, 1 skipped | Cancellation and compaction passed; use arrow selection for the session-switch scenario |
| `switches sessions through the picker without mixing messages`, repair cycle 2 | 1 passed, 3 skipped           | Session switching passed; no further test run                                           |

All three critical scenarios have passing results. The original fullscreen/Unicode/resize/exit scenario stayed skipped. No full suite, other E2E, build or benchmark ran. Documentation and search-field spacing changes did not trigger independent tests.

The failed title lookup exposed a pre-existing limitation: `SelectList.setFilter` matches internal `value` prefixes, which are session IDs, rather than visible titles. It was recorded in TODO and left unchanged in that run. Page-local visible-name filtering was subsequently fixed on 2026-10-14; cross-page and full-session search remain pending.

## Implemented minimal node-pty E2E

Status: **implemented, with passing results for all three scenarios**. The existing `tests/pty.test.ts` now includes a `critical TUI workflows` group containing only three scenarios:

| Scenario          | Interaction                                                                                 | Required evidence                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session switching | Preseed A/B; use `/sessions` and arrows to select B, then A; send a unique message          | Active session is A; message persists only in A; B history remains                                                                                              |
| Cancellation      | Local SSE emits a unique first chunk and holds the response; send Ctrl+C, then a new prompt | `Stopped`; CLI remains alive; response connection closes; persisted `cancelled` then `completed` run status in the same session                                 |
| Manual compaction | Seed a conversation with a constraint/path, invoke `/compact`, continue                     | New session parent and `context.compacted.source` point to the original; original history remains; subsequent request contains the fixed summary and new prompt |

Use a real CLI under `node-pty`, existing provider/model/base-url flags and a local `127.0.0.1` OpenAI-compatible SSE fixture. Each scenario gets isolated temporary home/workspace directories and starts with `--new`; the switching scenario also explicitly selects preseeded A with `--session`. No real account, external network, production API or test-only CLI switch is required.

Advance on fresh terminal output/request events, not fixed sleeps or old output. Check persistence after normal exit; always clean up PTY processes, held connections and temporary directories. Preserve bounded diagnostic output on failure. Detect cancellation from the response connection closing, not the request body finishing.

Implementation was preceded by `/plan` with these scenarios, the exact file/filter and environment requirements. The initial targeted command was:

```sh
pnpm exec vitest run tests/pty.test.ts -t 'critical TUI workflows'
```

The two permitted repair cycles are recorded above. Future changes to one workflow use its exact scenario filter once. This group checks manual `/compact` flow and data transfer. A fixed summary does not establish real-model summary quality, token reduction or automatic-compaction threshold correctness. Tool-process cancellation, IME and performance are separate acceptance work.

## Activity indicator and permissions: 2026-10-13

The native TUI now embeds an animated Working/Thinking/Running TOOL/Compacting label in the editor border. It pauses during approval/input waits and stops on completion, cancellation, binding and disposal. The animation does not refresh an idle editor.

`/permissions` offers Ask for approval, Approve for me and Full Access; there is no Read Only choice. Selection applies to existing agents and persists by canonical workspace under the selected home. Running agents block changes. Full Access routes shell/PTY tools to host execution, including network access. Existing processes retain their original access. Noninteractive/RPC hosts retain their prior policy; external Pi owns its permissions.

Approve for me uses conservative local rules without another model call. Ordinary workspace file operations and known literal read commands can pass. Sensitive file operations, shell expansion, unknown or unrestricted operations and unlisted approval requests ask. Snapshot/screenshot/close of an existing browser page can pass; other browser requests still ask. This does not change the trusted in-process plugin boundary.

| Targeted command                                                                                                                | Result                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run tests/permissions.test.ts tests/pty.test.ts -t 'permissions\|activity indicator'`                         | 4 passed, 1 E2E failed, 4 skipped; stale idle output caused the E2E to submit a command too early                          |
| After changing the output cursor: `pnpm exec vitest run tests/pty.test.ts -t 'permissions and activity indicator'`              | 1 passed, 4 skipped; picker, animated frames, actual external-file write, loopback network request and saved mode verified |
| After adding sensitive-read review: `pnpm exec vitest run tests/permissions.test.ts -t 'auto approves known workspace actions'` | 1 passed, 3 skipped; only the affected auto-approval case was rerun                                                        |

Environment: macOS, Node 26.11.1, pnpm 12.11.2. Other passing unit scenarios cover immediate changes in a cached agent, rejecting changes while busy, workspace isolation, invalid saved modes and animation cleanup/pause. No full suite, other E2E or benchmark ran. The earlier critical TUI scenarios remained filtered out; the manual-compaction assertion was updated to the new Compacting label. Live provider accounts and manual terminal review remain pending. `pnpm build` passed and refreshed the `pnpm start` artifacts. Discovered read-only Skill resources retain their existing read allowlist.

## TUI interaction fixes: 2026-10-14

The first three Impeccable priorities were implemented without changing the visual identity:

- Long lists match visible labels, descriptions and IDs, returning original IDs. Session search remains page-local and its empty message says so.
- Settings/permissions and other fixed short menus omit search. Generic lists of five or fewer items default to direct selection; model/session/provider lists explicitly retain search.
- Settings retain the selected item after each save, including the error path. Permission selection starts on the current mode.
- A dedicated permission status line remains visible even when usage is hidden. Full Access is labeled explicitly; the external Pi backend shows Managed by Pi.

Targeted command, run once:

```sh
pnpm exec vitest run tests/tui-interactions.test.ts tests/pty.test.ts -t 'TUI interaction fixes'
```

Result: **4 passed, 5 skipped**. Three regression cases cover label/description/ID matching and empty-search recovery, consecutive settings toggles without search, and a mode change with usage hidden. One real CLI/PTY case covers session-title selection, settings focus/persistence and visible permission updates. No real model request, full suite, other E2E or benchmark ran. Environment: macOS, Node 26.11.1, pnpm 12.11.2. `pnpm build` passed. The one Impeccable scan of six changed TUI files returned no findings; native-terminal rule coverage remains unestablished. This is not a visual or accessibility acceptance pass.

The remaining critique priorities, inaccurate Ctrl+S hints and narrow-terminal description/value loss, were deferred from this first pass and completed in the following pass. Production accounts, IME, assistive technology and current live-screen appearance still require manual acceptance.

## Shortcut hints and narrow terminals: 2026-10-14

Ctrl+S now requires an explicit capability for the selected item. Actual model choices and active model-setting values support applying and saving defaults. Provider/authentication steps, navigation choices and default-only settings neither advertise nor activate this shortcut. Enter hints describe the current action, including switching the model-setting scope.

Values and descriptions wrap instead of disappearing in narrow panels. The panel uses the terminal's available height, keeps the selected item visible, limits the number of visible choices and reserves confirmation/exit hints. Search retains a blank row before the choices. A panel with insufficient space shows a Resize message and retains Esc. Oversized selected descriptions explicitly request resizing rather than silently losing their tail.

The preceding `/plan` named this exact command. It ran once:

```sh
pnpm exec vitest run tests/tui-interactions.test.ts tests/session-settings.test.ts -t 'TUI shortcut capabilities|routes active, default, and Ctrl'
```

Result: **3 passed, 21 skipped**. Two new functional cases exercise the actual panel through provider/authentication/model choices and active/default settings; the existing settings-routing case verifies separate apply/save actions. No retries, layout tests, E2E, full suite or benchmark ran. Environment: macOS, Node 26.11.1, pnpm 12.11.2.

Manual inspection of rendered layout text at **36 columns × 18 rows**, **60 × 18** and **100 × 24** covered the Startup value, permission descriptions, a selected final model, search spacing and Enter/Esc hints. Inspection found unused room at the end of short lists; one repair batch corrected it, followed by one confirmation pass. This was not a live-terminal screenshot or assistive-technology review. Different content, drafts and errors can leave less room and require resizing.

`pnpm build` passed and refreshed the startup artifacts. One Impeccable scan of seven affected TUI source files reported no findings; native-terminal rule coverage remains unestablished. Real-terminal resize, IME and accessibility acceptance remain pending.

## File edits and model history regressions: 2026-10-16

File writes and edits now share a queue by canonical path across plugin instances in the host process. Each update reads inside the queue and rechecks the file version before saving. Stale replacements fail, and overlapping text matches are rejected. The queue is not a cross-process atomic file lock; external writers can still race after the final version check.

Model history has a separate bounded reader without the 1,000-message limit. Its 8 MiB capacity trims at user-turn boundaries and reports omitted messages together with subsequent context-budget trimming. An oversized current turn fails visibly rather than sending partial history. Persisted messages remain unchanged. This does not implement automatic compaction or complete token accounting.

Five initial regression cases failed on the original implementation. After the fixes, the final focused command passed **14 cases, with 14 unrelated cases filtered out**:

```sh
pnpm exec vitest run tests/core.test.ts -t 'overlapping edit|concurrent edits|concurrent replacements|file version changed|releases the file queue|complete model history|storage capacity|oversized current turn|prevents edits when expected text is ambiguous|denies external symlink reads|executes tool calls and returns|records cancellation and does not execute remaining tools|persists ordered events'
```

The nine new cases cover overlapping matches, concurrent edits across plugin instances and symlink aliases, stale concurrent replacements, external version changes, queue recovery after failure, more than 1,000 messages, storage-only and combined context omissions, and oversized current turns. The external-writer test needed two mock repairs for ESM export spying and recursive mock calls before it passed. Type checking passed with a temporary configuration extending the repository settings and including only the changed TypeScript files and `tests/core.test.ts`. Environment: macOS, Node 26.12.0, pnpm 12.11.2. No full suite, build, E2E, real model request or benchmark ran.

## Pending core and Pi acceptance

Follow the six stages in TODO. Required checks include:

- Real-project login, file read/write/edit/search, shell/test/Git, permission and failure recovery; explicit queue, steering, cancel and exit behavior.
- Production-account OAuth, refresh, rate limits and model/account thinking/speed capabilities. Unknown models retain default speed only; offline request capture does not establish account support.
- Production-model goal/constraint/path preservation after automatic compaction; deterministic checkpoint and draft recovery are covered below.
- Readable tool/code/diff output, message-body full-text search, OS clipboard image capture and portable attachment export. Native file/image references are covered below.
- Real-project MCP/Skills invocation, failure recovery and plugin resource cleanup.
- Both Pi directions under real accounts, long sessions, cancellation, permissions, recovery and failures; default-entry install/upgrade; version matrix, capability detection and visible degradation. Failures must not silently switch execution agents.
- Manual IME, wide characters, emoji, paste, resize, exit restoration and assistive-technology review. Existing PTY checks cannot replace real input-method testing.
- Crash/disconnect/tool cancellation/denied authorization, inherited budgets and concurrency boundaries.

Pi compatibility targets **1.2.0 public RPC and extension interfaces**. Document session/resource import/export, model control and event mapping boundaries. Arbitrary executable extensions and future private APIs are not promised to be fully compatible.

Manual compaction folds persisted message pages into a new continuation session with bounded requests. Original events remain in the parent session; generated summaries are not proof of lossless semantic compression. In-process plugins remain trusted code. Optional index limits still apply.

## Optional cloud acceptance

First choose configuration sync, distribution or remote connection scope. If Cloudflare is used, retain user-managed deployment and separately plan production relay/pairing/reconnection/revocation checks. Credentials and non-sensitive settings need separate designs; private configuration uploaded to the cloud requires end-to-end encryption.

Remote protocol and third-party plugin security review remains outstanding and belongs to that optional scope. Mobile notifications and store releases are separate from core TUI acceptance gates.

## Verification constraints

- Match the active workspace and installed dependencies before running a command. Prefer the fastest local affected-file test or filter.
- Complex code changes require a preceding `/plan` naming the specific test. Core-flow changes permit only one affected E2E script.
- Run targeted verification once. Rerun only after code changes. Do not automatically run a full suite, full E2E, `pnpm check` or benchmarks.
- Documentation, minor configuration, comments and pure UI styling run no tests. Syntax-only checks use a local linter against changed files only.
- After the initial failure, allow at most two code-change/targeted-test repair cycles. If still failing, stop all commands, report state and errors, propose the next `/plan` and wait for human input.
- Report unrelated pre-existing failures; do not repair them as part of another change.

## Automatic compaction, attachments and client C0: 2026-10-18

This continuation implements same-session automatic context checkpoints, native CLI/TUI file and image references, and the first real shared client state/protocol slice. It also optimizes the production startup graph and SQLite schema initialization. The 200 ms startup gate, FULL SQLite durability, original messages, current tool pairs, cancellation, leases and shared model budgets remain enforced.

Focused verification only (macOS arm64, Node 26.12.0, pnpm 12.11.2):

- Automatic compaction: 17 new cases; 105 affected core/context/storage/lifecycle cases passed across seven files. Real SQLite coverage includes restart, incremental checkpoints, tool pairs, failed/empty summaries, transaction rollback, stale source/CAS, lease expiry, queued cancellation and budget exhaustion. Known text-only image input is rejected before persistence.
- Attachments: 13 focused cases passed, including canonical paths, sensitive aliases, external symlinks, UTF-8/format/base64/byte limits, cancellation and replay after source removal. Sixteen provider-endpoint cases passed, including actual image content in the HTTP request. The final extra parser/capacity checks ran with filters after their changes.
- TUI: two new preparation failure/cancellation cases passed. The affected TUI/permission run passed 18 cases initially; one legacy error-feedback case exposed an extra Promise hop and passed after preserving its direct call path. Automatic compaction status feedback passed in that run.
- One affected real PTY script passed: `tests/prompt-attachments-pty.test.ts` proves missing-file draft retention, zero accidental model calls, then successful text and image transmission to a local SSE fixture and persisted image bytes. No other E2E script ran in this continuation.
- Client C0: 11 portable-state cases and four initial real RPC cases passed. Three follow-up filtered cases passed for SQLite `parentId:null` resume, pending approval detachment, and later approval from surviving work. Portable ES2023 type checking excludes Node/DOM types. Global event IDs are not treated as contiguous per-session IDs; scoped revisions detect delivery gaps.
- Startup packaging: 11 focused cases passed, including external plugin Zod metadata/validation, TUI Unicode/native-helper resolution, startup failure cleanup and disabled/unwritable compile caches. Atomic schema initialization adds one rollback case; it and the existing two-connection lease migration case passed after a demonstrated RED.
- Type checking and production build passed. Performance samples and exact gate results are recorded in [harness-performance.md](harness-performance.md); a failed startup budget stays a failure. No full suite or hosted CI ran.

Review caught and repaired sensitive attachment aliases, longer Markdown closing fences, client global-sequence assumptions, nullable restored parent IDs, and detached approval revisions. No additional layout-only tests were added.

Limits: compaction uses a conservative token heuristic and generated text, not a proven lossless semantic summary; original history remains authoritative. A pre-existing single stored user turn over 8 MiB can still block startup repair of interrupted tool pairs. New local attachments are bounded before submission. Budget usage and queued prompts are not recovered across host restarts. Native mobile apps, OS clipboard-image capture and portable image export remain subsequent work; durable host command receipts were added later in this record. The non-letter logo candidate is an independent unverified draft.

最终启动构建：冷 V8 缓存 3 次预热 + 30 次测量，p95 181.00 ms／输入 p95 1.37 ms／RSS p95 72.67 MiB，原三项门槛均通过。末轮压缩构建的两项插件与启动兼容测试通过；各个失败中间报告完整保留。

### File search completion — 2026-10-18

- TUI `@` completion now performs cancellable asynchronous `rg --files` discovery and subsequence fuzzy matching, supports directory-scoped paths, quoted spaces, and existing arrow/Tab/Enter/Esc editor controls. Discovery runs only after user input; ranking yields between batches. No file contents are read by completion.
- Added one real-filesystem editor regression covering ignored files, candidate display, keyboard completion, fuzzy matching, quoted paths and no accidental prompt dispatch. All 16 tests in `tui-interactions.test.ts` pass; typecheck, build and diff check pass.
- Final `pnpm bench:check`: 30 launches, 3 warmups, cold V8 cache per launch / warm OS caches; startup p95 177.38 ms, ordinary input p95 2.04 ms, ready RSS p95 72.77 MiB. Original 200 ms / 16 ms / 100 MiB budgets pass. This input metric does not measure large-repository search latency.
- Harness/core/storage paths and all thresholds unchanged; no redundant storage benchmark rerun. Search uses the documented required `rg` dependency, bounds listings to 4 MiB / 20,000 files and displays 20 matches; narrow the directory for larger workspaces. Empty directories have no file candidates.

### C0 durable outcomes, host/run snapshots and secure skill batching — 2026-10-18

Implemented the second C0 slice: all RPC mutations claim a scoped, digest-bound durable intent before effects; `command.receipt` queries recover known outcomes; duplicate IDs do not execute and payload conflicts fail. Accepted records from another host incarnation project unknown without rewriting the owner. Asynchronous completion stays tied to its original command/session. Same IDs across two scopes on one session cannot borrow another run ID, including queued cancellation. Host instance and run snapshots recover explicit status; unmatched persisted starts remain unknown. Client-state capacity reserves recovery reads and never evicts unresolved mutation intents. See [the contract](specs/command-receipts.md).

Necessary verification, without a full-suite run:

- New storage tests first failed on missing APIs; three tests now cover concurrent SQLite claim, payload conflicts, scope/workspace separation, reopen and legacy privacy.
- Two real Runtime/SQLite RPC tests cover restart/no replay and a deterministic shared-session/same-ID race. Both failed before their implementations and pass afterward. The remote bridge's query namespace mapping is also covered.
- Existing deferred RPC control tests retain cancellation, detach, queue limits and late completion assertions, and now check durable terminal outcomes. One additional regression bounds waiting controls while preserving cancellation capacity. Portable state tests cover host/epoch fencing, snapshot recovery and 60 unresolved mutations with recovery reads still available.
- The affected core/client/RPC/storage/runtime/session/lease run passed **114 tests** before the final control and native additions; the later control/real-RPC/handshake run passed **26 tests**. These counts overlap and must not be summed as unique cases.
- Native batching adds **three** tests for ordered mixed success/failure, missing/symlink/FIFO/size isolation, replacement after path authorization, cancellation and limits. The affected native/attachment-PTY/runtime/session/packaging run passed **43 tests**. A final real-RPC/scope/handshake run after batching passed **10 tests**. C11 `-O2 -Wall -Wextra -Werror`, repository typecheck, portable client typecheck, build and diff check pass.
- A direct comparison with the previous committed loader returned the same 33 Skill resources and exactly the same instruction text. Batch reads still validate each complete file; the 16 KiB decoding prefix only bounds the description string retained afterward.

Final original startup gate: **165.54 ms p95** (cold V8 cache, 3 warmups / 30 launches, warm OS caches), ordinary input **1.26 ms p95**, ready RSS **70.66 MiB p95**. The 10k harness passes all existing gates. Failed startup attempts, the shared-load baseline/candidate comparison and the reverted early-worker experiment are preserved in [the performance ledger](harness-performance.md). No successful measurement was used to erase a failure or weaken a threshold.

C0 is still not complete as a whole: remote raw transport wiring, remaining client-facing session/history/attachment APIs and host/native lifecycle remain staged work. No native mobile application, signed mobile package, production relay, external provider or physical-device acceptance is claimed.
