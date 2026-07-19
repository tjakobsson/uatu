# system-theme Delta Specification

## ADDED Requirements

### Requirement: The app follows the system color scheme
The application SHALL render in a light or dark theme matching the operating
system's color-scheme preference, as reported by `prefers-color-scheme`. The
document root SHALL declare `color-scheme: light dark` so form controls,
scrollbars, and other UA-rendered surfaces match the active scheme. There
SHALL be no light-only pin (`color-scheme: light`) on the root.

#### Scenario: Dark system preference renders the dark theme
- **WHEN** the operating system color scheme is dark
- **AND** the app is loaded in a browser, as a PWA, or in the desktop wrapper
- **THEN** the app renders with the dark palette
- **AND** UA-rendered surfaces (scrollbars, form controls) render dark

#### Scenario: Light system preference renders the light theme
- **WHEN** the operating system color scheme is light
- **THEN** the app renders with the existing light palette, visually unchanged
  from before this capability existed

### Requirement: Scheme changes apply live
The app SHALL adopt a changed operating-system color-scheme preference
without a page reload while the app is open. Surfaces whose
theming is not pure CSS — Mermaid diagrams and the sidebar tree — SHALL update
to match the new scheme in the same session.

#### Scenario: Toggling the OS appearance mid-session
- **WHEN** the app is open and the user switches the OS from light to dark
- **THEN** the page restyles to the dark palette without a reload
- **AND** visible Mermaid diagrams re-render with dark theme inputs
- **AND** the sidebar tree adopts the dark scheme

### Requirement: Themed surfaces read from the token palette
Themed colors SHALL be expressed as CSS custom properties in the root token
block, with light and dark values resolved by the active scheme. Feature
styles SHALL reference tokens rather than scheme-specific color literals, so
a surface cannot be light in one scheme's layout and unreadable in the other.
Vendored theme stylesheets (rendered-Markdown styling, syntax-highlight token
colors) SHALL participate by pairing the light stylesheet with its dark
sibling, selected by the active scheme.

#### Scenario: Rendered document styling matches the scheme
- **WHEN** a Markdown or AsciiDoc document is previewed under the dark scheme
- **THEN** the rendered body uses the dark Markdown stylesheet
- **AND** fenced code blocks use the dark syntax-highlight palette

#### Scenario: Frosted-glass chrome adapts to the scheme
- **WHEN** the preview header's translucent blur surface renders under the
  dark scheme
- **THEN** its background tint is a dark token value, not hardcoded white

### Requirement: The embedded terminal remains an always-dark surface
The embedded terminal panel SHALL keep its dark palette in both schemes. Its
palette tokens SHALL NOT flip with the active scheme.

#### Scenario: Terminal under the light scheme
- **WHEN** the app renders in the light scheme
- **THEN** the terminal panel renders with its existing dark palette

### Requirement: The page advertises its scheme via theme-color
The app SHALL maintain a `theme-color` meta value matching the active
scheme's chrome background, updating it on scheme change, so browser, PWA,
and desktop host chrome can match the page.

#### Scenario: theme-color follows a scheme change
- **WHEN** the active scheme changes from light to dark
- **THEN** the document's effective `theme-color` changes to the dark chrome
  background value
