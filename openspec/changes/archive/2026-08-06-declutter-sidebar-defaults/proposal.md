# Declutter Sidebar Defaults

## Why

The default sidebar opens with four panes stacked (Change Overview, Files, Git Log,
Selection Inspector), which crowds the working panes — especially now that phones are
becoming a first-class surface (see the `mobile-experience` change). Git Log is a
sometimes-tool, not a first-screen need, and the Selection Inspector has not earned
its default slot: its capture-a-line-reference workflow sees little use and its
Review-mode gating has already drifted from how the app works today.

## What Changes

- Fresh clients default to Change Overview and Files visible; Git Log starts hidden
  (still one toggle away in the panes menu). Devices with stored pane state are
  untouched — pane visibility is per-device localStorage, not synced workspace state.
- **BREAKING** (UI capability removal): the Selection Inspector pane is removed
  entirely — pane, sidebar registration, default state entry, `selection-inspector.ts`
  and its mount and tests, and the `selection-inspector` spec is retired.
- The whole-file source block keeps its distinguishing `uatu-source-pre` class (the
  word-wrap control depends on it); the `document-source-view` spec stops naming the
  retired pane as that class's consumer.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sidebar-shell`: new requirement pinning fresh-client default pane visibility
  (Change Overview + Files on; Git Log and Search off).
- `selection-inspector`: retired — all requirements removed.
- `document-source-view`: the source-view requirement's rationale for the
  distinguishing class no longer references the Selection Inspector; the class
  requirement itself is unchanged.

## Impact

- `src/shell/state.ts` — pane defaults (`git-log` visible:false; drop the
  `selection-inspector` entry and its pane def).
- `src/sidebar/selection-inspector.ts`, `selection-inspector-mount.ts`,
  `selection-inspector.test.ts` — deleted; `src/app.ts` init call and
  `src/index.html` pane markup removed; `src/sidebar/panes.ts` catalog updated.
- Stored pane-state parsing must tolerate an existing `selection-inspector` entry in
  `uatu:sidebar-panes` (ignore it, don't fail).
- E2E: sidebar suites updated for the new defaults and the absent pane.
- No server, hub, or protocol changes.
