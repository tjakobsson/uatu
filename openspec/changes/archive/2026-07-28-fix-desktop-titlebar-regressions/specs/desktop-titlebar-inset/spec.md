# desktop-titlebar-inset delta

## MODIFIED Requirements

### Requirement: The page frosts the covered strip
When the inset marker is present, the SPA SHALL render a non-interactive
progressive frost over the covered strip — blur-forward with a light tint,
dissolving over an eased ramp below the inset — so content beneath the
native chrome reads as blurred glass rather than raw content (the web view
cannot render the system scroll-edge effect for chrome it does not know
about). The frost SHALL only cover regions where scrolled content can flow
under the chrome. Solid, non-scrolling app surfaces — the sidebar column
and the right-docked terminal panel column — SHALL be excluded: they are
inset-padded surfaces that never scroll under the chrome, and frosting
them only washes the brand mark or smears the panel's opaque background
into a gradient band across the toolbar.

#### Scenario: Scrolled content under the titlebar reads as glass
- **WHEN** dark or saturated document content scrolls into the covered strip
- **THEN** it appears as recognizable blurred content, not a flat wash,
  fading smoothly into sharp content below the inset

#### Scenario: The sidebar stays crisp
- **WHEN** the frost strip is active
- **THEN** the sidebar column, including the brand logo, renders without any
  frost overlay

#### Scenario: The right-docked terminal column is not smeared
- **WHEN** the terminal panel is docked right in the desktop wrapper
- **THEN** the covered strip above the terminal column shows no blurred or
  gradient-smeared rendering of the panel's dark surface, and the boundary
  between the preview and terminal columns stays sharp under the toolbar

## ADDED Requirements

### Requirement: The right-docked terminal panel honors the inset
The right-docked terminal panel SHALL, when the inset marker is present,
lay out its own chrome (the panel header and its controls) fully below
the announced inset so nothing interactive sits under the native chrome,
and it SHALL NOT paint its opaque surface into the covered strip. When
the marker is absent (plain browser or PWA), the panel's layout MUST be
unchanged.

#### Scenario: Terminal header clears the native chrome
- **WHEN** the terminal panel is docked right in the desktop wrapper with a
  non-zero inset
- **THEN** the panel header and its controls render fully below the native
  toolbar and remain clickable

#### Scenario: The strip above the terminal reads as window chrome
- **WHEN** the terminal panel is docked right under the transparent titlebar
- **THEN** the strip above the panel renders as clean window chrome —
  consistent with the strip above the sidebar — not as the panel's
  scrollback bleeding under the toolbar

#### Scenario: Dock-bottom and non-desktop layouts unchanged
- **WHEN** the terminal is docked at the bottom, or the SPA runs in a plain
  browser or PWA
- **THEN** the terminal panel's layout and background are unchanged from
  pre-change behavior
