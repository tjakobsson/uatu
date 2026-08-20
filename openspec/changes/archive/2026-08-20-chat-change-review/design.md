## Context

See `proposal.md` — Why. Two facts shape the approach.

- `renderPermission` in `timeline-renderer.ts` already carries
  `data-request-state="resolved"` on the element; only `opacity` uses it today.
  The receding form is a styling and summary change, not a new render path.
- The chat timeline already renders diffs (`.chat-diff`, add/del lines) for
  completed edit and patch tool details. The card diff reuses that
  presentation; the open question is the data source, not the rendering.

## Goals / Non-Goals

**Goals:**
- The pending change is visible where it is approved, reusing the existing diff
  presentation.
- A resolved request recedes but stays auditable.
- One render path for pending and resolved, keyed on the state already present.

**Non-Goals:**
- Rendering the diff anywhere but the card.
- Diffs for non-edit permissions.

## Decisions

**Recede by collapsing the existing `<details>`, not by a second element.** The
permission is already a `<details>` carrying its state. Rendering the outcome
into the `<summary>` and leaving the resources in the closed body gives
"outcome legible, resources reachable" for free and keeps one code path.
Alternative considered: a separate one-line element for resolved requests — a
second path that loses the resource list.

**Locate the pending diff from what OpenCode attaches to the permission.** A
file-edit permission carries — in its metadata or the tool call it gates — the
patch OpenCode is asking to apply. The task layer resolves exactly where
(permission `metadata`, or the pending tool's `SnapshotFileDiff`); the design
commits to the card rendering whatever diff the permission carries and showing
none when it carries none. Alternative considered: fetching the workspace diff
on demand — a round trip for something the permission event can carry.

**The diff stays in the card.** A two-pane app could push it to Preview, but
the decision is made in the card, and the card is where the evidence belongs.
Pushing it to Preview splits attention across panes at the one moment attention
must not split.

## Risks / Trade-offs

- **The patch may be large.** → Reuse the timeline's diff presentation, which
  already scrolls; the card diff is bounded the same way, and a show-more may
  follow from the `chat-activity-output` sibling.
- **The permission may not carry a diff in every OpenCode version.** → Show the
  diff when present, the plain card when absent; never block approval on having
  a diff to show.
- **This change and `chat-ui-density` both wanted `renderPermission`.** → The
  resolved compaction was moved here from density precisely so one change owns
  the function and the requirement; density is CSS-only and stays clear.
