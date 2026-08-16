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
