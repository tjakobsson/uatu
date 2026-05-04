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

### D9: Visual differentiation is structural/typographic, not chromatic

**Decision**: To make Mode unmistakably visible without depending on color (theming work will own colors later), the two Modes differ along five non-chromatic axes, all reinforcing the same posture:

1. **Sidebar brand subtitle** — `Codebase Watcher` is replaced by a Mode-aware subtitle: `Authoring session` (Author) or `Review session` (Review). Always visible at the top-left.
2. **Persistent Mode pill** — A small uppercase pill (`AUTHORING` / `REVIEWING`) sits directly under the brand subtitle. Structural border + neutral background; no accent color.
3. **Mode-glyph icons in toolbar segments** — The Author segment carries a pencil glyph; the Review segment carries an eye glyph. Reinforces active mode peripherally even when only the toolbar is in view.
4. **Connection indicator wording and dot animation** — In Author with the channel live, the indicator reads `Online` with a pulsing dot (current behavior). In Review with the channel live, it reads `Reading — auto-refresh paused` with a *steady* dot. The "reading" treatment communicates: connection is live, UI is intentionally still. Reconnecting / connecting states keep their existing wording in both Modes.
5. **Preview "framed read" treatment** — Review wraps the preview area in a subtle inset border/shadow (a "card" feel for content being studied). Author has no frame; the preview merges with the chrome.

**Rationale**: Five small structural cues are far stronger together than any one of them alone. Each can stand on its own without color and each survives a theme swap. The combination ensures that no matter where the user's eye is — sidebar header, toolbar, preview area, or connection indicator — the active Mode is glanceable.

**Alternatives considered**:
- *Mode-aware accent color* — strongest visual punch, but explicitly out of scope because the upcoming theming work will own the color palette and this would either fight that work or be undone by it.
- *Top-of-screen mode banner* — heavier and more intrusive than what's needed; rejected as too "alert"-flavored for a posture toggle.
- *Mode-aware default pane sizing* — addressed by D12 (per-mode pane catalog with independent persistence); see below.

### D10: Mode toggle lives in the sidebar, not the preview toolbar

**Decision**: The Mode toggle is rendered in a dedicated row at the top of the sidebar, directly under the brand block. It is removed from the preview toolbar.

**Rationale**: Mode is a session-level posture; Follow (and previously Pin) are document-level mechanics. Mixing them in one toolbar implied parity that doesn't exist. Putting Mode in the sidebar header anchors it next to the other Mode-aware affordances that already live there (subtitle, pill, segments) and removes the implicit "they're all the same kind of thing" framing of the preview toolbar.

### D11: Remove the Pin UI affordance

**Decision**: The in-UI Pin/Unpin chip and its handlers are removed entirely. The server-side `Scope` mechanism stays intact so `uatu watch FILE.md` continues to support single-file watching from the CLI.

**Rationale**: Pin was a workaround for "I want to focus on this one file while a folder watch is running" — but that's exactly what Mode + the upcoming workflow features will own properly. The chip's coexistence with the new Mode toggle would have read as duplicate posture controls. Single-file CLI watch covers the remaining "narrow scope to one file" use case for now.

**Migration**: User scripts that depended on the in-UI pin have no replacement in this change; they should switch to single-file CLI watch (`uatu watch path/to/file.md`) for the same effective scope.

### D12: Per-mode pane catalog with independent persistence

**Decision**: Pane composition is Mode-aware. The pane catalog and per-pane state (visibility, collapse, height) are stored separately for each Mode under `uatu:sidebar-panes:author` and `uatu:sidebar-panes:review`. Switching Mode reads the persisted state for the destination Mode and re-renders the sidebar.

**Catalog**:
- **Author** — `Change Overview`, `Files`. Git Log is intentionally absent: Author is "what I'm making now"; historical commit context belongs in Review.
- **Review** — `Change Overview`, `Files`, `Git Log`.

The panels-restore menu only lists panes that belong to the current Mode's catalog, so a hidden pane in Author cannot be "restored" into a Review-only pane and vice versa.

**Rationale**: Different postures want different surfaces. Per-mode persistence means each Mode "remembers its layout" — a user who collapses `Files` in Review keeps their compact Review layout while still getting a comfortable Files pane in Author. The earlier deferred concern in D9 ("changing layout under the user is disorienting") is addressed here by being explicit about it: when you flip Mode, layout changing is exactly the point — it's part of changing posture.

### D13: Files pane offers an All/Changed toggle when git is available

**Decision**: When the watched root is git-backed and the review-load result is `available`, the `Files` pane exposes a small two-segment toggle (`All` / `Changed`) in the pane header. The default view is **All** (the existing full-tree listing). When the user switches to **Changed**, the pane lists `reviewLoad.changedFiles` with a status glyph (`M`/`A`/`D`/`R`), filename, and `+adds -dels` summary; renames render `oldPath → path`. When git is unavailable or the review-load result is non-git/unavailable, the toggle is hidden and the pane renders the existing full tree.

The view choice persists separately per Mode under `uatu:files-view:{mode}` so each Mode remembers what the user prefers there.

**Rationale**: The original design (Changed-only when git is available) cleanly captured "the working list is what changed", but it broke a load-bearing capability: cross-document navigation through the sidebar to *any* file in the project, not just changed ones. Tests exposed this immediately — every test that clicked a fixture file (e.g. `README.md`) failed because the fixture lives inside the uatu git repo, the changed-files filter activated, and unchanged fixture files were no longer listed.

The toggle keeps the new view available without removing the existing one. Defaulting to **All** preserves all existing behavior; **Changed** is an opt-in lens that becomes useful precisely when the user wants to focus on a Change.

**Edge cases**:
- *Toggle hidden when git unavailable* — there's nothing to toggle to.
- *Deleted files* in Changed view render with the `D` glyph and a non-clickable treatment.
- *Renamed files* in Changed view show both old and new paths.
- *Empty changed set* — Changed view renders an empty state ("No changes against the base"); user can flip to All if they want.
- *Cross-document navigation to an unchanged file* still works in either view via URLs and in-document links. In Changed view the destination just isn't listed in the sidebar.

**Alternatives considered**:
- *Default = Changed when git available* — original design; breaks tests and the "browse the whole repo" flow.
- *Two separate panes (`Changed` and `All Files`)* — duplicates the listing and consumes more vertical space.
- *Auto-switch to Changed when changedFiles is non-empty* — magic that surprises users; toggle gives them control.

### D14: Folder icons in the fallback file tree

**Decision**: Directory rows in the non-git fallback tree carry a folder glyph next to the directory name, matching the existing file glyphs.

**Rationale**: The non-git fallback is the only path that still renders a hierarchical tree. With files already iconified and folders not, the tree felt visually thin. A folder glyph brings parity and makes the tree feel intentional rather than like an unstyled `<details>`.

### D15: Slightly wider default sidebar

**Decision**: Bump `--sidebar-width` from 300px to 360px. Existing users who customized their sidebar width keep their persisted value via localStorage.

**Rationale**: The new sidebar header carries more content than before — brand row + subtitle + Mode pill + Mode toggle row. 300px was tight even before; with the additions it crowds. 360px gives the new affordances room to breathe without making the preview noticeably narrower.

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
