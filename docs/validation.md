# Validation status

## Referenced code-review fixes: 2026-10-16

Applied the review of `c3ffcb49121427b50a0cc6eb533de6e598474857` on top of `2906efd`, retaining and checking its existing file-queue/context-history fixes. All seven concrete findings now have regression coverage: Git control-file/process boundaries, resource authorization for search/index reads, conflicting file updates, child/job initialization cancellation, child concurrency reservations, responsive RPC control and exact-endpoint authentication. CI now runs on PRs and pushes to main, with Linux checks and a separate full macOS job.

Additional cross-tool and fault-injection review covered Git clean filters reading sensitive files, detached device revocation, remote forwarding of `baseUrl`, old lease epochs, renewal while waiting on a SQLite writer lock, approval-to-execution ownership loss, file-commit ownership loss, terminal initialization cancellation, and descendants surviving a cancelled process leader. RPC compaction now uses the v2 asynchronous operation contract documented in [architecture.md](architecture.md).

Validation completed on macOS with Node 26.12.0 / pnpm 12.11.2:

- `pnpm check`: **25 files, 170 tests passed**, plus full TypeScript checking and build. This includes the real macOS sandbox, independent-process file coordination, real SQLite connections, loopback HTTP authentication, RPC subprocesses and PTY tests.
- `pnpm check:relay`: passed.
- Built CLI offline prompt smoke: passed.
- Changed-source formatting and `git diff --check`: passed.
- Deliberately removing the exclusive file-lock flag made the independent-process regression fail; the original implementation was restored. Cancellation, initialization, lease and authentication tests were also observed failing before their fixes.

No production API, actual Keychain sign-in, Cloudflare deployment or live handset acceptance ran. GitHub-hosted CI was configured but not dispatched from this local branch. File locks coordinate cooperating file tools and can remain after a crash; external namespace races and already-started process effects are not made transactional by SQLite fencing. Third-party plugins remain trusted. Runtime initialization/close limits, Agent-lifetime budgets and continuation-persistence boundaries are explicit in [architecture.md](architecture.md).

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
- Electron/Expo clients, shared client-state package and dedicated tests/scripts have been deleted. Their release, notification, store and performance acceptance work is outside delivery.
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
- Complete context budgeting, automatic compaction, goal/constraint/path preservation and draft crash recovery.
- Actual file/image attachment loading, readable tool/code/diff output, cross-page/full-session search and portable attachment export.
- Real-project MCP/Skills invocation, failure recovery and plugin resource cleanup.
- Both Pi directions under real accounts, long sessions, cancellation, permissions, recovery and failures; default-entry install/upgrade; version matrix, capability detection and visible degradation. Failures must not silently switch execution agents.
- Manual IME, wide characters, emoji, paste, resize, exit restoration and assistive-technology review. Existing PTY checks cannot replace real input-method testing.
- Crash/disconnect/tool cancellation/denied authorization, inherited budgets and concurrency boundaries.

Pi compatibility targets **1.2.0 public RPC and extension interfaces**. Document session/resource import/export, model control and event mapping boundaries. Arbitrary executable extensions and future private APIs are not promised to be fully compatible.

Manual compaction folds persisted message pages into a new continuation session with bounded requests. Original events remain in the parent session; generated summaries are not proof of lossless semantic compression. In-process plugins remain trusted code. Optional index limits still apply.

## Optional cloud acceptance

First choose configuration sync, distribution or remote connection scope. If Cloudflare is used, retain user-managed deployment and separately plan production relay/pairing/reconnection/revocation checks. Credentials and non-sensitive settings need separate designs; private configuration uploaded to the cloud requires end-to-end encryption.

Remote protocol and third-party plugin security review remains outstanding and belongs to that optional scope. Removed desktop/mobile notifications and store releases are not core acceptance gates.

## Verification constraints

- Match the active workspace and installed dependencies before running a command. Prefer the fastest local affected-file test or filter.
- Complex code changes require a preceding `/plan` naming the specific test. Core-flow changes permit only one affected E2E script.
- Run targeted verification once. Rerun only after code changes. Do not automatically run a full suite, full E2E, `pnpm check` or benchmarks.
- Documentation, minor configuration, comments and pure UI styling run no tests. Syntax-only checks use a local linter against changed files only.
- After the initial failure, allow at most two code-change/targeted-test repair cycles. If still failing, stop all commands, report state and errors, propose the next `/plan` and wait for human input.
- Report unrelated pre-existing failures; do not repair them as part of another change.
