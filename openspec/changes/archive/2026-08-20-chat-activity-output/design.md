## Context

See `proposal.md` — Why. Two facts shape the approach.

- `normalization.ts` already routes `session.next.tool.progress` to
  `normalizeToolEvent`, which reads `data.content` — but the tool item keeps
  only status and final output, so the streamed content is effectively
  discarded between events.
- `renderTool` in `timeline-renderer.ts` renders a tool's output as one `<pre>`
  inside a collapsed `<details>`. There is no truncation in the file.

## Goals / Non-Goals

**Goals:**
- A running tool shows its tail from the progress content already received.
- A finished tool's output is bounded with a show-more.
- The live tail updates the existing entry in place — no duplicate rows.

**Non-Goals:**
- A live terminal. This is the activity row's output.
- Changing tool summaries or which tools render.

## Decisions

**Carry streamed output on the tool item; render its tail while running.** The
progress event already arrives; keep its content on the item so the renderer
has a live body. The tail — the last N lines — is what conveys progress without
unbounding the row. Alternative considered: a separate streaming channel for
tool output — a second update path for data the projection already carries.

**Bound the finished body with a show-more, not a raw dump.** A completed tool
renders a summary and a bounded preview; the full output is one action away.
The bound is line-count, applied at render, with the full text kept for the
expand. Alternative considered: leave the collapsed-whole behaviour — which is
the defect: all or nothing, defaulting to nothing.

**The show-more is the reusable primitive.** `chat-change-review`'s card diff
can lean on the same bound for large patches, so the bound lives where any
activity body can use it, not only tool output.

## Risks / Trade-offs

- **A live tail re-renders on every progress event, on the busiest path.** →
  Update the existing entry in place from the coalesced projection update, as
  the lifecycle already does; do not add a per-event render channel.
- **Bounding hides output a user wanted.** → The bound is a preview with an
  explicit show-more, never a silent truncation; the full text is always one
  action away and never dropped.
- **The tail's height must not steal the reading position.** → It updates
  within the existing entry, which the timeline's anchor logic already accounts
  for; a running tool the user has scrolled past must not pull them back.
