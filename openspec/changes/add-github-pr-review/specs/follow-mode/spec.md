## MODIFIED Requirements

### Requirement: Follow toggle exposes a single session-level boolean

The browser UI SHALL expose a Follow toggle that controls one piece of session state — a boolean `followEnabled`. Its presentations SHALL be the Follow chip and the collapsed sidebar rail's icon control, with exactly one visible according to sidebar state. Desktop mode shows the chip in its own sidebar row; touch mode keeps it in a sidebar menu whose header button marks Follow on.

#### Scenario: Both Follow presentations expose the same accessible state
- **WHEN** the sidebar shows the Follow chip or its collapsed-rail counterpart
- **THEN** the visible control MUST reflect `followEnabled` exactly via `aria-pressed`: `"true"` when on and `"false"` when off
- **AND** beyond these two presentations and touch mode's menu-button indicator there SHALL be no other UI-visible representation of Follow's state
- **AND** both presentations MUST be reachable by mouse, touch, and keyboard following existing chip-control conventions

#### Scenario: Chip aria-pressed mirrors the session state
- **WHEN** the SPA boots and `followEnabled` is `true`
- **THEN** the Follow chip's `aria-pressed` attribute reads `"true"`
- **AND** clicking the chip flips `followEnabled` to `false`
- **AND** the chip's `aria-pressed` attribute reads `"false"` after the click is processed

#### Scenario: Chip is keyboard-operable
- **WHEN** the Follow chip has keyboard focus
- **AND** the user presses Space or Enter
- **THEN** `followEnabled` toggles
- **AND** the chip's `aria-pressed` attribute updates to match

#### Scenario: Rail presentation stays in sync with the chip
- **WHEN** `followEnabled` is toggled via the rail control, and the user then expands the sidebar
- **THEN** the Follow chip's `aria-pressed` reflects the value set from the rail
- **AND** collapsing again shows the rail control with the same pressed state

#### Scenario: Touch mode keeps Follow in the sidebar menu
- **WHEN** the Files tab is shown in touch mode
- **THEN** no full-width Follow row takes space under the sidebar header; the header's menu button (`aria-expanded`, named `Sidebar menu, Follow on` or `… off`) shows a dot while Follow is on
- **AND** opening the menu shows the Follow chip, and switching it keeps the menu open with the chip and the button's dot updated
- **AND** a tap outside the menu or Escape closes it, Escape returning focus to the button

#### Scenario: Desktop keeps its Follow row
- **WHEN** the sidebar is expanded in desktop mode
- **THEN** the Follow chip is in its own row under the sidebar header, and the menu button is not shown
