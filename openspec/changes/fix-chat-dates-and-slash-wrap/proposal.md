## Why

Three small Chat defects make the surface harder to read than it should be,
and the conversation chooser has the same missing-dates gap.
The rate-limit standing says "Resets 23:00." even when the reset is days
away (#429), while the plan rows beside it already say "resets Sat 21:00 ·
in 4d 11h". A conversation's history carries no dates at all, so a
multi-day or reopened conversation has no temporal context beyond a hover
tooltip per item (#427). The slash-command picker cuts every description to
one ellipsized line, so commands like `/code-review` cannot be told apart
from their descriptions (#424). All three are present in the latest stable
release (`v0.7.0`). The conversation chooser lists conversations with no
dates or times either, so for both OpenCode and Claude Code the reader
cannot tell last week's conversation from today's without opening it.
OpenCode's own session list groups sessions by day.

## What Changes

- **Rate-limit reset wording (#429).** Every place a rate-limit standing
  states its reset — the plan readout's standing line, the composer chip
  label, and the assistive-technology announcement — uses one shared reset
  formatter. The reset is a bare clock time
  only when it falls on the reader's current local calendar day; otherwise
  it carries the weekday. Times are 24-hour `HH:MM` in every locale. The readout's standing line and the announcement also state
  the relative time until the reset, matching the plan rows. The plan rows'
  existing `resetClock` switches from a "within 24 hours" rule to the same
  calendar-day rule, so a reset tomorrow evening is no longer shown as a bare
  time that reads as today. A notice kept in the timeline states its reset
  by weekday and clock time, nothing relative, so it stays true when read
  or replayed later; the day separator above it gives the date.
- **Day separators in conversation history (#427).** The timeline (main
  conversation and subagent drill-down, every agent) places a day separator
  at the start of each local calendar day's run of content — "Today",
  "Yesterday", or a short weekday and ISO date such as "Sun 2026-09-20" —
  including the first day shown.
  Separators stick to the top of the transcript while their day is being
  read, so date context survives scrolling back through long conversations.
  Labels are computed in the reader's time zone (weekday names in the
  reader's locale) and are refreshed
  when the local day rolls over.
- **Wrapped slash-command descriptions (#424).** Slash-command suggestions
  wrap their description (and argument hint, at its spaces only) onto
  further lines instead of truncating to one ellipsized line; every suggestion shows its whole
  description, and the list scrolls to keep the keyboard highlight in view.
- **A conversation chooser grouped by date.** The chooser files every
  agent's conversations under headings for the local day of their last
  activity ("Today", "Yesterday", or "Sun 2026-09-20"), newest
  first, like OpenCode's session list. Each entry also shows its
  last-activity time. The native select keeps working on desktop and
  touch; the headings are its option groups.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chat-agents`: adds a requirement that the conversation chooser groups
  every agent's conversations by the local day of their last activity and
  shows each one's last-activity time.

- `claude-code-chat`: adds a requirement that a rate-limit standing's reset
  names its day whenever the reset is not on the reader's current day, and
  is phrased consistently wherever the standing is stated.
- `opencode-chat`: adds requirements (shared Chat surface, every agent) for
  day separators in the conversation timeline and for slash-command
  suggestions that show their descriptions wrapped rather than truncated.

## Impact

- Client-only change; no wire, API, provider, or normalization changes.
  Items already carry `createdAt` for both Claude Code (transcript
  `timestamp` on replay, SDK/accept time live) and OpenCode (`info.time.created`).
- Code: `src/chat/composer-status.ts` (reset formatter, `resetClock`,
  `rateLimitBadgeLabel`), `src/chat/ui.ts` (readout standing line, live
  announcement, day-rollover relabel), `src/chat/timeline-renderer.ts`
  (notice reset text, day separators in top-level assembly),
  `src/chat/inventory-reconciler.ts` and `src/chat/ui.ts` (chooser day
  groups, labels, and the midnight regroup), `src/chat/dates.ts` (shared
  `knownTime` and `clockTime`),
  `src/styles.css` (separator styling, command-menu wrapping).
- Tests: colocated unit tests in `composer-status.test.ts`,
  `timeline-renderer.test.ts`; e2e additions in `tests/e2e/chat.e2e.ts`
  (slash menu, day separators) and `tests/e2e/chat-claude-polish.e2e.ts`
  (rate-limit reset wording), `tests/e2e/chat-agents.e2e.ts` and
  `tests/e2e/chat-touch.e2e.ts` (chooser day groups for both agents), with
  the fixture's `seed` taking an optional `updatedAt`.
- Release notes: visible `fix(chat)` entries; each defect exists in `v0.7.0`,
  and the chooser has shown no dates since before `v0.7.0`.
