# document-metadata-card Specification

## Purpose
Present sanitized, consistently normalized Markdown and AsciiDoc metadata above the document body while preserving unknown fields and omitting the card when metadata is absent.
## Requirements
### Requirement: Surface document metadata above the body

The preview SHALL show present document metadata in one format-agnostic card above the body, normalize curated fields, and subdue other key/value fields. All values MUST be escaped or sanitized like body HTML, and documents without metadata MUST omit the card.

#### Scenario: Normalize all curated metadata across source formats
- **WHEN** Markdown YAML/TOML frontmatter or AsciiDoc headers supply title, author(s), date, revision/version, description, tags/keywords, or status
- **THEN** present fields appear in the single card above the rendered body; equivalent metadata MUST produce the same card shape across formats
- **AND** format-specific keys MUST normalize consistently: AsciiDoc `:keywords:` and Markdown `tags` share the `tags` row; AsciiDoc `:revnumber:` and Markdown `version` share `revision`

#### Scenario: Retain additional fields without elevating their prominence
- **WHEN** metadata includes fields outside the curated set
- **THEN** they MUST render as a visually subdued generic key/value list, leaving curated fields prominent

#### Scenario: Enforce the metadata security boundary
- **WHEN** any metadata value reaches the DOM
- **THEN** it MUST be HTML-escaped or processed by the same GitHub-modeled sanitize allowlist as body HTML
- **AND** `<script>`, `<iframe>`, inline event handlers, and `javascript:` URLs MUST NOT execute

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
