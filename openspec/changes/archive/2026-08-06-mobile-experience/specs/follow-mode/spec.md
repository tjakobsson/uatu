# follow-mode — delta for mobile-experience

The Follow chip gains a collapsed-rail counterpart (see the `sidebar-shell` delta).
The single-boolean contract is preserved: the two controls are alternative
presentations of the same toggle, never visible at the same time.

## MODIFIED Requirements

### Requirement: Follow toggle exposes a single session-level boolean

The browser UI SHALL expose a Follow toggle that controls one piece of session state — a boolean `followEnabled`. The toggle has two mutually exclusive presentations: the "Follow chip" in the expanded sidebar header, and an icon control in the collapsed sidebar rail. Exactly one presentation is visible at a time (matching the sidebar's collapsed state), and whichever is visible MUST reflect `followEnabled` exactly via its `aria-pressed` attribute: `"true"` when Follow is on, `"false"` when off. Beyond these two presentations there SHALL be no other UI-visible representation of Follow's state. The toggle MUST be reachable by mouse, touch, and keyboard following the existing chip-control conventions in both presentations.

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
