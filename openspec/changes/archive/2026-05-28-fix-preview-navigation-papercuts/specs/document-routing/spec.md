## ADDED Requirements

### Requirement: Open external links from the preview in a new browser tab
Anchors in the rendered preview whose `href` is an absolute `http:` or `https:` URL SHALL open in a new browser tab/window so that following them does NOT unload the uatu SPA. The renderer MUST mark such anchors with `target="_blank"` and `rel="noopener noreferrer"` before sanitization passes the HTML to the browser. The sanitize allowlist MUST permit those two attributes on `<a>` so the markings survive. Same-origin relative links (`other.adoc`, `guides/setup.md`, fragment-only `#section`) MUST NOT be marked and MUST continue to flow through the in-app cross-document and in-page anchor handlers respectively. Both the Markdown and AsciiDoc render paths MUST apply the same rewrite uniformly.

#### Scenario: An external Markdown link opens in a new tab
- **WHEN** a Markdown document contains `[example](https://example.com)`
- **AND** the document is rendered into the preview
- **THEN** the rendered anchor has `target="_blank"`
- **AND** the rendered anchor has `rel="noopener noreferrer"`
- **AND** clicking the anchor does NOT navigate the uatu SPA away

#### Scenario: An external AsciiDoc link opens in a new tab
- **WHEN** an AsciiDoc document contains `https://example.com[example]` or `link:https://example.com[example]`
- **AND** the document is rendered into the preview
- **THEN** the rendered anchor has `target="_blank"` and `rel="noopener noreferrer"`

#### Scenario: A relative cross-document link is not marked external
- **WHEN** a rendered document contains `<a href="other.adoc">` or `<a href="guides/setup.md">`
- **THEN** the rendered anchor does NOT have `target="_blank"`
- **AND** the cross-document anchor handler swaps the preview in place as before

#### Scenario: A fragment-only link is not marked external
- **WHEN** a rendered document contains `<a href="#section">`
- **THEN** the rendered anchor does NOT have `target="_blank"`
- **AND** the in-page anchor handler intercepts the click and scrolls within the document

### Requirement: In-page fragment clicks push a browser history entry
When a user clicks an anchor whose `href` begins with `#` inside the rendered preview, the system SHALL push a new browser history entry whose URL is the current pathname and search query concatenated with the new fragment, so that the back button returns the user to the previous scroll state (fragment-less URL or prior fragment) of the same document rather than to a previously selected document. The system MUST scroll the matching element into view as before. The system MUST NOT push a new history entry when the resulting URL is identical to the current URL (clicking a TOC entry that already corresponds to the active fragment is a no-op). The system MUST NOT disable follow mode for hash-only navigations — follow mode is a document-selection concept and intra-document TOC navigation does not change the active document.

#### Scenario: Clicking a TOC entry pushes a history entry
- **WHEN** a user views a rendered AsciiDoc document with a `:toc:` block
- **AND** the user clicks a TOC entry that links to a fragment
- **THEN** the browser URL gains the corresponding `#fragment`
- **AND** a new history entry is added
- **AND** the matching heading scrolls into view

#### Scenario: Back button after a TOC click returns to the prior scroll state
- **WHEN** a user has clicked a TOC entry from the top of a document
- **AND** the user clicks the browser back button
- **THEN** the URL no longer carries the `#fragment`
- **AND** the active document remains the SAME document (not the previously selected one)
- **AND** the preview scrolls to the top of that document

#### Scenario: Re-clicking the active TOC entry does not grow the history stack
- **WHEN** the URL already carries `#section`
- **AND** the user clicks the same `<a href="#section">` again
- **THEN** no new history entry is pushed
- **AND** the back stack length is unchanged

#### Scenario: Hash-only navigation does not disable follow mode
- **WHEN** follow mode is enabled
- **AND** the user clicks a fragment-only anchor inside the active document
- **THEN** follow mode remains enabled
- **AND** subsequent file-system changes can still auto-switch the preview

## MODIFIED Requirements

### Requirement: Navigate document history with the browser back and forward buttons
The system SHALL handle the browser's `popstate` event by re-selecting the document identified by the new URL pathname, without itself pushing or replacing additional history entries. The newly active document MUST be loaded through the in-app document load path (no full-page navigation). When the URL pathname resolves to a document outside the current scope or to no known document, the system MUST apply the same empty-preview rules defined in "Open a document by direct URL". When `popstate` fires AND follow mode is currently enabled, the system MUST disable follow mode for the session so the next file-system change does not immediately undo the back/forward navigation; this mirrors the follow-off rule that already applies to sidebar clicks, cross-document link clicks, and direct-link arrival. When `popstate` fires AND the new URL's pathname (decoded, leading slashes stripped) matches the active document's relative path AND only the fragment has changed, the system MUST treat the event as a same-document scroll: scroll the matching element into view when the new URL has a fragment, scroll the preview to the top when the new URL has no fragment, and MUST NOT reload the document, MUST NOT push or replace history, and MUST NOT disable follow mode.

#### Scenario: Back button restores a previously selected document
- **WHEN** a user has navigated from `README.md` to `guides/setup.md` to `guides/troubleshooting.md` via in-app clicks
- **AND** the user clicks the browser back button
- **THEN** the active preview returns to `guides/setup.md`
- **AND** the sidebar selection matches

#### Scenario: Forward button restores a document the user just stepped back from
- **WHEN** a user has stepped back from `guides/troubleshooting.md` to `guides/setup.md`
- **AND** the user clicks the browser forward button
- **THEN** the active preview returns to `guides/troubleshooting.md`

#### Scenario: Popstate to a no-longer-existent document renders empty preview
- **WHEN** a history entry refers to a document that has since been deleted from disk
- **AND** the user navigates to that entry via back/forward
- **THEN** the SPA renders an empty-preview state with a "document not found" message
- **AND** the sidebar still functions

#### Scenario: Browser back disables follow mode
- **WHEN** follow mode is enabled
- **AND** the user clicks the browser back button to switch to a previously selected document
- **THEN** the active preview returns to the previous document
- **AND** follow mode is disabled
- **AND** a subsequent file-system change does NOT auto-switch the preview away from the back-navigated document until the user re-enables follow

#### Scenario: Popstate that only changes the fragment scrolls within the same document
- **WHEN** the user has clicked a TOC entry inside `guides/setup.md` and the URL now reads `/guides/setup.md#installation`
- **AND** the user clicks the browser back button
- **THEN** the URL becomes `/guides/setup.md` (no fragment)
- **AND** the active document remains `guides/setup.md`
- **AND** the preview scrolls to the top of `guides/setup.md`
- **AND** the document is NOT reloaded
- **AND** follow mode (if enabled) remains enabled
