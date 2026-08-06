# sidebar-shell — delta for mobile-experience

"Phone-class viewport" carries the definition from this change's `embedded-terminal`
delta: coarse-pointer AND narrower than the 900-pixel stacked-layout breakpoint.

## ADDED Requirements

### Requirement: File tree keeps a usable height in the stacked layout
In the stacked (≤900px) layout the `Files` pane body SHALL receive an explicit height so the virtualized tree renders a usable number of rows and scrolls internally, instead of collapsing to its (nonexistent) intrinsic content height. Desktop flex allocation of pane heights SHALL be unchanged.

#### Scenario: Stacked layout shows a browsable tree
- **WHEN** the app renders in the stacked layout with documents in the watched tree
- **THEN** the Files pane shows multiple tree rows within a bounded, internally scrolling body
- **AND** other panes and the preview remain reachable by scrolling the page

### Requirement: Phone-class viewports open the Files pane as a full-screen browser
On a phone-class viewport, activating the `Files` pane SHALL promote it to a full-viewport overlay — covering the stacked layout, sized with dynamic-viewport units, padded by safe-area insets, with a close affordance in its header. The overlay SHALL be the same pane instance (same tree DOM and state: expansion, selection, filter chip, follow-mode highlighting), not a second tree. When the user picks a document (a real user click, per the follow-mode Rule A path), the overlay SHALL dismiss and the preview SHALL be brought into view showing the picked document. Expanding or collapsing a directory SHALL NOT dismiss the overlay. Programmatic tree updates (follow-mode Rules C/D, file events) MUST NOT dismiss the overlay. Dismissing the overlay without picking SHALL restore the stacked layout unchanged. While promoted, the pane SHALL NOT participate in stacked pane-height allocation; demotion SHALL restore its stack behavior.

#### Scenario: Browsing and picking a file on a phone
- **WHEN** a user on a phone-class viewport activates the Files pane, expands a directory, and taps a document
- **THEN** the tree renders full-screen during browsing
- **AND** on the document tap the overlay dismisses and the preview shows the picked document

#### Scenario: Directory taps keep the browser open
- **WHEN** the overlay is open and the user taps a directory row
- **THEN** the directory expands or collapses and the overlay stays open

#### Scenario: File events do not steal the browser away
- **WHEN** the overlay is open and a watched-file event triggers a programmatic tree update
- **THEN** the overlay remains open with tree state updated

#### Scenario: Closing without picking changes nothing
- **WHEN** the overlay is open and the user activates its close affordance without selecting a document
- **THEN** the stacked layout returns with selection, scroll, and pane state unchanged

#### Scenario: Desktop is unaffected
- **WHEN** the Files pane renders on a viewport that is not phone-class
- **THEN** the pane behaves as a stacked sidebar pane with flex-allocated height and no overlay affordance

## MODIFIED Requirements

### Requirement: Collapse and expand the sidebar
The browser UI SHALL provide a control that collapses the sidebar into a narrow rail and another (or the same, toggled) control that expands it back to full width. The collapsed/expanded preference SHALL persist across reloads in the same browser for that origin. While collapsed, the preview pane MUST expand to use the freed horizontal space. The collapsed rail SHALL also expose a Follow toggle and a Terminal toggle as icon controls, driving the same state as their expanded-sidebar counterparts, so neither capability requires expanding the sidebar or a keyboard shortcut (which touch devices cannot produce). Each rail toggle MUST reflect its current state (`aria-pressed` mirroring `followEnabled`; the terminal control mirroring panel visibility) and MUST be reachable by pointer and keyboard.

#### Scenario: Collapsing hides the document list
- **WHEN** a user clicks the sidebar collapse control
- **THEN** the sidebar shrinks to a narrow rail showing the expand control, a Follow toggle, and a Terminal toggle
- **AND** the preview pane grows to fill the freed width

#### Scenario: Toggling the terminal from the rail
- **WHEN** the sidebar is collapsed and the user activates the rail's Terminal toggle
- **THEN** the terminal panel shows (or hides) exactly as the expanded sidebar's Terminal control would
- **AND** the sidebar remains collapsed

#### Scenario: Toggling Follow from the rail
- **WHEN** the sidebar is collapsed and the user activates the rail's Follow toggle
- **THEN** `followEnabled` flips exactly as the sidebar-header Follow chip would flip it
- **AND** the rail toggle's pressed state reflects the new value

#### Scenario: Sidebar collapse persists across reloads
- **WHEN** a user collapses the sidebar and then reloads the page in the same browser
- **THEN** the sidebar is still collapsed after the reload

#### Scenario: Expanding restores the document list
- **WHEN** a user clicks the expand control on a collapsed sidebar
- **THEN** the document list returns to its previous width
