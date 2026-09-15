## Context

See `proposal.md` for motivation. `renderActivityOutput` currently clips running output to twelve raw lines and splits completed output into a preview and disclosure. Its terminal flag already distinguishes shell output. Both normalized command items and Bash tool details use this path, across both agents.

`TimelineRenderer` reuses unchanged rows, but changed shell rows are rebuilt. Activity grouping also reparents rows, and closed activity is materialized lazily for inspection and find. Main and child timelines have separate renderers and outer scroll anchors. Their update scheduling batches paints and defers hidden Chat rendering.

The reported follow jitter has not yet been reproduced. Several paths currently write the timeline position: post-render anchoring, the scroll listener's bottom correction, the item resize observer, and the viewport controller. The latest button starts smooth scrolling while those paths can make immediate corrections. Row rebuilding, content-visibility size changes, and completion collapse are additional geometry changes to investigate, not established root causes. The user's confirmation did not identify a single trigger, so reproduction covers passive following, clicking latest, and attempting to scroll upward.

The transcript uses padding to limit text to roughly `52rem`; its parent Chat panel is another width boundary. A transcript-area overlay escapes only the text width. The approved floating view needs an app-level host outside both constraints.

`ansi.ts` interprets ordinary terminal text into styled lines, including progress-line overwrites. It is not a terminal emulator. Running output currently avoids parsing the entire cumulative log on each paint. Design is needed because scrollback changes that performance contract and introduces state across renderer, interaction, and layout modules.

## Goals / Non-Goals

Goals:
- Give each loaded shell output a stable rendering and interaction lifetime, independent of activity-row regrouping.
- Keep shell following independent from outer timeline following.
- Eliminate competing automatic scroll corrections using a measured browser reproduction and a coordinated scroll owner per viewport.
- Let a single output window use the app work area while retaining its original command identity and inline reading state.
- Reuse the current terminal-text interpretation, styling, paint scheduler, and lazy materialization.

Non-goals:
- Interactive stdin, PTYs, terminal resize signals, alternate-screen applications, or browser fullscreen.
- Recovering output truncated by a provider, changing provider protocols, or persisting presentation state across a page reload.
- Replacing non-shell tool previews or introducing a new terminal dependency.
- Multiple floating windows, native OS windows, or a command inspector pinned across conversation navigation.

## Decisions

### 1. Own shell output through a persistent controller

Add a focused Chat shell-output module. Each timeline renderer owns controllers keyed by conversation ID and item ID. A controller owns the output viewport, parsed output state, scroll/follow state, and inline height. An app-level output-window controller owns a reference to exactly one shell controller and applies its floating geometry. Retain floating bounds keyed by conversation and item alongside that item's retained presentation state, not as one global last-window rectangle. Switching window ownership saves the previous item's bounds and loads the selected item's bounds, so resizing one command cannot overwrite another's geometry. Route normalized commands and Bash tools through the same shell controller. Keep command, description, provider outcome, and separately identified error output available without inventing stdout/stderr chronology.

Extend shell patching so updates reconcile metadata and output without replacing the viewport. Group reparenting must preserve it. Lazy activity materialization attaches through this same path rather than producing an unrelated static copy. Resizing or popping out counts as deliberate inspection, keeping both the row and its containing group reader-opened at completion; untouched auto-open rows retain existing collapse rules.

Alternative: save scroll offsets around wholesale row replacement. Rejected because it still disrupts selection, focus, resize gestures, and window ownership on every update.

### 2. Incrementally interpret and patch output

Extend the existing ANSI machinery with a stateful feed path sharing its interpretation rules. Track the last consumed cumulative output and process an appended suffix for verified append-only updates. Preserve unfinished escape sequences, style state, and the mutable current line across chunks. Patch only affected lines; completed unchanged lines retain their DOM nodes. A changed or shortened authoritative output resets parsing and reconciles from that snapshot, clamping a reader anchor only if its content no longer exists.

Keep all supplied output accessible, with no new silent scrollback cap. Reuse the existing batched paint cadence and hidden-Chat gate. Full initial/replacement parsing is allowed, but ordinary appends must not repeatedly reparse or rebuild the full log. Cumulative prefix checks can still cost time; measure them separately from parsing and DOM work. Keep conversion compatible with the one-shot API used by other tool output.

Alternative: render the whole cumulative log into `innerHTML` on every chunk. Rejected because work grows with history and replaces selected content. Virtualizing lines is deferred because it complicates existing find and selection; incremental DOM updates are the initial approach, verified against long-output fixtures.

### 3. Keep a separate output reading anchor

Initialize an output at its bottom, including completed-only output. Track reader-driven upward movement explicitly so even a small upward scroll pauses following. Returning to the bottom or activating an accessible latest-output button resumes it. Programmatic scroll writes must not be mistaken for reader intent.

While paused, retain the top visible rendered line and its offset plus horizontal scroll. Preserve these across append, resize, pop-out, maximize, restore size, return inline, and completion. While following, maintain the bottom after changes. Coordinate changes to inline geometry with the owning outer timeline's before/after-mutation anchor handling. Use contained overscroll so reading shell output does not unexpectedly drag the outer transcript. Geometry clamping must not itself resume following.

Alternative: infer shell following from the outer timeline's pin state. Rejected because a reader may inspect old shell output while the transcript itself is pinned, or follow a shell while reading an older turn.

### 4. Reproduce jitter and coordinate automatic scrolling

Start with a repeatable browser fixture against the existing behavior. Record per-frame scroll position, scroll extent, viewport height, follow intent, and the source of programmatic corrections. Exercise passive streaming, latest activation during streaming, small upward wheel/touch movements, intrinsic-size changes, resize, and command completion in parent and child timelines. Run Chromium and WebKit because layout and scroll-event timing differ. Keep diagnostics in test infrastructure, not permanent per-frame production logging.

Use the evidence to route automatic positioning through one coordinated owner per scroll container. Render, resize, viewport, and toggle events request a correction; read settled geometry and apply at most one automatic position correction per animation frame. Scroll observations update reader intent and do not independently launch a competing snap. Track applied programmatic positions, including clamping, so delayed event echoes do not impersonate upward or downward user motion. Retain the existing outer-anchor semantics for prepending history and restoring positions.

Use immediate positioning for latest-content actions and continuous following in these viewports. This avoids a native smooth animation competing with a moving bottom target. Upward reader input cancels pending following before the next correction. A genuine content shrink can legitimately reduce the scroll offset; tests must compare both offset and extent rather than forbid all negative movement. If browser native scroll anchoring contributes a second correction, disable it for the managed containers and verify manual anchoring across supported engines.

Alternative: remove only smooth scrolling or rely only on a fixed shell height. Either might reduce symptoms but leaves other competing writers and does not establish the reported defect's cause. Reproduce first, then verify the coordinated path against that evidence.

### 5. Pop out into the UatuCode work area

Mount one nonmodal floating output host outside the Chat panel's width and overflow constraints. Its bounds are the visible app work area, excluding persistent app navigation and respecting safe areas. Desktop pointer and keyboard controls move it and resize both axes. Maximize fills the work area; Restore size restores the saved floating rectangle. Inline height and floating geometry are separate state. Clamp geometry when the app resizes so the title and return controls never disappear offscreen.

Move the same controller-owned viewport into this host, leaving a stable inline placeholder and a way to focus the existing window. At most one output is popped out in the current UatuCode page. Opening another returns the previous item inline before transferring ownership. The original parent or child renderer continues supplying updates. Pop-out does not create a new provider session or subscription. Hidden-page and hidden-Chat paint gating remains in effect; the window is hidden with Chat rather than becoming an independent background inspector.

Return to chat, a close affordance if present, and Escape from the output window return the viewport inline directly, including from maximized mode. Restore the inline height, output reading state, current outer reading anchor, and focus to the initiating control when available. Preserve the outer anchor across pop-out itself, but do not overwrite deliberate outer scrolling that happened while the nonmodal window was open. Escape consumes the event before child drill-down navigation; Escape used inside an unrelated picker or dialog retains that control's existing priority.

Normal floating mode leaves uncovered app content interactive without a global focus trap or backdrop. Maximized and touch full-area output may cover Preview and the composer; Return to chat remains reachable to access covered controls. Prevent keyboard focus landing on fully covered work-area controls while maximized, without disabling app navigation or higher-priority dialogs. Touch uses the same output controller in a full-area view without freeform dragging/resizing. Preserve desktop floating geometry when layout mode changes.

Explicit conversation switching, closing the owning child, item removal, and renderer disposal release window ownership, pointer capture, and listeners. They must not redirect the old window to another item. Retained inline reading state stays keyed to its owning conversation, and returning never automatically pops the window out again.

Alternative: retain transcript-only expansion. Rejected because it cannot exceed the Chat panel width. Native windows and browser fullscreen add lifecycle complexity beyond the requested in-app window. Cloning the output into a second view splits selection and follow state, so the existing viewport moves instead.

### 6. Keep command identity and final status visible

The window header identifies the command and owning conversation and shows the provider-reported Running, Completed, Failed, or Cancelled state in text. Display a completion time only when the source supplies one. Do not stamp the current time onto an old completed log, and do not use connection loss or silence as evidence of completion.

Carry known terminal timestamps as optional `completedAt` on normalized tool and command items, through validation and the wire schema. OpenCode supplies terminal event `data.timestamp`, classic tool `state.time.end`, v2 tool `part.time.completed`, and shell message `time.completed` or `time.end`. Claude supplies the timestamp of the user frame containing the matching `tool_result.tool_use_id`, live when reported and in stored transcripts. Call timestamps and turn durations do not establish tool completion. Unknown times stay absent; pending/running records must not acquire a completion time from stray terminal fields.

When the command finishes, update the header and keep the window, dimensions, output, and reader state intact. Later commands and later turns never retarget it automatically. This makes a completed log recognizable without calling useful output "old". Explicit navigation follows the cleanup boundary above.

Alternative: close the window on completion or replace it with the next command. Rejected because either interrupts inspection and makes it unclear which command produced the visible output.

### 7. Provide pointer and keyboard inline resizing

Use an explicit height handle with pointer capture for mouse and touch and keyboard adjustment with a documented step. Expose its purpose and current bounds accessibly. Start with a compact height of about twelve rendered lines; use a minimum of four lines and clamp the chosen height to the available transcript area, retaining a usable header and controls. Treat these dimensions as layout defaults, not stored preferences.

Observe container changes to clamp height after orientation, split-size, or software-keyboard changes. Floating and maximized sizes do not overwrite the reader's inline height. Coalesce drag updates with animation frames and apply anchoring through the coordinated scroll owner. Work-area bounds take precedence if even the preferred minimum cannot fit.

Alternative: CSS `resize: vertical` alone. Rejected because it does not provide consistent touch and keyboard interaction or enough control over timeline anchoring.

## Risks / Trade-offs

- Incremental ANSI parsing can mishandle split controls or rewritten lines. Mitigation: compare incremental and one-shot output for adversarial chunk boundaries, Unicode, styles, and progress rewrites.
- Full retained DOM consumes memory for very large provider output. Mitigation: retain lazy closed-row materialization, patch only changed lines, measure large fixtures, and preserve all loaded output rather than silently truncating it.
- Moving output outside its activity ancestor can break CSS and find. Mitigation: give the controller self-contained terminal styling, expose the floating viewport to existing find integration, and keep one searchable copy with copy/selection behavior covered in browser tests.
- Completion and grouping can remove the inline restoration slot. Mitigation: resolve the slot by conversation/item identity after reconciliation and dispose safely when the item genuinely disappears.
- Nested scrolling and touch resizing can fight outer anchors. Mitigation: independent follow state, contained overscroll, pointer capture, and real-browser tests across desktop and touch layouts.
- Scroll coordination can regress existing history and viewport recovery. Mitigation: capture the jitter before changing it, cover programmatic echoes and delayed geometry in both browser engines, and retain existing anchor tests.
- A floating window can obscure useful controls or remain bound to disposed content. Mitigation: reachable return controls, bounded geometry, explicit parent/child ownership, and cleanup on navigation. Cross-conversation persistence is excluded.

## Migration Plan

Presentation state needs no stored-data migration. The known-completion requirement adds optional `completedAt` data propagation; because tool and command wire objects are closed, strict consumers need workspace API revision 19 and regenerated validators. This does not change provider protocols or the product major version. Reproduce the follow jitter first and record the evidence. Implement coordinated scrolling, the shell controller, and incremental parsing, wire both shell item shapes and timelines, then add inline resizing and the floating window. Run focused unit and browser checks plus frame-level jitter and long-output responsiveness checks before release. A rollback must account for the wire contract as well as client code.

## Verification evidence

### PR review follow-up

The fifth review identified two macOS-wrapper integration defects, reproduced in both Chromium and WebKit using the existing desktop-host DOM contract. The output work area now intersects the visual viewport with the native `--titlebar-inset` when `uatu-desktop-host` is present. Root class/style changes trigger layout so native tab-bar height changes update floating bounds and maximized height without a reload. Without the marker, the custom property does not affect browser layout.

The output window now uses layer 95, above desktop frost and headers at 90/91 and below modal overlays at 100. Four new browser regressions verify top-edge pointer/keyboard clamping, changing inset values, usable controls over desktop headers, and a modal painting above the window. All four and the seven existing desktop-inset cases passed, as did 44 affected unit tests, typecheck, and whitespace validation. These verify the SPA side of the wrapper contract.

The fourth review found three lifecycle gaps. Upward reader scrolling and Find reveal now record inspection through the existing coordinated scroll owner, keeping the activity open on completion without overriding explicit reader closure. Retained shell presentation includes the last-painted raw output string, so reconstructing unchanged output preserves `unseen=false`, while output received during absence sets the indicator. The retained value shares an immutable string reference; it can keep an older snapshot alive during navigation.

Return-to-chat focus now checks semantic and layout reachability and falls back from Pop out to the visible owning row/group summary or timeline. It never opens a closed activity merely to focus it and continues to use `preventScroll`. Verification passed: 318 affected unit tests, 12 new Chromium/WebKit lifecycle browser cases, all 28 existing frame-stability/responsiveness cases, typecheck, and whitespace checks.

The third review identified covered prompt navigation being exempt solely because it used a `nav` element. Full-area coverage now exempts the explicit persistent touch-tab and sidebar-rail controls, not arbitrary navigation. Unit coverage checks default and configured coverage roots; Chromium/WebKit desktop and touch cases verify covered prompt buttons cannot receive Tab focus and become usable after Restore or Return to chat.

CI run 34974701541 had one hard failure: the long-output test measured two navigations plus Playwright actionability/protocol work against a combined 3,000ms budget, observing 3,134ms and 3,057ms. The test now measures each navigation in the browser from the actual selector change event through a unique target row's DOM commit, including the application handler and snapshot fetch. Each retains a 3,000ms response budget. Total automation roundtrip time remains diagnostic. The 5,000-line workload, 20 appends, deterministic parser/DOM work assertions, 60-second overall timeout, and move/resize budget remain unchanged; exact retained-output equality was added.

Twelve repeated long-output cases passed under four workers with tracing and no retries. Measured browser navigation was 33–421ms for Chromium and 57–344ms for WebKit, while automation roundtrips reached 2,714ms. The downloaded CI retry trace spent 53.6 seconds in boot before streaming, and completed streaming control requests took 11–41ms; it does not establish a stuck streaming POST. Per-call request timeouts and phase/status/duration diagnostics now preserve evidence without swallowing failures. That CI-specific slow boot remains unattributed. New workload evidence goes to per-test output directories so repeats do not overwrite one another.

The second review found that floating Find indexed CSS-hidden inline controls. Pop-out now marks the command block, Pop out button, and inline resize handle semantically hidden and restores them on return. A new Chromium/WebKit regression verifies invisible controls produce no matches and real output remains searchable. That test also exposed match selection moving when the Latest output control became visible; Find now retains the selected DOM text range when its text survives reindexing.

The remaining hard CI failure was reproduced in the existing touch-scroll test: it opened the outline twice despite the first outline remaining open across the mode switch. The second click was blocked by the outline sheet. The test now asserts the retained open state and visible active headings, preserving the scroll expectations. Follow-up checks passed: 275 affected unit tests, both new browser regressions, all 24 existing Find/touch-scroll cases, typecheck, and whitespace validation. CI's six retry-passing cases were not treated as hard failures or silently assigned a cause.

Addressed all three findings from PR #372: known provider completion timestamps now survive normalization, validation, and replay into shell metadata; inline error Find results scroll both the error pane and its outer transcript; covered Preview Find controls are inert in maximized and touch output, with that coverage released when the shared bar moves into the active window.

The timestamp addition requires workspace API revision 19 because conversation item schemas reject unknown fields. Hub revision remains 5. Provider timestamps are retained only where genuinely supplied, including matching Claude tool-result envelopes; missing completion times are never inferred from receive time. Validation/schema/normalization and frontend checks passed: 397 affected unit tests, 18 Chromium/WebKit browser cases covering the review fixes and adjacent Find/selection paths, typecheck, API validation, and strict OpenSpec validation.

CI follow-up installs WebKit alongside Chromium, and the inventory presentation fixture now installs its stateful driver once per document. All five inventory presentation browser cases passed with that fixture correction. The earlier CI run's separate touch-scroll outline failure was not changed in this review follow-up.

Final status: all 22 implementation tasks are complete. The chronological investigation below includes intermediate failures; the final verification section records their resolution. The original alternating oscillation remains unconfirmed, as agreed with the user.

### PR 372 completion timestamp review, 2026-09-15

Comment 4015437791 identified missing propagation for the existing known-completion requirement. `ToolItem`, `CommandItem`, and their validator now accept optional finite, non-negative `completedAt`; the OpenAPI item branches document the same epoch-millisecond field. The compatibility check against the pre-review contract reports exactly two closed response property additions on the conversation live topic, both charged to workspace. Workspace revision 19 and its migration entry cover them; Hub and product versions do not change.

Provider evidence comes from installed SDK declarations. OpenCode SDK 1.18.30 declares classic `ToolStateCompleted`/`ToolStateError.time.end`, v2 `SessionMessageAssistantTool.time.completed`, and `data.timestamp` on `SessionNextShellEnded`, `SessionNextToolSuccess`, and `SessionNextToolFailed`. The shell history reader also preserves message `time.completed` or legacy `time.end`. Tool timestamps are admitted only for completed/error state, never pending/running state. Claude Agent SDK 0.3.252 declares optional `SDKUserMessage.timestamp` as the originating process's message timestamp. Only a user frame containing `tool_result` with a nonempty `tool_use_id` supplies the tool's terminal time; transcript reading parses that result entry's ISO timestamp to milliseconds. Call frames, progress heartbeats, and turn-level result durations cannot supply it. Older emitters and malformed times leave the field absent.

Focused verification passed 347 tests with 1,529 assertions across OpenCode normalization/provider, Claude normalization/provider/transcript, shared validation, API contract, revision, and compatibility suites. Tests cover successful and failed results, separate call/result identities and times, classic/v2 live and history paths, disk transcript replay, missing/malformed timestamps, and stale running times. `bun run typecheck`, `bun run api:validate`, the actual contract compatibility check against `HEAD`, and `git diff --check` passed. API lint retains its existing `WorkspaceConflict.allOf` warning.

### Baseline investigation, 2026-09-15

The user approved continuing with the confirmed competing-correction and clamp-intent defects as the implementation baseline. The reported alternating oscillation remains unconfirmed; completion requires fixing and regression-testing the confirmed defects and covering the planned interactions, not claiming that the original oscillation was reproduced.

`tests/e2e/chat-follow-stability.e2e.ts` runs the existing UI in Chromium 151.0.7922.34 and WebKit 26.5. It seeds 40 assistant items through the existing test endpoint and appends eight more, separately in parent and child timelines. Test-only response instrumentation exposes the actual anchor controllers for sampling. An element-local interceptor records position assignments and their call stacks. The fixture attaches `follow-frames.json` with animation-frame samples of position, extent, viewport height, and follow intent, plus the assignment records. No production diagnostics or fixture server routes were added.

Observed before any scrolling implementation changes:

- All four passive runs recorded 16 position-changing assignments for eight appends, with eight second corrections in an already-recorded frame. Call stacks identified `renderNow` or `renderChildNow` followed by the respective scroll listener. For example, Chromium parent rendering assigned 5302 at extent 5999 and height 697; the scroll listener then assigned 5412 at extent 6109 with the same viewport height. Both movements were downward, with a growing extent. This establishes multiple writers responding to successive geometry measurements, not alternating movement.
- Parent latest activation during further appends did not reproduce alternating up/down movement. The existing child timeline has no latest control, so child latest activation has not been exercised.
- A real 4px upward wheel movement paused following in both engines and both timelines. The fixture then resized the viewport, grew the first item's height, and hid the transcript items to force an extent clamp. In all four runs the actual controller changed from paused to following when the position clamped to zero and the content fit the viewport. There was no intervening reader input. This reproduces the paused-intent clamp defect: `TimelineAnchorController.observe()` assigns `pinned = distance <= 1` for an upward movement, including the browser's clamp.
- The clamp itself is legitimate negative movement with a shrinking extent. These observations do not establish the reported stable-extent up/down jitter or its cause. Touch interruption and command completion remain unverified by this fixture.

Commands run: `bun run test:e2e tests/e2e/chat-follow-stability.e2e.ts --workers=1` completed four diagnostic cases; `bun test src/chat/anchor.test.ts src/chat/viewport.test.ts` passed 11 tests with 30 assertions. The browser cases currently collect baseline evidence, not regression assertions proving the requested fix. Tasks 1.1–1.3 remain unchecked pending the reproduction prerequisite and implementation verification.

### Coordinated outer scrolling verification, 2026-09-15

Tasks 1.1–1.3 now use the approved baseline above. `CoordinatedScrollOwner` owns automatic positioning for each parent/child scroller. Render, scroll observation, item and scroller resize, viewport changes, and activity toggles request work through it. Its frame timestamp budget permits at most one position-changing assignment per animation frame, including renders flushed within an existing frame. Prepending history now publishes its DOM and anchor correction together through the render scheduler. Owners disable native scroll anchoring on their managed elements and use immediate positioning instead of smooth latest animations.

The fixture now has eight assertion-bearing cases: Chromium and WebKit, desktop and touch layouts, parent and child. Each case covers passive appends, latest activation with an append in flight, a 4px upward interruption, cancellation of a latest request before its frame runs, viewport resize, intrinsic item growth, an extent clamp while paused, subsequent append, a command's observed running-to-completed transition, and activity expansion/collapse. The child has its own latest button. Desktop wheel input uses Playwright's native wheel path. Cross-engine touch interruption uses deterministic DOM touchstart/touchmove events plus the corresponding 4px scroll movement because Playwright has no cross-engine swipe API; it is not a physical-device gesture test.

Final frame-fixture run:

| Engine/layout/timeline | Sampled frames | Automatic writes | Maximum writes/frame | Stable-extent upward frames during passive/latest |
| --- | ---: | ---: | ---: | ---: |
| Chromium desktop parent | 154 | 28 | 1 | 0 |
| Chromium desktop child | 155 | 28 | 1 | 0 |
| Chromium touch parent | 163 | 28 | 1 | 0 |
| Chromium touch child | 155 | 28 | 1 | 0 |
| WebKit desktop parent | 139 | 28 | 1 | 0 |
| WebKit desktop child | 139 | 28 | 1 | 0 |
| WebKit touch parent | 134 | 28 | 1 | 0 |
| WebKit touch child | 134 | 28 | 1 | 0 |

All eight cases preserved paused intent through the extent clamp and later append, settled at the bottom while following, used no smooth latest call, and reported no browser page errors. `follow-frames.json` is attached on success or failure. Test-only bundle instrumentation samples the actual controllers and records correction stacks; production has no diagnostic logging. The original alternating oscillation remains unconfirmed. These results verify the competing-correction and clamp-intent fixes, not a new claim about the original report.

Checks:

- `bun run test:e2e tests/e2e/chat-follow-stability.e2e.ts --workers=1`: 8 passed in the final run.
- `bun test src/chat/anchor.test.ts src/chat/coordinated-scroll.test.ts src/chat/viewport.test.ts src/chat/ui.test.ts src/chat/lifecycle.test.ts`: 29 passed, 77 assertions. This includes repeated/clamped echoes, pre-frame wheel/touch/keyboard cancellation, nested ownership, horizontal preservation, prepend anchoring, lifecycle cancellation, and shared-frame correction budgeting.
- `bun run typecheck` and `git diff --check`: passed.
- All 12 cases in `chat-responsiveness.e2e.ts` passed after co-locating render and anchor correction, including hidden parent/child restoration, pinned resize without item measurement, prompt navigation, find, and selection.
- The selected existing panel/touch navigation run passed 29 cases and exposed a deferred-history-publication regression. After fixing that publication path, the focused history prepend/activity expansion, pinned streaming, and rotation tests all passed.
- A broader run also found an existing shell-output selector in `chat-panels.e2e.ts:130`, `.chat-tool-stream`, that no longer matches the concurrent renderer implementation. That renderer-test integration issue was reported to the owning agent and was not changed as part of tasks 1.1–1.3.

Shell integration API: construct one owner with a scroller, an anchor adapter, `measure(includeItems)`, an optional visibility gate, and an optional state-change callback. The adapter can be `TimelineAnchorController` or implement the exported `CoordinatedScrollAnchor` operations. Call `beforeMutation()` before changing geometry, `request(hasNewContent)` afterward or on resize, `latest()` for immediate next-frame following, and `cancel()`/`dispose()` at lifecycle boundaries. A renderer already inside requestAnimationFrame can call `flush(timestamp)` with that callback's timestamp; it shares the same correction budget. The owner leaves horizontal position unchanged. Registering nested shell owners automatically prevents their upward input from pausing an outer owner.

### Integrated shell frame verification, 2026-09-15

The extended `chat-follow-stability.e2e.ts` adds eight integrated shell cases alongside the eight existing outer-timeline cases. It uses normalized command items in parent conversations and Bash tool items in child conversations, on Chromium/WebKit in desktop/touch layouts. Test-only bundle instrumentation records each real coordinated-owner registration, samples the actual anchor adapter's follow intent and `ShellScrollOwner.snapshot()` reading target, and associates every intercepted vertical write with the owner whose `flush()` is executing. Assertions reject writes outside that owner, multiple automatic writes per frame, smooth corrections, and backward passive/latest motion at non-shrinking extent. The same registered shell owner must survive movement between inline and floating presentation. Frame and observation evidence is attached as `integrated-shell-frames.json` and `shell-scroll-observations.json`.

The integrated flow exercises passive append, latest with an append in flight, 4px upward input, pre-frame latest interruption, inline height adjustment, pop-out, floating resize, maximize/full-area append, paused authoritative-output clamping and regrowth, observed command completion, restore size, return inline, and a second paused pop-out/maximize/restore/return sequence. Desktop uses native wheel input except the explicitly synchronous pre-frame interruption. Touch uses the documented deterministic DOM touch sequence and corresponding scroll movement.

The full updated fixture run (`bun run test:e2e tests/e2e/chat-follow-stability.e2e.ts --workers=1`) produced **12 passed, 4 failed**. All eight existing outer cases passed. All four integrated touch cases passed, including the paused round trip, with one owner registration, a maximum of one automatic write per frame, no writes outside the registered owner, no stable-extent backward passive/latest motion, and no browser page errors. Their shell traces had 16 automatic writes each; their active outer timelines had one each. The four integrated desktop cases failed at the paused Restore size reading-position assertion, in both engines and both parent/child conversations.

The desktop failure is a reading-target loss during a legitimate geometry clamp, not evidence of the original alternating oscillation. In a recorded Chromium parent run, the shell's desired reading top was 2396. Pop-out clamped the actual top to 2143 with extent 2660 and viewport height 517, while the desired top remained 2396. Maximize raised the viewport height to 816 and clamped the actual top to 1844. The observation trace then recorded `anchor.pause()` changing the desired top from 2396 to 1844. Restore size returned the viewport height to 517 but left the actual/desired top at 1844, 299px above the allowed restored position of 2143. `CoordinatedScrollOwner.observe()` takes its pending-upward-input branch before its changed-extent branch; the stale pending intent therefore turns this later clamp into a new reading anchor. Following stays paused throughout, but the intended reading position is lost.

This reproducible defect was reported for a product fix. Task 5.3 remains unchecked. No production files were changed by this verification pass, and the original alternating oscillation remains unconfirmed.

### Responsiveness follow-up, 2026-09-15

After the main agent fixed the stale-pending-input maximize clamp, the full run exposed a 32px difference in the hidden parent reading-position test. Temporary browser geometry sampling reproduced it twice during a three-repeat responsiveness run. The failure had already happened before hiding: although the fixture assigned `scrollTop = 300`, its pre-hide baseline was 7967, exactly the bottom of extent 8575 with viewport height 608. On return, extent 8607 put the still-following viewport at 7999. That 32px movement persisted across 20 sampled frames; it was not a delayed restoration correction. Successful cases retained top 300 and the same first-item offsets before and after hiding.

The coordinator's changed-extent branch ignored an upward scroll when revealing earlier intrinsic-size content also changed the extent, then requested another bottom correction. The fix lets unaccounted upward movement reach anchor observation even when extent changes. Actual bottom clamps retain their earlier dedicated handling, and the owner's own writes still update its observed position in `flush()`. A new unit regression covers upward scrolling without a wheel event concurrent with extent growth. The browser test now also asserts that its pre-hide reading position is 300px, while retaining the original immediate `<3px` return-position assertion. No polling delay or larger tolerance was added.

Post-fix checks:

- `bun run test:e2e tests/e2e/chat-responsiveness.e2e.ts tests/e2e/chat-follow-stability.e2e.ts --workers=1`: **28 passed**, all 12 responsiveness cases and all 16 outer/integrated Chromium/WebKit frame cases. The frame cases continued to verify at most one automatic correction per scroller per frame and the paused maximize/restore/return path.
- `bun test src/chat/coordinated-scroll.test.ts src/chat/anchor.test.ts src/chat/viewport.test.ts src/chat/shell-output.test.ts`: **54 passed**, 205 assertions.
- `bun run typecheck`: passed.

The main agent's clamp fix is retained. Final full-suite verification and task 5.6 completion remain with the main agent.

### Final implementation verification, 2026-09-15

All implementation tasks are now complete. The final code uses the same coordinated owner for outer timelines and shell viewports, with stale gesture retirement and explicit clamp handling. The confirmed multiple-writer, paused-intent, maximize-reading-anchor, and intrinsic-layout upward-scroll defects have regression coverage. No claim is made that the originally reported alternating oscillation was reproduced.

Final checks:

- `bun run typecheck`: passed.
- The affected Chat and Find unit suites: **327 passed**, 13,104 assertions, across 18 files.
- `bun run test:e2e tests/e2e/chat-shell-scrollback.e2e.ts tests/e2e/chat-shell-output.e2e.ts --workers=1`: **87 passed** after the final coordinator change.
- The final responsiveness/frame run above: **28 passed**.
- Existing panel and Find suites: **41 passed** in the broader regression run. That run exposed the responsiveness defect documented above, which was fixed and reverified rather than accepted as an exception.
- `git diff --check`: passed.

Browser integration also verified pointer/keyboard sizing, both-dimensional window geometry, full-area touch output, correct parent/child labels, completed/failed/cancelled identity, selection and Find, hidden painting suspension and current-state restoration, navigation cleanup, and independent per-item geometry. An inventory refresh cannot remove the window's focus protection because coverage and deleted-conversation inertness now use separate composed reasons.

Long-output evidence uses 5,000 initial lines and 20 appends, retaining all 5,020 lines with 5,010 additional parsed input code units and 20 new line DOM writes. A separate 60-shell unit regression verifies zero shell paints and zero shell-body mutations across ten unrelated assistant updates. Screenshots and measured work counters are in `screenshots/`.

Earlier parallel verification had two long-output timeouts without a localized assertion failure. Named diagnostic phases were added; repeated focused runs and the final serial shell run passed without relaxing tests. That timeout remains unattributed and is recorded in the screenshot evidence README.
