## ADDED Requirements

### Requirement: Sidebar brand logo SHALL be rendered as inline SVG

The brand logo in the sidebar header SHALL be rendered as inline SVG in the document, so that page-level CSS can target elements within it. The logo asset (`src/assets/uatu-logo.svg`) SHALL also expose the eye paths grouped under a stable identifier so the inline copy and the asset stay structurally aligned.

#### Scenario: Logo is part of the page DOM
- **WHEN** the application loads `index.html`
- **THEN** the sidebar header contains an `<svg>` element with class `brand-logo` (not an `<img>` referencing an external SVG)
- **AND** the inline SVG contains a group with `id="eye"` wrapping both eye paths
- **AND** the standalone asset at `src/assets/uatu-logo.svg` also contains a group with `id="eye"` wrapping both eye paths

#### Scenario: Logo remains decorative for assistive tech
- **WHEN** the inline brand logo is rendered
- **THEN** it is marked as decorative (e.g., `aria-hidden="true"` or equivalent) so screen readers do not announce it
- **AND** no focusable or interactive affordance is added to it

### Requirement: Hovering the brand logo SHALL trigger a blinking eye easter egg

While the cursor is over the brand logo, the eye group SHALL play a blink animation that repeats once every 10 seconds. While the cursor is not over the logo, the eye SHALL appear fully open and SHALL NOT animate.

#### Scenario: Hover starts the blink
- **WHEN** the user moves the cursor onto the brand logo
- **THEN** the `#eye` group runs an animation whose total cycle length is 10 seconds
- **AND** within each cycle the eye briefly closes (vertical squash) and re-opens, producing a single blink

#### Scenario: Cursor leaves the logo
- **WHEN** the cursor leaves the brand logo
- **THEN** the eye returns to (or remains in) the fully-open state
- **AND** no further blink frames are rendered until the cursor returns

#### Scenario: Sustained hover keeps blinking
- **WHEN** the user keeps the cursor over the brand logo for longer than one animation cycle
- **THEN** the blink repeats indefinitely at the 10-second cadence for as long as the hover continues

### Requirement: Easter egg SHALL respect reduced-motion preferences

When the user's environment reports `prefers-reduced-motion: reduce`, the brand logo SHALL NOT animate even on hover.

#### Scenario: User prefers reduced motion
- **WHEN** the operating system / browser reports `prefers-reduced-motion: reduce`
- **AND** the user hovers the brand logo
- **THEN** the eye remains in its open, static state
- **AND** no blink frames are rendered
