## ADDED Requirements

### Requirement: Surface document metadata above the body
The preview pane SHALL render extracted document-level metadata as a single, format-agnostic metadata card placed above the body of the rendered document. The card SHALL surface a curated set of fields — title, author(s), date, revision/version, description, tags/keywords, status — when those fields are present in the source. Format-specific keys MUST be normalized so that the card looks consistent regardless of whether the source was Markdown YAML/TOML frontmatter or AsciiDoc header attributes (for example, AsciiDoc `:keywords:` MUST surface in the same `tags` row that Markdown `tags` populates; AsciiDoc `:revnumber:` MUST surface in the same `revision` row that Markdown `version` populates). Fields that are not part of the curated set MUST still render — visually subdued — as a generic key/value list so that the curated fields stand out. Every metadata value reaching the DOM MUST be HTML-escaped or passed through the same GitHub-modeled sanitize allowlist used for body HTML, so a metadata value containing `<script>`, `<iframe>`, an inline event handler, or a `javascript:` URL MUST NOT execute. The card MUST be omitted entirely when no metadata is present so documents without frontmatter or AsciiDoc header metadata render unchanged. The card MUST be available regardless of source format: a Markdown document with YAML frontmatter and an AsciiDoc document with equivalent header attributes MUST produce the same card shape.

#### Scenario: A Markdown document with frontmatter shows a metadata card
- **WHEN** a user selects a Markdown document whose frontmatter declares `title`, `author`, `date`, `description`, and `tags`
- **THEN** the preview shows a metadata card above the body containing those fields
- **AND** the curated rows render in a consistent order regardless of the order they appeared in the source

#### Scenario: An AsciiDoc document with header metadata shows the same card shape
- **WHEN** a user selects an AsciiDoc document whose header declares an equivalent set of attributes (doctitle, author line, `:revdate:`, `:description:`, `:keywords:`)
- **THEN** the preview shows a metadata card above the body containing those fields
- **AND** the card uses the same row ordering and visual shape as the Markdown card for the same conceptual metadata

#### Scenario: Documents without metadata show no card
- **WHEN** a user selects a Markdown or AsciiDoc document that has no frontmatter and no AsciiDoc header attributes
- **THEN** the preview renders no metadata card
- **AND** the body HTML occupies the same vertical space it did before metadata support was added

#### Scenario: Unknown metadata fields render as a subdued key/value list
- **WHEN** a Markdown document's frontmatter or an AsciiDoc document's header includes fields that are not part of the curated set (e.g. `slug`, `permalink`, `category`)
- **THEN** the preview shows those fields in a subdued generic key/value list within the card
- **AND** the curated fields remain visually prominent above or distinct from the generic list

#### Scenario: Metadata values are sanitized before reaching the DOM
- **WHEN** a metadata value contains `<script>alert(1)</script>`, an `onerror=` attribute, an `<iframe>`, or a `javascript:` URL
- **THEN** no executable script or active-content element is added to the preview DOM
- **AND** the offending content is rendered as escaped text or stripped, matching the body-HTML sanitize posture
