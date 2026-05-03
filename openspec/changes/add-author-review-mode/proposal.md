## Why

UatuCode is used in two distinct stances that have opposite UX requirements: **authoring** a Change (often with an AI assistant), where the goal is to get outcome and value while staying aware of what is being created — and **reviewing** a Change, where the goal is to ensure understanding without the UI shifting under the reader. Today the UI implicitly serves only the authoring stance: Follow can auto-switch the active preview from any file-system event, and the cognitive-load score is labeled neutrally. Naming the two stances at the top level lets each one evolve independently — and in particular gives future understanding-oriented features (e.g. inline diffs, marking files reviewed, AI-assisted explanation via opencode/claude/direct API) a stable home that does not interrupt creative flow.

## What Changes

- Add a top-level UI control **Mode** with two options: **Author** (default) and **Review**.
- Persist the selected Mode locally per browser/origin, the same way other UI prefs persist.
- Add a CLI flag to override the persisted Mode at watch-session startup; the UI toggle takes over from there.
- In **Author**:
  - Existing Follow behavior remains available; Follow defaults on for new sessions but is user-toggleable and overridable by a CLI flag.
  - The review-burden score in the `Change Overview` pane is labeled **"Reviewer burden forecast"**.
- In **Review**:
  - Follow is forced off and unavailable.
  - File-system change events MUST NOT switch the active preview.
  - File-system change events to the *currently displayed* file MUST NOT silently re-render the preview either; instead, a stale-content hint appears as a strip in the preview header offering a manual refresh. Multiple changes coalesce into one hint, and manual navigation clears it.
  - When the currently displayed file is *deleted* on disk, the hint enters a distinct "file no longer exists on disk" state offering close/back instead of refresh; the stale content remains visible until the user acts.
  - Manual file selection from the `Files` pane still works.
  - The same score is labeled **"Change review burden"**.
- Switching `Author → Review` turns Follow off. Switching `Review → Author` makes Follow available again but does not auto-enable it.
- The review-burden score value, level (low/medium/high), drivers, thresholds, and the existing detailed score-explanation preview are unchanged. Only the headline label in `Change Overview` differs by Mode.

## Capabilities

### New Capabilities

<!-- None. Mode is added as a modification to existing browser UI behavior. -->

### Modified Capabilities

- `document-watch-browser`: Adds the top-level Mode control, gates Follow availability and file-change-driven preview switching on Mode, makes the `Change Overview` score label Mode-dependent, and adds CLI/persistence behavior for Mode and the Author-mode Follow default. The `change-review-load` capability is intentionally not modified — the score value, drivers, thresholds, and detailed score-explanation preview are all unchanged.

## Impact

- **Affected server code**: CLI argument parsing for the new Mode flag and the existing/new Follow flag interaction; initial state payload to carry the startup Mode value when the flag is set.
- **Affected browser code**: header gains a `Mode` control; sidebar Follow control becomes Mode-aware (disabled in Review); file-change handler must not switch the active preview while Mode is Review; preview header gains a stale-content hint strip (with a deleted-on-disk variant) used only in Review when the active file changes or is deleted; `Change Overview` headline label becomes Mode-aware; localStorage gains a `mode` key.
- **Affected shared types**: state payload gains an optional startup-mode hint; UI preferences gain a Mode field.
- **Affected tests**: unit coverage for the label selector, persistence, and CLI-flag precedence; Playwright coverage for default Mode, persistence across reload, Review blocking auto-switch while preserving manual selection, mode switches mutating the Follow flag, score equality across modes, stale-content hint appearance / refresh / coalescing / clear-on-navigation, and the deleted-on-disk hint variant.
- **No breaking changes** to existing CLI usage. Without the new flag, existing watch sessions behave as before, defaulting to Author mode with Follow on.
