## Purpose

Define the shared Wrap toggle in the preview toolbar: a single global, persisted, default-off preference that applies soft (visual-only) word-wrap to whichever preview view supports wrapping (Source and Diff), hidden where wrapping is not meaningful (Rendered view).

## Requirements

### Requirement: Preview exposes a shared Wrap toggle in the preview toolbar

The preview SHALL render a single **Wrap** toggle in the preview toolbar
(alongside the Rendered / Source / Diff view chooser). The toggle SHALL be
a single pressed-state control (a button exposing its on/off state to
assistive technology, e.g. via `aria-pressed`), using the toolbar's
existing control vocabulary rather than a bare checkbox. When on, soft
word-wrap is applied to the active view; when off, long lines scroll
horizontally as they do today. Wrap MUST be soft (visual) only — it MUST
NOT insert real newlines into the underlying content, and MUST NOT change
copy-to-clipboard output.

#### Scenario: Wrap toggle is present for a wrappable view
- **WHEN** the user is in Source view or Diff view for a document
- **THEN** a Wrap toggle is visible in the preview toolbar
- **AND** the toggle exposes its current on/off state to assistive technology

#### Scenario: Turning Wrap on soft-wraps the active view
- **WHEN** the user activates the Wrap toggle while long lines are present
- **THEN** long lines wrap within the available width
- **AND** the horizontal scrollbar for those lines is no longer required

#### Scenario: Turning Wrap off restores horizontal scrolling
- **WHEN** the user deactivates the Wrap toggle
- **THEN** long lines no longer wrap and scroll horizontally as before

#### Scenario: Wrap does not alter copied text
- **WHEN** Wrap is on and the user copies wrapped content
- **THEN** the copied text matches the unwrapped content (no inserted line breaks at wrap points)

### Requirement: Wrap is a single global preference, persisted and default off

The Wrap setting SHALL be a single global preference applied to whichever
view supports wrapping (Source and Diff). It SHALL persist to
`localStorage` under a key distinct from the view-mode, layout, and
diff-style keys, default to **off** on first visit, and re-apply on reload.
Toggling Wrap MUST update the active view in place using already-loaded
content — no network round-trip and no full document reload.

#### Scenario: First visit defaults to off
- **WHEN** the user opens the preview for the first time on a fresh `localStorage`
- **THEN** Wrap is off and long lines scroll horizontally

#### Scenario: Preference persists across reload
- **WHEN** the user turns Wrap on
- **AND** reloads the page
- **THEN** Wrap is on for wrappable views without further interaction

#### Scenario: Toggling Wrap re-applies in place
- **WHEN** the user toggles Wrap while a document is displayed
- **THEN** the active view updates in place
- **AND** no new document fetch is made and no empty-preview flash occurs

#### Scenario: Single preference spans Source and Diff
- **WHEN** the user turns Wrap on in Source view
- **AND** switches to Diff view for the same or another document
- **THEN** Diff view is also wrapped without a second toggle

### Requirement: Wrap toggle is hidden where wrapping is not meaningful

The Wrap toggle SHALL NOT appear in Rendered (Markdown / AsciiDoc body)
view. Its visibility SHALL follow the active view using the same mechanism
that hides unsupported view-mode segments.

#### Scenario: Hidden in Rendered view
- **WHEN** the active view-mode is Rendered
- **THEN** no Wrap toggle is shown in the preview toolbar

#### Scenario: Shown again when returning to a wrappable view
- **WHEN** the user switches from Rendered to Source or Diff
- **THEN** the Wrap toggle reappears reflecting the current global preference
