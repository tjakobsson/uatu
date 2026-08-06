# Design — declutter-sidebar-defaults

## Context

Pane visibility defaults live in `src/shell/state.ts` (`readPaneState` defaults:
change-overview, files, git-log, selection-inspector visible; search hidden) and
persist per device under `uatu:sidebar-panes` in localStorage — deliberately *not*
part of the cross-client personal-workspace-state sync. The Selection Inspector is a
self-contained pane (`selection-inspector.ts` + mount + tests) whose only outward
coupling is reading the whole-file source block's `uatu-source-pre` marker class —
a class also consumed by the word-wrap control, so it outlives the pane.

## Goals / Non-Goals

**Goals:**
- Fresh clients open with a lean sidebar: Change Overview + Files.
- The Selection Inspector capability is fully retired: code, markup, state, spec.

**Non-Goals:**
- No migration of existing devices' stored pane arrangements — stored state wins.
- No removal of the `uatu-source-pre` marker class or the requirement behind it.
- No changes to the Git Log pane itself, only its default visibility.

## Decisions

### D1: Change defaults only; never rewrite stored state

`readPaneState` merges stored JSON over defaults. Flipping `git-log` to
`visible: false` in the defaults affects only clients with no stored entry. No
migration code, no versioning of the storage key. Alternative — force-hide git-log
once via a migration flag — rejected: overriding a user's explicit arrangement to
enforce a taste change is hostile, and the memory of this decision matters for
future default flips.

### D2: Removal must tolerate stale stored entries

Existing devices have a `selection-inspector` entry in `uatu:sidebar-panes`. The
pane-state reader keeps ignoring unknown pane ids (verify this is already the
behavior; add a test either way) so the entry is inert garbage, not a crash. It is
not actively scrubbed — the key is small and self-healing on next write.

### D3: Retire the spec via REMOVED deltas, keep the marker-class contract

All eleven `selection-inspector` requirements are removed with a shared reason
(capability retired) and migration note (copy line references manually; the marker
class remains for other consumers). `document-source-view`'s source-view requirement
is modified only to stop naming the retired pane as the class's consumer — the
normative content (class exists, applied in both single and split layouts) is
untouched, because `code-block.ts` word-wrap targeting depends on it.

## Risks / Trade-offs

- [Someone relies on the Selection Inspector's `@path#L…` capture workflow] → It
  remains achievable manually (line numbers are visible in Source view); if demand
  reappears, the retired spec text in the archive is the revival blueprint.
- [Hidden-by-default Git Log makes the panes menu the only discovery path] → The
  panes menu is an established affordance (search pane already lives this way);
  acceptable trade for a lean first screen.
- [A missed reference to the removed pane breaks boot (app.ts queries pane DOM)] →
  Removal task explicitly sweeps `app.ts`, `index.html`, `panes.ts`, `state.ts`;
  the unit + e2e suites gate the sweep.
