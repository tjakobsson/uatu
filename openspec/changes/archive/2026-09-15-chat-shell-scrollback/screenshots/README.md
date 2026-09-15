# Shell scrollback browser evidence

Run `bun run test:e2e tests/e2e/chat-shell-output.e2e.ts tests/e2e/chat-shell-scrollback.e2e.ts --workers=1`.

The scrollback suite captures Chromium and WebKit screenshots for light/dark desktop and touch layouts, including a smaller visible viewport. Desktop floating screenshots show output wider than Chat. Screenshots are evidence of the captured layout, not proof that the entire test passed.

Each long-output test attaches `shell-long-output-work.json` to the Playwright report and saves an engine/agent-named JSON file here. It records 5,000 initial lines alongside the existing 50-item `chatWorkload`, 20 cumulative updates, input code units, parser work, prefix-comparison budget, line DOM writes, update-to-DOM timings, and move/resize/navigation timings. Test-only served-bundle instrumentation reads the real `TerminalOutputBuffer.stats` and counts shell line `innerHTML` writes. No production instrumentation is added.

Hidden-view tests attach `hidden-shell-work.json` and save engine/layout/timeline-named JSON here after verifying that hiding Chat suspends both shell painting and transcript rendering, then restores the same owning command with final output. The visibility assertion is soft so a failure to hide the window still fails the test while allowing the painting and restoration assertions to run.

Viewport shrinking models reduced available browser space. It does not claim physical-device software-keyboard coverage. Touch activation uses Playwright touchscreen taps. Chromium also resizes inline output through native CDP touch input. WebKit covers keyboard resizing and touch activation, plus mouse pointer resizing in desktop mode.

## Initial integration verification on 2026-09-15

`bun run typecheck` passed. The full shell-output and scrollback run with `--workers=4` completed 87 tests: 49 passed and 38 failed. The existing `chat-panels.e2e.ts` working-line case also passed with its corrected `.chat-shell-viewport` selector.

Passing coverage includes completed-only scrollback, non-shell preview/disclosure behavior, streamed ANSI/progress/corrected snapshots, terminal palette/font comparison, all 24 outcome/shape/parent-child combinations, all four long-output workloads, touch light/dark layouts and smaller bounds, deliberate outer-scroll preservation on return, owning-child exit, item removal, and disconnection without invented completion. Native selection survives appends and can be copied and pasted into the composer in both engines.

All 16 full running-flow cases completed their pointer and keyboard resize, pop-out, beyond-Chat width, move, maximize, append/completion, restore, Escape, focus, grouping, reading-position and latest-output assertions. Their only failure was the conversation label in the window header.

### Failures found during integration, resolved below

| Case | Observed failure |
| --- | --- |
| Full running flow | `.chat-shell-window-metadata` shows the qualified conversation ID instead of `Scrollback owner`. |
| Hide Chat and small desktop layout | `.chat-shell-window` remains visible after Chat is hidden or auto-collapsed. At 720px it can cover the Open chat panel control. |
| Floating/full-area find | `#find-status` reports `No results` for `earliest-unique-needle`. |
| Lazy completed-only parent find | The result can report `1 of 1` and materialize all 202 lines, but the earliest matched line stays outside the shell viewport. |
| Lazy completed-only child find | `#find-status` reports `No results`. |
| Retained geometry | A reopens at default 900×560 after navigating away and back, rather than its selected 950×580. A/B isolation before navigation passes. |
| WebKit presentation change | After native keyboard scrolling settles, switching to touch changes the sampled shell reading offset by 403px in the final focused run. Chromium preserves it after waiting for native keyboard scrolling to settle. |
| WebKit selection | Keyboard Pop out clears the selection. The preceding append and native copy/paste assertions pass. |

An earlier completion failure was an invalid test fixture, not a product defect: shell wire items do not accept `completedAt`. That field was removed. Tests verify that an absent timestamp is not invented. A supplied shell completion timestamp cannot be exercised through the current normalized route fixture.

### Incremental work evidence

Every workload starts with 189,999 code units, appends 5,010 code units in 20 updates, and retains all 5,020 lines. Every run records exactly 5,010 additional parsed input code units, 20 line DOM writes, 4,990 rendered cells, 10,000 segmented code units, no additional parser reset, and a separately reported prefix-comparison budget of 3,847,525 code units. The original earliest line node survives. Initial parsing is included separately from ordinary append work.

| Engine/agent | Append buffer-update time, total | Move and resize | Navigate away and back |
| --- | ---: | ---: | ---: |
| Chromium/OpenCode | 8.2ms | 429ms | 515ms |
| Chromium/Claude | 7.8ms | 492ms | 505ms |
| WebKit/OpenCode | 5ms | 749ms | 369ms |
| WebKit/Claude | 16ms | 775ms | 424ms |

These timings include test-environment scheduling and are evidence from this run, not a cross-machine performance promise. The repeatable assertions cover work counts, retained nodes, complete output, and bounded interaction latency.

The final focused hidden-view run exercised eight combinations of engine, desktop/touch, and parent/child. All eight failed only the soft window-visibility assertion. Their parse, line-write, paint-call and transcript-render counters stayed unchanged through eight cumulative hidden appends and completion. Returning reconciled nine new lines once, restored the same owning controller and final status, and preserved geometry and reading position. The JSON files record those counters.

These were intermediate results before UI, Find, and retained-state integration. All listed failures have since been resolved.

## Final verification on 2026-09-15

- `bun run test:e2e tests/e2e/chat-shell-scrollback.e2e.ts tests/e2e/chat-shell-output.e2e.ts --workers=1`: **87 passed**.
- `chat-follow-stability.e2e.ts` and `chat-responsiveness.e2e.ts`: **28 passed** after the final scroll-owner fix.
- Existing `chat-panels.e2e.ts` and `find.e2e.ts`: **41 passed** in the broader regression run.
- Affected Chat and Find unit suites: **327 passed** across 18 files.
- `bun run typecheck` and `git diff --check`: passed.

The final shell run covers both agents, both shell item shapes, parent and child timelines, desktop and touch layouts, light/dark styling, native selection, Find, movement and resizing, truthful outcomes, navigation cleanup, and hidden-view restoration. The screenshots and per-workload JSON files in this directory were refreshed by that passing run.

The desktop narrow-layout test respects the existing 900px guard: shrinking hides Chat and its window, and restoring sufficient width automatically reopens the retained view. It keeps the reduced height to verify bounded controls. No timing assertion, output count, or reading-position tolerance was relaxed.

Two long-output cases timed out in an earlier parallel run without identifying a failing assertion. Diagnostic phases were added without changing workloads or timeouts. Focused repeated runs and the final serial shell run passed; that earlier timeout was not attributed to a confirmed product cause.
