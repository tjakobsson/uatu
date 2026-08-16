## MODIFIED Requirements

### Requirement: The SPA lays out its chrome below the inset
When the inset marker is present, the SPA SHALL offset its top-level chrome —
the sidebar header, the preview pane's sticky header zone, and the chat
panel's header row and collapsed strip — down by the announced inset so no
interactive control sits under the native chrome, while scrolled document
content still flows beneath the floating toolbar. When the marker is absent
(plain browser or PWA), layout MUST be unchanged.

#### Scenario: Chrome clears the floating toolbar
- **WHEN** the SPA renders in the desktop wrapper with a non-zero inset
- **THEN** the sidebar header and preview header render fully below the
  native toolbar
- **AND** scrolling the document moves content beneath the toolbar, where the
  native glass samples it

#### Scenario: Chat panel chrome clears the floating toolbar
- **WHEN** the SPA renders in the desktop wrapper with a non-zero inset and
  the chat panel is open or collapsed
- **THEN** the panel's conversation controls and the collapsed strip's reopen
  affordance render fully below the native toolbar

#### Scenario: No inset outside the desktop
- **WHEN** the SPA loads in a plain browser or as a PWA
- **THEN** no top padding is added and layout matches pre-change behavior

### Requirement: The page frosts the covered strip
When the inset marker is present, the SPA SHALL render a non-interactive
progressive frost over the covered strip — blur-forward with a light tint,
dissolving over an eased ramp below the inset — so content beneath the
native chrome reads as blurred glass rather than raw content (the web view
cannot render the system scroll-edge effect for chrome it does not know
about). The frost SHALL only cover regions where scrolled content can flow
under the chrome. Solid, non-scrolling app surfaces — the sidebar column
and the right-docked terminal panel column — SHALL be excluded, and over a
fullscreen terminal the frost SHALL be confined to the covered strip with
no falloff onto the panel: these are inset-cleared surfaces that never
scroll under the chrome, and frosting them only washes the brand mark or
smears an opaque surface into a gradient band. The app's own top chrome —
the preview header and the chat panel's header and collapsed strip — SHALL
render above the frost so its controls stay crisp while content beneath
them still frosts.

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

#### Scenario: A fullscreen terminal is not smeared
- **WHEN** the terminal panel enters fullscreen in the desktop wrapper
- **THEN** no frost or falloff renders over the panel's surface
- **AND** the covered strip above the panel still frosts the page content
  peeking through it

#### Scenario: App headers stay crisp under the falloff
- **WHEN** the frost strip is active with the preview and chat surfaces
  visible
- **THEN** the preview header and the chat panel's conversation controls
  render sharp, unblurred by the falloff, while document content scrolling
  above the preview header still reads as frosted glass
