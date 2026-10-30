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

## Explicit controls after local Grok trial

Launched locally installed Grok Build 1.0.70 in a PTY, inspected its welcome screen and slash picker, then exited with /quit without sending a model prompt. Its named menu entries and bracketed Dashboard control distinguish actions from location text. Removed Hikaro's invisible whole-header action. Added bracketed View, Sessions and Commands controls with exact hit regions and wrapping on narrow screens; View opens selection instead of cycling invisibly. Renamed the command picker and described its model/session/change/settings contents. Existing 13 relevant checks, typecheck and build passed. No manual mouse/IME claim.

## Panel boundaries and navigation

Added a neutral toolbar divider and ruled panel headings. Ordinary toolbar controls are neutral; panel selection uses a neutral contrasting background, while destructive labels/headings use red plus explicit wording. Removed inline descriptions from choice rows: the selected explanation remains below. Commands now say Show conversation/changes/etc.; removed redundant Workspace view wording. Corrected the command explanation being passed as a warning (which rendered it red). Toolbar navigation aborts the previous picker before opening the next destination; clicking Commands again closes it. Approval remains protected. Three existing relevant suites (17 checks), typecheck and build passed; physical mouse acceptance not claimed.

## Hands-on PTY interaction pass

Ran the actual built CLI in an isolated `/tmp/hikaro-interaction.*` home/workspace. Drove terminal SGR mouse press/release events, not component-only snapshots or physical macOS pointer input. Compared with the previously exercised local Grok Build 1.0.70 welcome/slash interaction.

Observed and fixed: menu choices had no mouse handler; Models/Providers tabs ignored clicks; Cancel buttons needed the panel cancellation path rather than editor key forwarding; deletion selection changed the button position as duplicate descriptions appeared. Added explicit mouse-selectable choices/tabs and confirm/cancel/delete/rename controls. Deletion now defaults to Keep session, displays its consequence independently and requires full notice visibility. Removed duplicate details that moved its buttons.

Executed Commands → mouse-select Activity → Model → click Providers → Sessions; selected a noncurrent temporary session, opened deletion, canceled, reopened and confirmed deletion through the visible button. Verified it disappeared while the current session remained. Also deleted a temporary current session in the earlier pass and observed replacement activation. Final rebuild: clicked Cancel in Sessions, then typed more text; draft visibly became `draft survives OK` in the editor. All launched Hikaro PTYs exited. No user sessions were deleted or model prompts sent.

Top bar now retains Sessions/Model only. Commands remains in the input hint via Ctrl+P; F6 retains view navigation. Footer separates model/permission/usage groups with rules and uses Permissions: value, Context: value and Reasoning: value. One focused mouse-selection/confirmation regression added; the 18 relevant checks, typecheck and build passed. Physical IME, OS pointer selection and every backend were not re-certified by this pass.

## Bounded menu redesign

Reopened local Grok Build and exercised `/model`: its compact choice list prioritizes selection over an always-expanded capability report. Reworked the shared Hikaro menu surface to a centered, maximum 76-cell content column with a complete border, a title/navigation group, full-row selection and separate action group. Pointer coordinates are translated into this surface. Model details default to a one-line provider/context summary; Details/F2 expands full capabilities. Credential ownership remains in provider management, not repeated above model search. Combined Enter/Esc hints into visible buttons; retained advanced shortcuts in a secondary row.

Ran the built CLI in the existing isolated test home, clicked Model and Details, observed the expanded capability report, and closed normally. Added title-group spacing and keyboard F2 access after that observation; relevant 18 checks, typecheck and final build passed. Physical window screenshots and native font/IME inspection remain outside this PTY verification. No additional dependencies or rendering framework.
