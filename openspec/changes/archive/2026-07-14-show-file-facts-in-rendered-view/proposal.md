## Why

The file-facts strip added in PR #117 answers when a file changed and which commit last touched it, but only after the user leaves Rendered view. Because Rendered is the default reading mode, the information requested by issue #115 should be available there without requiring a view switch.

## What Changes

- Show the compact source-style file-facts strip for documents in Rendered view as well as Source view.
- Keep frontmatter metadata and repository-derived file facts as separate surfaces: the metadata card remains in the document body while file facts remain in preview chrome.
- Use the Rendered view strip's freshness segment for the existing on-disk update signal instead of the separate `Updated` header chip whenever facts are available.
- Preserve graceful degradation for non-git roots, never-committed files, failed fact collection, split layouts, and reduced-motion preferences.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `file-facts`: Extend file-fact visibility and the freshness update signal to Rendered view.

## Impact

- Affects preview file-facts rendering, view synchronization, preview header markup/styles, and file-facts unit and E2E coverage.
- Does not change document or diff API payloads, git collection, follow-mode rules, or frontmatter metadata behavior.
- Resolves the remaining Rendered-view gap in issue #115.
