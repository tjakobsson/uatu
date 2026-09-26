## Context

See proposal.md for why. This section covers only the state the approach
depends on.

**Reset formatting today.** `src/chat/composer-status.ts` already has the two
helpers the plan rows use: `resetClock(resetsAt, now)` gives a bare
`HH:MM` when the reset is under 24 hours away and `"<short weekday> HH:MM"`
otherwise; `relativeReset(resetsAt, now)` gives `"in 4d 11h"` /
`"in 2h 05m"` / `"in 35m"` / `"now"`. `planReadoutRows` combines them as
`resets Sat 21:00 · in 4d 11h`. The rate-limit standing does not use them.
It formats `new Date(resetsAt).toLocaleTimeString([], { hour, minute })`
inline in four places:

- `src/chat/ui.ts` ~2048: the readout's standing line
  (`${standing.message} Resets 23:00.`). This is the line in issue #429.
- `src/chat/ui.ts` ~2171: the `rateLimitLive` assistive-technology
  announcement.
- `src/chat/composer-status.ts` `rateLimitBadgeLabel`: the chip text
  (`Near rate limit · resets 23:00`).
- `src/chat/timeline-renderer.ts` ~997: the generic `notice` renderer. Rate-limit
  standings are filtered from the timeline (`isRateLimitStanding`), so this
  path is mostly unreached, but it is the same inline pattern.

The standing message itself comes from `src/chat/claude/normalization.ts`
~440 (`Approaching your ${kind} rate limit${utilization}.`) and carries
`resetsAt` as epoch ms. Formatting stays on the client, in the reader's
zone, as the existing comment in the notice renderer requires.

**Timestamps in the timeline.** Every `ConversationItem` has
`createdAt: number` (epoch ms, `src/chat/types.ts`). Its source per agent:

- Claude Code: `envelopeIdentity` in `src/chat/claude/normalization.ts`
  parses the SDK/transcript record's `timestamp`. On replay, records come
  from the native JSONL transcript (`src/chat/claude/transcript.ts`, which
  parses `record.timestamp`), so history keeps its real times. Live stream
  messages without a timestamp fall back to `Date.now()`. Accepted user
  prompts use the accept time (`provider.ts` ~813).
- OpenCode: v1 and v2 normalization take `info.time.created` /
  `part.time.created` (`timestamp(...)` in `src/chat/opencode/*`). Some
  usage-carrier paths default to `0` when the time is missing.

The renderer shows none of this today, apart from a per-item `title`
tooltip (`timestampAttribute`, `toLocaleString()`).

**Timeline assembly.** `TimelineRenderer.renderTimeline`
(`src/chat/timeline-renderer.ts`) builds a keyed node per visible item, then
assembles a top-level `ordered` list from `activitySegments(...)`. A segment
is either flat items or a group node, and accepted drafts plus the awaiting
line are appended after them. The list is reconciled into `target` with
an insert-before cursor walk. Group nodes are kept in `groupEntries`, and
stale ones are removed after the walk. The same class renders the main
timeline (`ui.ts` ~183) and the subagent drill-down (`ui.ts` ~289). Scroll
anchoring (`src/chat/anchor.ts`, geometry built in `ui.ts` ~592) measures
only `[data-chat-item-id]` elements. The scroller is `.chat-timeline`
(`overflow-y: auto`), and `#chat-items` is its content box.

**Slash menu.** `renderCommandMenu` in `src/chat/ui.ts` ~3457 renders each
suggestion as a `button.chat-command-option` grid with name, hint, and
description spans. `src/styles.css` ~6962 gives `.chat-command-hint` and
`.chat-command-description` `white-space: nowrap; overflow: hidden;
text-overflow: ellipsis`. The truncation is CSS only. No provider
shortens descriptions: Claude (`provider.ts` ~2399) and OpenCode v1/v2
pass them through whole. The same menu serves both agents.

## Goals / Non-Goals

**Goals:**
- One reset formatter used by every rate-limit surface and the plan rows.
- Day separators computed entirely client-side from existing `createdAt`,
  identical for every agent and for replayed or paged history.
- Wrapping slash descriptions with a CSS-first change.
- A conversation chooser grouped by day for every agent, from the
  timestamps the inventory already carries.

**Non-Goals:**
- No per-message time labels in the timeline. The existing hover tooltip
  stays (in the D5 format).
- No change to how agents stamp `createdAt`. Improving the live Claude
  fallback to `Date.now()` is out of scope.
- No change to the normalized standing message text or to the wire.
- No relative-date wording beyond "Today" / "Yesterday" (no "3 days ago").

## Decisions

### D1. Reset: one `resetMoment` formatter with a calendar-day rule (#429)

Change `resetClock` to decide by the reader's **local calendar day**
instead of "under 24 hours". The rule:
- Same local day as `now`: `HH:MM`.
- Any other local day: `<short weekday> HH:MM` (`Thu 23:00`). This is the
  existing shape, so the plan rows look the same. No date is added, however
  far out: rate-limit windows are at most a week long, and wherever the
  reset is stated at length the time remaining (`in 10d 4h`) says how far
  off it is.
- In the past (the standing is stale): the same day rule. `relativeReset`
  already says `now`.

Every clock time on these surfaces is 24-hour and zero-padded (`19:43`,
`02:06`) whatever the browser locale, built from the local hour and minute
(`clockTime`), never `toLocaleTimeString`, which gives `7:43 PM` in a
12-hour locale. Only the weekday name follows the locale
(`toLocaleDateString([], { weekday: "short" })`).

Add `resetMoment(resetsAt, now)` next to it, returning
`"<resetClock> · <relativeReset>"`. Then:
- Readout standing line and live announcement:
  `${message} Resets ${resetMoment}.`, for example "Approaching your 7-day
  (overage included) rate limit (81% used). Resets Thu 23:00 · in 3d 4h."
  Both call one shared `standingSentence(standing, now)` exported from
  `composer-status.ts`, which replaces the two inline copies in `ui.ts`.
- Chip (`rateLimitBadgeLabel`): `resets ${resetClock}` only. The chip is
  space-constrained, and the day is the part that removes the ambiguity.
- Timeline notice renderer: `weekdayClock(resetsAt)` — `"<short weekday>
  HH:MM"` (`Mon 23:00`) — with no relative part and no bare same-day
  clock. A notice is a durable timeline item: it is rendered once and kept
  (and replayed with history), so a relative "in 2h 05m" or a bare "14:00"
  baked at render time would read wrongly later ("Resets Mon 14:00 · now"
  on a week-old notice). The day separator above the notice (D2) gives its
  date, so the weekday is enough. Refreshing it on a tick was rejected as
  more machinery for a path that rate-limit standings, filtered from the
  timeline, mostly do not reach.

Local-day comparison compares `new Date(x)` year/month/date in the local
zone. It does not use the difference in ms, so DST days (23/25 h) are
handled.

*Alternatives:* (a) Leave `resetClock`'s 24 h rule and add a day only in
the warning. Rejected: at 23:30 a reset at 06:00 tomorrow would still read
as a bare "06:00" in the rows, which is the same ambiguity. (b) "Tomorrow
06:00". Rejected: the rows already use weekdays, and the issue asks for
consistency with them. (c) `Intl.RelativeTimeFormat`. Rejected: it
disagrees with the existing `in 4d 11h` style.

### D2. Day separators: keyed top-level nodes emitted during assembly (#427)

During top-level assembly in `renderTimeline`, the renderer tracks the
local day key (`YYYY-MM-DD` in the local zone) of each top-level unit:
- a flat item uses its `createdAt`
- a group uses its first member's `createdAt`
- an accepted draft uses the render time, since a draft is being sent now
- the awaiting line uses no time and never starts a day

When a unit's day differs from the previous unit's day, including the
first unit, the renderer pushes a separator node before it. A time later
than the reader's clock at render time is read as the render time: nothing
has happened in the future, so it is an agent clock running ahead of the
browser. Clamping every future time (rather than only a few minutes of it)
is the simplest rule that never creates a separator dated after "Today";
near midnight a message stamped 00:01 by an agent at the reader's 23:59
stays under "Today" and moves to the new day on the first render after
midnight. A time counts
as unknown when it is non-finite or earlier than `1e12` ms
(2001-09-09): missing times arrive as `0`, and anything that early is a
placeholder or a seconds-for-milliseconds slip. Dating that content
"1 January 1970" would be wrong. An unknown-time unit inherits the previous
day and never starts a separator.

- Separators are kept in a `dayEntries: Map<dayKey, HTMLElement>` and
  reconciled exactly like `groupEntries`: reuse by key, remove stale ones
  after the walk, and clear them on `reset`. A day key is unique within a
  conversation because items are ordered by conversation order (spec:
  "Timeline order follows the conversation's message order"). If clock
  skew ever makes a day recur, the second occurrence is skipped, so a
  day is never labelled twice.
- Markup:
  `<div class="chat-day-separator" data-find-skip data-chat-day="2026-09-25" role="separator" aria-label="Today, Friday 25 September"><time datetime="2026-09-25">Today</time></div>`.
  It has no `data-chat-item-id`, so anchoring, `[data-chat-item-id]`
  delegation, copy actions, and item find-reveal all ignore it
  automatically. `data-find-skip` is a generic marker the find text index
  (`src/find/text-index.ts`) skips, and the find engine's mutation observer
  ignores changes confined to such an element: ⌘F finds what was written,
  not "Today", and a midnight relabel cannot shift the match count under an
  open find bar.
- Label: "Today" / "Yesterday" by local-day difference from `now`.
  Otherwise the short weekday and the ISO date, `Sun 2026-09-20`: the
  weekday name from `toLocaleDateString([], { weekday: "short" })`, the
  date as `YYYY-MM-DD` from the local calendar fields (`localDayKey`, not
  `toISOString`, which is the UTC day). The ISO date always carries its
  year and reads the same in every locale. The English words match the
  rest of the UI's copy. The time zone is the browser's.
- The `aria-label` keeps the locale's long form, which reads better aloud
  than an ISO date: "Today, Friday 25 September" for today and yesterday,
  and the long date alone ("Sunday 20 September", with the year when not
  the current one) for older days.
- Clock injection: the renderer takes `now: () => number` (default
  `Date.now`) so unit tests control "today".
- **Day rollover:** after a render that emitted separators, the renderer
  keeps one `setTimeout` to the next local midnight (+1 s). The timer
  relabels existing `dayEntries` in place, changing text and aria-label
  only, with no re-render and no layout change beyond the label. The timer
  is cleared on `reset` or when no separator is left. A render leaves a
  timer already aimed at the coming midnight alone and does not relabel,
  so streaming re-renders (~50 ms) neither rewrite labels nor churn the
  timer; the renderer remembers the reader's day its labels were written
  against, and a render on a different day (a tab that slept past midnight
  before its timer ran) relabels and re-aims the timer.

**Sticky vs. static separators.** Separators are `position: sticky`
inside the `.chat-timeline` scroller. Only the date pill covers the
transcript: the separator row is transparent and `pointer-events: none`
(the pill keeps its own hits), so the text beside a pinned label stays
readable and can be tapped and selected. An earlier revision made the row a
full-width opaque band; on a phone that hid a whole line of the transcript
around a small label.

All separators are siblings in `#chat-items` and share one containing
block, so every separator already passed stays pinned, stacked at the top.
With a transparent row, a wider earlier pill would show around a narrower
newer one. A small watcher (`src/chat/pinned-day.ts`, one per scroller:
main timeline and drill-down) marks a separator `data-superseded` once the
next separator's pill reaches its pill, and the stylesheet hides a
superseded pill (`visibility: hidden`). At most one label is visible at the
top, and it is the day being read. The watcher is purely geometric (pill
rects compared in order), runs at most once per animation frame on scroll,
on resize of the scroller or its item list, and on a change to the list's
children, and measures nothing while fewer than two separators exist.
Scrolling back up past a day boundary clears the mark, so the earlier
label returns.

*Alternatives considered for the stacking:*
- Wrapping each day's items in a day section, so each sticky separator is
  bounded by its own day and pushed off by the next one: the natural CSS
  answer, but it moves every item under a new parent. Scroll anchoring,
  `[data-chat-item-id]` lookups, keyed reconciliation, the prompt rail,
  copy, find, and the drill-down all assume items are direct children of
  `#chat-items`. Rejected as too large and risky for a fix.
- CSS only: scroll-driven animations could fade an older label, but
  their behaviour on stuck elements is not dependable, and older iOS
  Safari lacks them. A fixed pill width wide enough for any label wastes
  space and still depends on the locale. Rejected.

A sticky box pins at the scroller's padding edge. The row therefore pins
that far higher (`top: calc(-1 * var(--chat-timeline-inset-top))`) and
carries the same padding itself, so the stuck pill sits at the same height
as a pill in flow, and the space reserved below stays one fixed band from
the scroller's top edge. The row paints nothing outside its own box (no
shadow, no negative margin), so an unstuck separator never covers the end
of the previous day's last row; the cost is a little more space above an
in-flow separator.

Because the pinned label covers part of the top of the scroller, every
scroll to a target must land below it: while separators exist the
scroller's `scroll-padding-top` is the pinned row's height plus a small
gap. The coordinated
scroll's reveal and the ⌘F match reveal already honour
`scroll-padding-top`, and the prompt rail's jump uses it as its offset. This gives the "which day am I reading" context
the issue asks for without an extra floating element; the only scroll
work is the watcher's per-frame comparison of the few pill rects.
The main timeline and the drill-down both get it, since both scroll
`.chat-timeline`-like containers. The implementer must check the scroller's
existing top padding/inset, which the header notes at `styles.css` ~437
describe for the preview. The drill-down needs the same check.

*Alternatives considered:*
- A floating "current day" chip driven by scroll position: more code, and
  it would need to cooperate with `coordinated-scroll`/anchor restore.
  Rejected.
- Static separators only: they lose context while scrolling back inside a
  long day, which is the case the issue calls out. Rejected.
- Separators rendered as `ConversationItem`s in the projection: that would
  leak presentation into the shared model, touch grouping and anchoring,
  and need new item types. Rejected.
- Separators only where the day changes (none above the first message):
  a conversation reopened from last week would then show no date at all.
  Rejected. The spec requires one above the first day.

### D3. Slash descriptions always wrap in full (#424)

This is a CSS-only change in `src/styles.css`, based on the user's
decision: always wrap fully, with no clamp.
- `.chat-command-hint, .chat-command-description`: remove `nowrap`,
  `overflow: hidden` and `text-overflow: ellipsis`, for `white-space:
  normal`. The description also gets `overflow-wrap: anywhere` so long
  unbroken paths and URLs wrap.
- The option's two-column grid (`minmax(max-content, auto) 1fr`) let a very
  long command name force horizontal overflow on a narrow touch panel, and
  a shrinkable name column would instead squeeze the argument hint into a
  sliver wrapping one character per line. The option becomes a wrapping
  flex row: the name shrinks and wraps (`overflow-wrap: anywhere`), the
  hint drops onto its own line when it does not fit whole beside the name,
  and the description takes a full line.
- An argument hint wraps only at its spaces. `overflow-wrap: anywhere` on
  the hint split tokens such as `[--comment]` and left a lone `]` on a
  line, and even normal line breaking may break after a hyphen or slash.
  `renderCommandMenu` therefore wraps each space-separated token in a
  `span.chat-command-hint-token`, an `inline-block` with `max-width: 100%`
  and `overflow-wrap: anywhere`: an atomic box on the hint's lines, broken
  inside only when the token alone is wider than the whole line. The hint
  itself has `flex: 1 1 auto; max-width: 100%`, so its basis is its whole
  width and it shares the name's line only when it fits there entire.
  A word joiner between characters was considered instead of spans; it
  changes the hint's text for no gain.
- Keyboard highlight: the existing
  `scrollIntoView({ block: "nearest" })` on the active option already
  keeps a tall highlighted option in view inside the scrolling menu
  (`max-height: min(22rem, 48vh)`). The e2e test covers it.

*Alternative considered:* clamp non-highlighted descriptions to three lines
and show the full text only for the highlighted suggestion. This was
rejected by the user decision: every description is visible without
navigating. The trade-off is that large skill catalogs with very long
descriptions show fewer suggestions per screen, and the menu scrolls.

### D4. The conversation chooser is grouped by last-activity day

**Context.** The chooser is the native `<select id="chat-conversation-select">`
in the chat header, and the touch layout uses the same element with the
platform's picker. `patchChooser` in `src/chat/ui.ts` fills it through
`patchConversationOptions` (`src/chat/inventory-reconciler.ts`), which
patches options by id so the selected option element survives. Three other
paths rewrite one option's text directly (`conversation.updated`, rename,
prompt acceptance), and they drop the agent suffix that `patchChooser` adds.
Every `ConversationSummary` already carries `createdAt` and `updatedAt`
(epoch ms), and the router's merged list is sorted newest `updatedAt` first
(`src/chat/agents.ts`):
- OpenCode v1 and v2 map `session.time.created` / `session.time.updated`
  (v2 uses `0` when a time is missing).
- Claude Code transcripts use the first and last mainline entry timestamps
  (the file mtime for a transcript too large to read whole). Sessions not
  yet written use their creation time and bump `updatedAt` on rename or
  title change.
So no server, wire, or provider change is needed.

**OpenCode's rule.** The OpenCode 2.x TUI session list files top-level
sessions by `new Date(time.updated).toDateString()` and heads today's group
"Today" and the others with the date string. Its rows show no time; the
user asked for each conversation's time as well.

**Decision.**
- Group by the reader-local day of `updatedAt` (last activity), matching
  OpenCode and the order the list is already in. `createdAt` was rejected:
  a long-running conversation from last week that is active today belongs
  with today's work, and grouping by creation would break the newest-first
  order into out-of-order days.
- Headings use the timeline separators' `dayLabel` ("Today", "Yesterday",
  otherwise short weekday and ISO date, `Sun 2026-09-20`). The chat
  surface then states a day one way everywhere, rather than OpenCode's
  `toDateString` form.
- Keep the native `<select>` and file options into
  `<optgroup label="…" data-chat-day="YYYY-MM-DD">`. Optgroup labels are
  the platform's grouping for a select: they are announced by assistive
  technology, rendered as headings by desktop browsers and by the iOS and
  Android pickers, and are not selectable. Replacing the select with a custom
  listbox would re-implement keyboard, touch, and accessibility behaviour
  the native control already gives, and would touch the inventory-awareness,
  deleted-conversation, and startup-placeholder code that works on the
  select. Rejected.
- Each option's label is `title[ · agent] · HH:MM`, the clock time of the
  last activity (`clockTime`: 24-hour, zero-padded, in every locale), for
  example `Tick · OpenCode · 19:43`. The heading gives the
  day, so the time alone is unambiguous. One `conversationOptionLabel`
  function serves `patchChooser` and the three direct relabel paths. As a
  side effect, those paths keep the agent suffix too.
- Shared rules with D2: a time later than the reader's clock is read as
  now (`Math.min(updatedAt, now)`), and a time that is not `knownTime`
  (non-finite or before `1e12`) is undated. Undated conversations follow the
  dated days, under an "Undated" heading only when some conversation is
  dated. A list with nothing dated stays flat, as before this change. The
  e2e fixture's counter timestamps rely on this.
- `patchConversationOptions` gains an optional `group` callback. It reuses
  option and optgroup elements by key, rebuilds the layout only when the
  order or membership differs, removes emptied headings, and restores the
  select's value when a move would have changed it. Placeholders and a
  retained startup option stay outside the groups, as before.
- **Day rollover:** each chooser patch re-arms one timeout to the next
  local midnight (+1 s), which re-runs the patch so "Today" becomes
  "Yesterday" with no inventory change.
- The direct relabel paths update only the option text. Moving a
  conversation to another heading waits for the next inventory reconcile
  (an inventory invalidation on the brokered stream, a lifecycle recovery,
  or the next patch), so a heading can briefly lag a label.

*Trade-off:* the collapsed select shows the selected option's label, so
the header now shows the selected conversation's last-activity time after
its title. The header truncates long labels as before.

### D5. One 24-hour clock across the chat surface

D1, D2 and D4 made the reset, day, and picker times 24-hour and ISO; the
rest of the chat surface still used `toLocaleTimeString` /
`toLocaleString`, so a 12-hour locale showed "as of 7:43 PM" beside
"Resets 23:00". Every user-visible time in `src/chat` now goes through the
`dates.ts` helpers:
- `clockTime` ("19:43"): the plan readout's and usage pane's "as of"
  (`usageAsOf`), the cost tally's "since" on the same local day
  (`sessionTotalsTitle`), and a wakeup firing today.
- `weekdayClock` ("Mon 19:43"): the cost tally's "since" on any earlier
  local day (the reader's calendar day decides, as for the reset and day
  labels, not 24 hours elapsed: a tally begun at 23:00 reads "since Fri
  23:00" at 00:30), and a wakeup firing within the coming six days.
- `dateTime` ("Sun 2026-09-20 19:43", new): a wakeup a week or more out
  (replacing "1 Oct 09:00", with the ISO date for the same reason D1's
  weekday alone would be ambiguous there), the wakeup row's tooltip, the
  timeline items' hover tooltip, and the floating shell window's
  completion time. These replace `toLocaleString()`, which also showed
  seconds; a tooltip to the minute matches everything else.

The composer's scheduled status and the wakeup rows reuse
`wakeupFireTime`, so they change with it. Number formatting
(`toLocaleString()` on token counts and currency) is not a time and stays
locale-formatted. Aria-labels that carry these times use the same text,
which reads unambiguously aloud.

## Risks / Trade-offs

- [Existing renderer tests assert exact top-level children, and fixtures
  use tiny epochs like `createdAt: 1`] → Those epochs count as unknown
  times, so no separator appears. The exception is an accepted draft, which
  is dated now and opens a "Today" separator. The three draft-ordering
  assertions look past separators. The e2e order check in
  `chat-claude-polish.e2e.ts:167` already selects `[data-chat-item-id]`.
- [A sticky separator may overlap the first line of content, or the
  jump-to-latest / requests pill] → Give the separator a compact fixed
  height with only its pill opaque, reserve that height as
  `scroll-padding-top` so scrolled-to targets land below it, and verify in
  both desktop split and touch layouts in e2e screenshots.
- [Pinned labels of earlier days stack behind the current one] → The
  `pinned-day.ts` watcher hides a label once the next day's label reaches
  it; e2e checks that only one label shows when two days' separators are
  both at the top.
- [Find-in-surface would match "Today" / weekday text, and a midnight
  relabel would shift the count under an open bar] → Separators carry
  `data-find-skip` and are excluded from the chat find index.
- [Clock skew between agent and client, or items with a fallback
  `Date.now()`, could put a live item on a different day than its
  neighbours] → The separator reflects what the item claims, except that a
  time ahead of the reader's clock is read as now. Skipping a recurring day
  key prevents duplicate labels.
- [Very long skill descriptions make each suggestion tall] → The menu is
  height-capped and scrolls, and the highlighted suggestion is scrolled
  into view. This was accepted by the user decision.
- [The calendar-day rule changes the plan rows for resets 0–24 h away that
  fall tomorrow] → This is intended, and the spec scenario covers it.
  Update `composer-status.test.ts` expectations.

- [A native `<optgroup>` cannot be styled, and its popup cannot be
  captured in an e2e screenshot] → The platform's heading style is
  accepted. The e2e asserts the DOM structure, and the evidence screenshot
  shows the same options as an in-page list box.
- [Rewriting option labels as the last-activity time changes] → Options
  are patched in place by id, and the selection is restored after any
  move, so an open chooser keeps its selection.

## Migration Plan

Client-only. No data, wire, or config migration. Rollback is a revert.

## Open Questions

None.
