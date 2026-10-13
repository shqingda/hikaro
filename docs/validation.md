# Validation status

Updated: 2026-10-13. Implementation, test coverage, completed verification and pending acceptance are separate states. See [TODO.md](../TODO.md) for delivery order. Documentation and styling edits have no independent tests or benchmarks. Critical TUI workflow verification is recorded below.

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

The failed title lookup exposed a pre-existing limitation: `SelectList.setFilter` matches internal `value` prefixes, which are session IDs, rather than visible titles. This was recorded as pending title-filtering work in TODO. Production filtering was not changed in this task.

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
| `pnpm exec vitest run tests/permissions.test.ts tests/pty.test.ts -t 'permissions\|activity indicator'` | 4 passed, 1 E2E failed, 4 skipped; stale idle output caused the E2E to submit a command too early |
| After changing the output cursor: `pnpm exec vitest run tests/pty.test.ts -t 'permissions and activity indicator'`              | 1 passed, 4 skipped; picker, animated frames, actual external-file write, loopback network request and saved mode verified |
| After adding sensitive-read review: `pnpm exec vitest run tests/permissions.test.ts -t 'auto approves known workspace actions'` | 1 passed, 3 skipped; only the affected auto-approval case was rerun                                                        |

Environment: macOS, Node 26.11.1, pnpm 12.11.2. Other passing unit scenarios cover immediate changes in a cached agent, rejecting changes while busy, workspace isolation, invalid saved modes and animation cleanup/pause. No full suite, other E2E or benchmark ran. The earlier critical TUI scenarios remained filtered out; the manual-compaction assertion was updated to the new Compacting label. Live provider accounts and manual terminal review remain pending. `pnpm build` passed and refreshed the `pnpm start` artifacts. Discovered read-only Skill resources retain their existing read allowlist.

## Pending core and Pi acceptance

Follow the six stages in TODO. Required checks include:

- Real-project login, file read/write/edit/search, shell/test/Git, permission and failure recovery; explicit queue, steering, cancel and exit behavior.
- Production-account OAuth, refresh, rate limits and model/account thinking/speed capabilities. Unknown models retain default speed only; offline request capture does not establish account support.
- Complete context budgeting, automatic compaction, goal/constraint/path preservation and draft crash recovery.
- Actual file/image attachment loading, readable tool/code/diff output, session-title filtering, cross-page/full-session search and portable attachment export.
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
