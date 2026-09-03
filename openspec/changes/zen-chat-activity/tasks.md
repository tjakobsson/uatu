## 1. Baseline

- [x] 1.1 Capture before screenshots of a live turn with a flat tail and of a finished group at desktop (1400x1000) and phone width; save as `screenshots/before-live-tail-flat-desktop.png`, `screenshots/before-live-tail-flat-phone.png`, `screenshots/before-finished-group-desktop.png`, and verify the files exist.

## 2. Renderer

- [x] 2.1 Move the "awaiting first response" predicate from `ui.ts` into `timeline-renderer.ts` as a pure function over items + status; verify with a unit test that a prompt followed only by turn_status / context_report / compaction / empty-markdown carriers still counts as awaiting.
- [x] 2.2 Change `activitySegments` so the trailing run of a live turn becomes a group from its first member (D1) and emits an empty live group when awaiting (D3); verify with unit tests for: one running step collapses; non-tail runs still need `GROUP_MIN` and finished members; an awaiting turn yields an empty live group.
- [x] 2.3 Render the live group header: status dot, "Working · Ns" from a turn-elapsed argument, and the in-flight step's label + subject (D4); verify with unit tests for the label with and without a subject and for the elapsed formatting.
- [x] 2.4 Compute group outcome (`live` / `clean` / `failed`) from member states and set it as a data attribute; verify with unit tests for a clean finished group, a group with one failed member, and a live group whose member fails mid-turn.
- [x] 2.5 Confirm an opened live group stays open at settle and a running member with output is open inside the group (D2, D6); verify with unit tests extending "finishing the turn groups the run without losing member nodes".

## 3. Surface

- [x] 3.1 Delete `#chat-waiting` markup and the `syncWaiting` path in `ui.ts`; pass turn-elapsed into `render()` and tick the live label once a second without a full render; verify `bun test` passes and no `chat-waiting` selector remains in `src/`.
- [x] 3.2 Styles: `.chat-group-dot` with live pulse / neutral / failed colours, reduced-motion guard, touch-mode sizing; verify visually in 4.1 screenshots.

## 4. End-to-end and screenshots

- [x] 4.1 Update `chat-claude-polish.e2e.ts` ("live tail stays flat" → live tail collapses, header names the in-flight step) and `chat-panels.e2e.ts`; add e2e for: awaiting → first step joins the same line, open-live-then-finish stays open, failed member reddens the dot, reduced-motion stills the pulse; verify `bun test:e2e` passes for the chat files.
- [x] 4.2 Capture after screenshots at desktop and phone width: `screenshots/after-working-line-closed-desktop.png`, `screenshots/after-working-line-open-desktop.png`, `screenshots/after-finished-group-failed-dot-desktop.png`, `screenshots/after-working-line-phone.png`; verify the files exist and pair with the before shots.
