## Context

UatuCode currently has one implicit UX posture: the `Change Overview` pane shows a deterministic review-burden score, the `Files` pane lists watched documents, and Follow auto-switches the active preview when files change. That posture works well while the user is **authoring** (often with an AI coding assistant) but fights the user during peer review — the preview can jump away from what the reader is inspecting, and the same score reads differently when it's a *forecast* vs an *actual* burden.

This change introduces a top-level `Mode` control with two values, **Author** and **Review**, that captures the user's current stance and gates UI behavior accordingly. It is deliberately a small first cut: it does not introduce snapshotting, attention tracking, evidence states, or workflow configuration — those land later inside the Review surface once Mode exists as a stable hook.

The naming was settled after exploration: "Live" was rejected because it implied auto-following rather than the broader creative/authoring posture, and because future Review-side AI assistance (UatuCode instrumenting opencode/claude/direct API to *explain* code) makes "Live = AI" a misleading framing. Author/Review names the *role* the user is playing rather than the AI's presence.

## Goals / Non-Goals

**Goals:**
- Make the user's current stance an explicit, persistent UI state.
- Keep Follow useful in Author mode, including a Follow-on default that survives the mode switch back from Review.
- Stabilize preview navigation in Review mode by suppressing file-change-driven preview switches.
- Re-label the headline review-burden score per Mode while keeping the underlying number, level, drivers, and detail preview identical.
- In Review, surface a stale-content hint when the active file changes on disk (and a distinct hint state when the active file is deleted on disk) so the reader can refresh on their own clock.
- Provide a CLI flag to set Mode at startup so users can launch directly into Review (e.g. `uatu watch . --mode=review`).
- Land cleanly without recomputing scores, restructuring panes, or touching the score-explanation preview.

**Non-Goals:**
- No human-attention tasks, "mark file as read", evidence states, or review checklists.
- No workflow configuration in `.uatu.json` for Mode.
- No URL parameter for Mode (deferred; can layer on later).
- No immutable Change snapshot. Underlying state still refreshes; only file-change-driven preview *switching* is suppressed in Review.
- No change to the score calculation, drivers, thresholds, or score-explanation preview content.
- No Review-side AI features in this change — the framing is only justification for keeping Mode top-level so those can land later.
- No remote/shared persistence of Mode — local browser only.

## Decisions

### D1: Two values, not three or a free-form scale

**Decision**: `Mode` is a binary toggle with values `author` and `review`.

**Rationale**: Two stances are what the user described; adding a third (e.g. "compare", "publish") before we have evidence of need would dilute both. A binary toggle also makes the CLI flag, persistence schema, and UI control trivial.

**Alternatives considered**: A scalar "stability" slider; multiple independent toggles for follow/auto-switch/label. Both move complexity into the user's head and don't match the way the user described the problem.

### D2: "Mode" as the umbrella label, not "Focus Mode"

**Decision**: The header control is labeled `Mode` and the values are `Author` and `Review`. The earlier exploration label "Focus Mode" is dropped.

**Rationale**: "Focus" implies focusing *on* something specific; the actual concept here is *posture* — what the user is doing right now. "Mode" is the shortest accurate word and pairs cleanly with the two values.

### D3: Persistence is localStorage; CLI flag overrides at startup

**Decision**: Mode is persisted in `localStorage` per origin under key `uatu:mode` (matching the existing `uatu:sidebar-collapsed`, `uatu:sidebar-panes`, `uatu:sidebar-width`, `uatu:git-log-limit` convention). A new CLI flag `--mode=author|review` takes precedence at session start; once the SPA boots, the user-facing toggle takes over and overwrites the persisted value normally.

**Rationale**: Matches how every other UI preference in this app persists (pane sizes, sidebar width, Git Log history length). The CLI flag gives scriptability ("open this branch in review mode") without requiring shared/remote state.

**Precedence**: CLI flag (when present) > persisted localStorage value > default (`author`).

**Alternatives considered**: Persist via `.uatu.json` (rejected — settings file is for review scoring, not per-user UI prefs); persist server-side in the watch session (rejected — different browsers connecting to the same session may want different stances; unnecessary complexity for v1).

### D4: Author-mode Follow default is "on", and the existing follow flag still works

**Decision**: A fresh Author-mode session has Follow on. The existing `--no-follow` CLI flag continues to work and starts the session with Follow off. A user toggling Follow off in Author mode persists Follow=off; switching to Review forces Follow off; switching back to Author restores Follow to whatever it was before the Review switch is *not* attempted — the simpler rule is: switching Review → Author leaves Follow off and the user re-enables manually.

**Rationale**: Avoids surprise auto-enable. The user explicitly said "switching back to Live should make Follow available again", not "auto-on". Easier reasoning, fewer edge cases.

### D5: Follow disablement in Review is enforced in two places

**Decision**: When Mode is Review:
1. The Follow control in the UI is disabled (rendered, but not interactive) so users can see *why* it's off (tooltip explains the Mode link).
2. The file-system change handler short-circuits: if Mode is Review, ignore the change for the purpose of switching the active preview. The handler still updates the indexed sidebar and still refreshes the *currently* displayed file's content if it is the file that changed.

**Rationale**: Two layers of enforcement so accidental state desync (Mode=Review but Follow=true in storage) cannot cause auto-switching. The visible disabled toggle is also self-explanatory — much better than silently hiding the control.

### D6: The label is the only thing that differs in `Change Overview`

**Decision**: The score's *headline label* in `Change Overview` is "Reviewer burden forecast" (Author) or "Change review burden" (Review). The numeric score, the level pill (low/medium/high), the score drivers shown in the detail preview, the thresholds, the configured area lists, the warnings, and the click-through to the score explanation are identical in both modes. The score-explanation preview itself contains no Mode-dependent content.

**Rationale**: Keeps the scoring spec (`change-review-load`) untouched. The label difference is presentation-only and frames *intent* (forecast vs actual), not value.

**Alternatives considered**: Recomputing the score with different weights in Review (rejected — explicitly out of scope and would invalidate the deterministic-scoring contract). Adding a second number specifically for Review (rejected — same reason; also confuses users about which number to trust).

### D7: Manual selection always works; current-file refresh in Review is gated on a hint-and-click

**Decision**: In Review mode:
- Clicking a file in `Files`, clicking a commit in `Git Log`, opening a direct URL — all continue to work normally.
- If the *currently displayed* file changes on disk, the preview does **not** re-render automatically. Instead, a stale-content hint appears as a strip in the preview header ("This file has changed on disk · Refresh"). Clicking the refresh affordance re-renders the preview to the new content and clears the hint.
- Multiple subsequent changes to the same active file coalesce into a single hint until the user acts on it.
- Manual navigation away from the file (selecting a different file, clicking a commit, navigating via URL) clears the hint as a side effect.
- If the active file is *deleted* on disk while in Review, the hint enters a distinct "file no longer exists on disk" state with a "Close" or "Back" affordance instead of "Refresh"; the stale rendered content remains visible until the user acts.

**Rationale**: Review mode's contract is "the UI must stay where you put it." Silently re-rendering content under the reader violates that — the scroll position is preserved but the *content* shifts, which can change line numbers the reviewer is referencing and silently invalidate conclusions they were forming. The hint preserves the reviewer's agency: they refresh when they're ready, on their own clock. Coalescing avoids hint-spam during a burst of saves. Author mode is unchanged: in flow, the user generally wants to see edits land in the active preview as they happen.

**Out of scope here**: Changing Author-mode in-place refresh behavior. It is separately motivated ("see your edits land") and can be revisited later.

### D8: Scoping — only `document-watch-browser` is modified

**Decision**: This change only writes a delta spec for `document-watch-browser`. The `change-review-load` capability is untouched.

**Rationale**: All affected requirements live in `document-watch-browser`: the Mode control, the Follow behavior, the score label in the `Change Overview` pane, and the startup configuration flags. The score *computation* spec stays exactly as-is.

## Risks / Trade-offs

- **Risk**: Reviewers in Review mode wonder "why isn't the preview updating?" and don't connect it to Mode. → **Mitigation**: render the Follow control as visibly disabled with a tooltip naming Mode as the cause, instead of hiding it.
- **Risk**: Two labels for one number could confuse users about whether the number means different things. → **Mitigation**: the score-explanation preview (unchanged, identical text) is the canonical definition; headline labels frame intent only. Revisit if user feedback shows confusion.
- **Risk**: "Stable review navigation" ≠ snapshot — the score itself can still update if the worktree changes. → **Mitigation**: explicit non-goal in proposal and design; document this expectation in the README change that lands with this work; future work can introduce a true snapshot.
- **Risk**: Author-mode Follow-off persisted state collides with Review-forced-off — i.e. user explicitly turned Follow off in Author, then went to Review and back; would they expect Follow to come back on? → **Mitigation** (D4): `Review → Author` always leaves Follow as it was *before entering Review*. Simpler and matches what the user agreed to.
- **Risk**: CLI flag and `--no-follow` interaction — what does `--mode=review --follow` mean? → **Mitigation**: Review forces Follow off regardless; document this and emit a startup warning if both flags are present in a contradictory way.
- **Risk**: Scope creep pressure — reviewers will ask for "mark file read" / "frozen base SHA" / workflow configuration the moment Mode lands. → **Mitigation**: explicit non-goals; the requirements are written so those features can layer on later without renaming Mode itself.
- **Trade-off**: Local-only persistence means switching browsers resets to Author. Acceptable — matches every other UI pref in the app.

## Open Questions

- **Q1**: Final wording for the score labels — keep "Reviewer burden forecast" / "Change review burden", or lean into the cognitive-debt vocabulary ("Cognitive debt forecast" / "Cognitive debt to review")? Recommend keeping the proposal labels for v1; revisit after seeing them in context.
- **Q2**: Should the disabled Follow toggle in Review mode show the tooltip on hover only, or also have a visible inline note ("off in Review mode")? Recommend inline note + tooltip — cheap and removes one round-trip of confusion.
- **Q3**: Should the startup CLI flag support a short alias (`-m review`)? Defer until real usage shows it's needed.
