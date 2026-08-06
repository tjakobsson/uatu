# sidebar-shell — delta for touch-tab-navigation

The phone file-browser overlay is superseded by the Files tab (see the new
`touch-navigation` capability), which carries the same tree-continuity and
Rule-A-only dismissal guarantees. The stacked-layout tree-height fix narrows to
desktop mode, the only place the stacked layout still renders.

## REMOVED Requirements

### Requirement: Phone-class viewports open the Files pane as a full-screen browser
**Reason**: Superseded by the `touch-navigation` capability's Files tab — the same pane stack rendered full-screen as a tab surface, with tree-state continuity and Rule-A pick-to-Preview switching carried over as requirements there.
**Migration**: The `data-overlay` promotion, Browse/close affordances, and dismiss-on-pick wiring are removed; `touch-navigation` owns the equivalent behavior.

## MODIFIED Requirements

### Requirement: File tree keeps a usable height in the stacked layout
In desktop mode's stacked (≤900px) layout the `Files` pane body SHALL receive an explicit height so the virtualized tree renders a usable number of rows and scrolls internally, instead of collapsing to its (nonexistent) intrinsic content height. Wide-viewport desktop flex allocation of pane heights SHALL be unchanged. (In touch mode the tree renders inside the full-screen Files tab and needs no stacked-layout special case.)

#### Scenario: Stacked layout shows a browsable tree
- **WHEN** the app renders the desktop layout at a stacked width with documents in the watched tree
- **THEN** the Files pane shows multiple tree rows within a bounded, internally scrolling body
- **AND** other panes and the preview remain reachable by scrolling the page
