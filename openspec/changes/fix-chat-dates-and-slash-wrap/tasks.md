## 1. Rate-limit reset names its day (#429)

- [x] 1.1 In `src/chat/dates.ts` (a new leaf module that `composer-status.ts` imports from, which avoids a composer-status ↔ timeline-renderer import cycle), switch `resetClock` to the local calendar-day rule (same day → `HH:MM`; 1–6 days → weekday + time; ≥7 days → weekday + day + month + time) and add `resetMoment(resetsAt, now)` (`<clock> · <relative>`) and `standingSentence(standing, now)`; verify with new `composer-status.test.ts` cases for later-today, 23:30→06:00 next day, 3 days out, 7+ days out, past reset, and a DST-boundary day, all with an injected `now`
- [x] 1.2 Make `rateLimitBadgeLabel` use `resetClock` and update `planReadoutRows` expectations; verify `bun test src/chat/composer-status.test.ts` passes, including a chip label that names the weekday for a next-day reset
- [x] 1.3 In `src/chat/ui.ts`, replace the inline `toLocaleTimeString` reset text in the readout standing line (~2048) and the `rateLimitLive` announcement (~2171) with `standingSentence`; verify by grep that no `Resets ${new Date(` remains in `src/chat/ui.ts`
- [x] 1.4 In `src/chat/timeline-renderer.ts`, format the notice renderer's reset (~997) with `resetClock` + `relativeReset`; verify a `timeline-renderer.test.ts` case for a notice with a next-day `resetsAt` renders the weekday
- [x] 1.5 Extend `tests/e2e/chat-claude-polish.e2e.ts` with a standing whose reset is on a later day and assert the readout standing line and chip name the weekday and the relative time; verify the spec scenarios under "A rate-limit reset names its day when it is not today" pass

## 2. Day separators in the timeline (#427)

- [x] 2.1 Add local-day helpers (day key, "Today"/"Yesterday"/weekday-date label with year when not current) in `src/chat/timeline-renderer.ts` or a small colocated module; verify unit tests for today, yesterday, same year, previous year, and 23:50/00:10 straddling midnight with an injected `now`
- [x] 2.2 Add an injectable `now` to `TimelineRenderer`, and emit keyed `.chat-day-separator` nodes (`dayEntries`, reconciled like `groupEntries`) during top-level assembly per design D2 (flat item / group first member / draft = now / awaiting never; unknown `createdAt` inherits; recurring day skipped); verify new renderer tests: multi-day conversation, single past day, group spanning a boundary, unknown timestamps, no duplicate label, separators removed when their items leave
- [x] 2.3 Update existing `timeline-renderer.test.ts` assertions that map `host.children` so they ignore or expect separators; verify `bun test src/chat/timeline-renderer.test.ts src/chat/question-form.test.ts` passes
- [x] 2.4 Arm a single next-local-midnight relabel timer per renderer (cleared on reset, re-armed per render) that updates separator text and aria-label in place; verify a unit test with fake timers that "Today" becomes "Yesterday" without a render
- [x] 2.5 Style `.chat-day-separator` in `src/styles.css` (sticky `top: 0` in the timeline scroller, opaque surface background, compact, z-index below overlays; desktop and touch); verify visually via the e2e in 2.6 and that the scroll-anchoring suite (`tests/e2e/chat-follow-stability.e2e.ts`) still passes
- [x] 2.6 Add an e2e in `tests/e2e/chat.e2e.ts` (fixture with items across three days, including a replayed conversation) asserting separator labels and order, and that after scrolling up inside a long day its separator stays visible at the top of the timeline; verify it passes on desktop, plus a touch-layout case in `tests/e2e/chat-touch.e2e.ts`

## 3. Wrapped slash-command descriptions (#424)

- [x] 3.1 In `src/styles.css`, make `.chat-command-hint`/`.chat-command-description` wrap in full (`white-space: normal; overflow-wrap: anywhere`, no clamp, no ellipsis) and let the name column shrink (`minmax(0, max-content)`, name `overflow-wrap: anywhere`); verify via 3.2
- [x] 3.2 Extend the slash-command e2e in `tests/e2e/chat.e2e.ts` with commands whose descriptions span several lines: assert each description is taller than one line and fully shown (`scrollHeight <= clientHeight`, `scrollWidth <= clientWidth`), the menu does not scroll horizontally, and moving the highlight with ArrowDown/ArrowUp keeps the active option inside the menu's visible area; verify it passes

## 4. Verification

- [x] 4.1 Run `bun test` and `bun test:e2e` (or the touched chat e2e files) and verify both pass; capture PR screenshots with `UATU_E2E_SCREENSHOTS_DIR=openspec/changes/fix-chat-dates-and-slash-wrap/screenshots`
- [x] 4.2 Run `openspec validate fix-chat-dates-and-slash-wrap --strict` and verify it reports the change as valid

## 5. Review follow-ups

- [x] 5.1 State a timeline notice's reset absolutely (`resetDate`: weekday, date, clock; no relative part); verify `dates.test.ts` and the renderer notice test
- [x] 5.2 Reserve the pinned separator as the timeline's `scroll-padding-top` and use it as the prompt rail's jump offset; verify in `chat.e2e.ts` that a rail jump and a ⌘F match land below the pinned band
- [x] 5.3 Pin the separator band to the scroller's top edge (negative `top`, own top padding) with no shadow or negative margin reaching outside its box; verify in `chat.e2e.ts` that an unstuck separator does not overlap the previous row
- [x] 5.4 Mark separators `data-find-skip`, skip them in the find text index, and ignore mutations confined to them; verify `text-index.test.ts`, `preview-engine.test.ts`, and the find counts in `chat.e2e.ts`
- [x] 5.5 Lay slash options out as a wrapping flex row so the hint drops below a long name; verify the touch e2e hint width
- [x] 5.6 Read a time ahead of the reader's clock as now; verify a renderer test at 23:59 with 00:01/00:04 items
- [x] 5.7 Relabel separators and re-aim the midnight timer only when the reader's day changes; verify a renderer test over repeated streaming renders
- [x] 5.8 Drop `composer-status.ts`'s re-export of the date helpers; point its test at `src/chat/dates.ts`
- [x] 5.9 Pin only the day label, not a full-width band: make the separator row transparent and `pointer-events: none` with only the pill opaque, and add `src/chat/pinned-day.ts`, which marks a pinned separator `data-superseded` (its pill hidden) once the next day's pill reaches it, for the main timeline and the drill-down; verify `pinned-day.test.ts`, and in `chat.e2e.ts`/`chat-touch.e2e.ts` that text beside the pinned label is hit by `elementFromPoint`, that only one label shows when two days' separators are at the top, and that jump and ⌘F targets still land below the pinned row

## 6. Conversation chooser grouped by date

- [x] 6.1 Move `knownTime` to `src/chat/dates.ts` and add `clockTime`; verify `dates.test.ts`
- [x] 6.2 Add `conversationDayGroup` and `conversationActivitySuffix` and teach `patchConversationOptions` an optional day grouping into keyed `<optgroup data-chat-day>` headings (reuse by key, rebuild only when the layout differs, remove emptied headings, restore the selection, trailing "Undated" heading only beside dated days); verify `inventory-reconciler.test.ts` cases for today/yesterday/older/other year, a future time, undated, a move to today, a flat all-undated list, and a midnight relabel
- [x] 6.3 In `src/chat/ui.ts`, use one `conversationOptionLabel` (title, agent when several, last-activity time) for `patchChooser` and the three direct relabel paths, group with `conversationDayGroup`, and re-patch at the next local midnight; verify `bun test src/chat/ui.test.ts src/chat/lifecycle.test.ts src/chat/inventory-presentation.test.ts`
- [x] 6.4 Let the e2e fixture's `seed` take `updatedAt`; add a desktop test in `tests/e2e/chat-agents.e2e.ts` (OpenCode and Claude Code conversations over three days, headings, order, labels with times) that captures `conversation-picker-days`, and a touch test in `tests/e2e/chat-touch.e2e.ts`; verify both pass

## 7. ISO dates, 24-hour times, and whole slash hints

- [x] 7.1 In `src/chat/dates.ts`, build `clockTime` from the local hour and minute (24-hour, zero-padded, every locale), add `weekdayClock` ("Mon 23:00"), make `resetClock` bare on the same local day and weekday + time on any other day (no date, however far out), and make `dayLabel` "Today" / "Yesterday" / short weekday + ISO `YYYY-MM-DD` from local fields; state the timeline notice's reset with `weekdayClock` (replacing `resetDate`) and keep the separator `aria-label` in the locale's long form; verify `dates.test.ts`, `composer-status.test.ts`, `inventory-reconciler.test.ts`, and `timeline-renderer.test.ts`
- [x] 7.2 Update the e2e expectations for day separators (`chat.e2e.ts`), picker headings and entry times (`chat-agents.e2e.ts`, `chat-touch.e2e.ts`), and reset text (`chat-claude-polish.e2e.ts`) to the 24-hour and ISO forms; verify they pass and regenerate `conversation-picker-days`, `rate-limit-reset-names-its-day`, and the day-separator screenshots
- [x] 7.3 Render each space-separated argument-hint token as an `inline-block` `span.chat-command-hint-token` (`max-width: 100%`, `overflow-wrap: anywhere`) and give the hint `flex: 1 1 auto; max-width: 100%` in place of `overflow-wrap: anywhere` and the 8rem basis; verify in `chat-touch.e2e.ts` that every token of a four-token hint stays on one line, the hint keeps its text, and only a token wider than the menu breaks, with no horizontal overflow; regenerate the slash screenshots
- [x] 7.4 Route every remaining user-visible chat time through `dates.ts`: `clockTime` for `usageAsOf` and a same-day `sessionTotalsTitle`, `weekdayClock` for an older "since", `wakeupFireTime` on `clockTime`/`weekdayClock`/new `dateTime` ("Sun 2026-09-20 19:43"), and `dateTime` for the wakeup row tooltip, the timeline item tooltip, and the floating shell window's completion time; verify `dates.test.ts`, `scheduled-wakeups.test.ts`, `composer-status.test.ts`, `shell-output-window.test.ts`, `ui.test.ts`, `timeline-renderer.test.ts` (including a tooltip case), and the e2e "as of", wakeup, and shell-window expectations in `chat-claude-polish.e2e.ts`, `sidebar.e2e.ts`, and `chat-shell-scrollback.e2e.ts`
