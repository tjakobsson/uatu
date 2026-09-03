## Why

While an agent works, the timeline shows every step as its own flat row — "Thinking", "Thought", "Bash …", "WebSearch running" — ten or twenty lines that scroll past faster than they can be read. The reader wanted the timeline calm: one line that says work is happening, opened on demand to inspect the steps. Finished runs already collapse behind a group line; the live tail is the one run that does not, and it is the one on screen most of the time.

## What Changes

- The trailing run of activity in a still-running turn collapses behind one live group line (a pulsing status dot, "Working · 20s", and the step currently in flight) instead of rendering flat. Clicking it opens the member rows; an opened live group stays open when the turn finishes and the line settles into today's "N steps · …" summary.
- The separate "waiting for first response" row and the live group become one element: the same line carries the turn from "nothing back yet" through the steps to done.
- A finished group line gains a status dot: neutral when every step finished cleanly, red when any step inside failed. The text stays muted; no header tint.
- Inside an opened live group, a running tool with output still auto-opens so its streaming tail is visible.
- Motion honours `prefers-reduced-motion`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `opencode-chat`: the requirement *Chat presents turns as readable conversation with inspectable activity* — the live tail of activity is collapsed behind a working line rather than shown flat, and group lines carry a status dot.

## Impact

- `src/chat/timeline-renderer.ts` — `activitySegments` (live-tail rule), group line markup, group summary for the live form; the waiting row moves into the renderer.
- `src/chat/ui.ts` — retire `#chat-waiting` sync in favour of the live group; `expanded` bookkeeping unchanged.
- `src/index.html`, `src/styles.css` — waiting-row markup removed, group line dot + pulse.
- Tests: `timeline-renderer.test.ts` grouping suite; `tests/e2e/chat-claude-polish.e2e.ts` ("live tail stays flat" assertion inverts), `tests/e2e/chat-panels.e2e.ts`.
- Both agents (OpenCode and Claude Code) share this renderer; behaviour changes for both.
