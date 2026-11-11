# document-routing Specification

## Purpose
Route documents, commit previews, cross-document links, and fragments through the SPA with accurate URLs and browser history while preserving native handling for external and binary links.

## Requirements

### Requirement: Navigate cross-document anchor clicks inside the preview
Eligible same-origin preview links SHALL navigate through the SPA, loading known non-binary watched documents or showing the in-app unknown-path state. Interception SHALL preserve native exclusions, document-relative resolution, fragments, browser history, and existing WebSocket connections.

#### Scenario: Preview interception resolves documents and unknown paths in place
- **WHEN** a rendered-preview anchor resolves to the current origin and no non-`http(s):` or other exclusion applies
- **THEN** the SPA SHALL handle it without full navigation and SHALL load known non-binary documents under any watched root through its document load path
- **AND** unknown/non-viewable paths SHALL show "Document not found" and push the unknown path to the URL bar, EXCEPT binary documents MUST fall through to native static-file byte delivery
- **AND** targets MUST resolve against per-document `<base href>` so relative `xref:other.adoc[…]` and `[setup](guides/setup.md)` reach the correct document
- **AND** rendering the unknown-path state MUST NOT tear down/restart open WebSockets, notably terminal per-pane connections

#### Scenario: Native link gestures and protocols bypass cross-document interception
- **WHEN** a preview click has fragment-only href, Cmd/Ctrl/Shift/Alt modifier, explicit non-`_self` target, different origin, non-`http(s):` protocol such as `mailto:`, `javascript:`, or `tel:`, or a binary document path
- **THEN** cross-document interception MUST NOT fire and browser default behavior MUST remain, with fragment-only href left to the existing in-page handler

#### Scenario: Resolved cross-document links retain fragment and Back behavior
- **WHEN** an intercepted link changes active document or URL
- **THEN** it MUST push `history.pushState` with target relative path percent-encoded per segment so Back can return to the prior document
- **WHEN** a resolvable document load completes with a fragment such as `other.adoc#section`
- **THEN** it SHALL scroll to the matching element using sanitize's `user-content-` prefix behavior like the in-page anchor handler

#### Scenario: Clicking an AsciiDoc cross-document link swaps the preview in place
- **WHEN** a user clicks an anchor in an AsciiDoc preview whose `href` is `asciidoc-cheatsheet.adoc`
- **AND** that file is a known non-binary document under a watched root
- **THEN** the preview swaps to render `asciidoc-cheatsheet.adoc`
- **AND** the page URL pathname updates to `/asciidoc-cheatsheet.adoc`
- **AND** a new history entry is pushed
- **AND** the browser does NOT request `/asciidoc-cheatsheet.adoc` from the static-file fallback as a sub-resource fetch
- **AND** the sidebar selection follows the new document

#### Scenario: Clicking a Markdown cross-document link swaps the preview in place
- **WHEN** a user clicks an anchor in a Markdown preview whose `href` is `guides/setup.md`
- **AND** that file is a known non-binary document under a watched root
- **THEN** the preview swaps to render `guides/setup.md`
- **AND** the page URL pathname updates to `/guides/setup.md`
- **AND** a new history entry is pushed
- **AND** the sidebar selection follows the new document

#### Scenario: A subdirectory cross-document link still swaps the preview
- **WHEN** a user clicks an anchor whose `href` resolves through the per-document `<base href>` to a non-binary document inside a subdirectory of a watched root
- **THEN** the preview swaps to render that document
- **AND** the page URL pathname updates to that document's relative path

#### Scenario: Clicking an unknown same-origin link shows the in-app empty state
- **WHEN** a user clicks an anchor whose `href` resolves to a same-origin path that the SPA cannot map to any known document (e.g., a renamed file, a typo in a hand-authored link)
- **THEN** the click is intercepted (no browser-level navigation occurs)
- **AND** the preview renders the in-app "Document not found" empty state
- **AND** the URL bar reflects the unknown path
- **AND** any open WebSocket connections (notably the embedded terminal's) remain attached and uninterrupted

#### Scenario: An external link is not intercepted
- **WHEN** a user clicks an anchor whose `href` origin differs from the current page (e.g. `https://example.com`)
- **THEN** the click is NOT intercepted and the browser navigates to the external URL natively

#### Scenario: A modifier-click is not intercepted
- **WHEN** a user holds Cmd, Ctrl, Shift, or Alt and clicks a cross-document anchor
- **THEN** the click is NOT intercepted and the browser handles it natively (typically opening the resolved URL in a new tab)

#### Scenario: A link to a binary document is not intercepted
- **WHEN** a user clicks an anchor whose `href` resolves to a document classified as binary under a watched root
- **THEN** the click is NOT intercepted and the browser fetches the URL through the static-file fallback

#### Scenario: A fragment-only link is left to the in-page anchor handler
- **WHEN** a user clicks an anchor whose `href` begins with `#`
- **THEN** the cross-document handler does NOT intercept and the existing in-page anchor handler scrolls the matching id into view inside the current document

#### Scenario: An oversized AsciiDoc file falls back to plain text
- **WHEN** a user selects an `.adoc` file at or above 1 MB
- **THEN** the preview renders the contents inside `<pre><code class="hljs">` as plain escaped text
- **AND** Asciidoctor is not invoked on the contents

### Requirement: Reflect the active document in the URL
The URL pathname SHALL track the previewed document throughout the watch session. User document changes MUST push history, Follow filesystem switches MUST replace history, and unchanged documents MUST NOT trigger URL updates.

#### Scenario: Document URL updates distinguish user navigation from Follow
- **WHEN** sidebar click, cross-document preview link, or manual pin/unpin changes the rendered file
- **THEN** the system MUST `history.pushState` with its relative path percent-encoded per segment
- **WHEN** filesystem-driven Follow auto-switches the document
- **THEN** it MUST `history.replaceState` to keep the address accurate without adding file-change entries
- **WHEN** the page initially loads
- **THEN** it MUST call `history.replaceState` once to populate the current document identifier in `history.state` for unambiguous `popstate`

#### Scenario: Clicking a sidebar entry pushes a history entry
- **WHEN** a user clicks a non-binary document in the sidebar tree
- **THEN** the browser URL pathname updates to the clicked document's relative path
- **AND** a new entry is added to the browser history stack
- **AND** clicking the browser back button restores the previously selected document

#### Scenario: Clicking a cross-document link in the preview pushes a history entry
- **WHEN** a user clicks an anchor in the preview whose href resolves to a known non-binary document under a watched root
- **THEN** the browser URL pathname updates to that document's relative path
- **AND** a new entry is added to the browser history stack

#### Scenario: Follow-mode auto-switch replaces the URL without pushing
- **WHEN** follow mode is enabled and a file-system change causes the active document to switch
- **THEN** the browser URL pathname updates to the new document's relative path
- **AND** no new entry is added to the browser history stack
- **AND** clicking the browser back button does NOT step backward through the chain of follow-driven switches

#### Scenario: Path segments are percent-encoded
- **WHEN** the active document's relative path contains characters that require encoding (e.g. spaces, unicode, `#`, `?`)
- **THEN** each path segment in the URL is percent-encoded via `encodeURIComponent`
- **AND** the URL remains parseable and round-trips back to the original relative path on decode

### Requirement: Open a document by direct URL
Explicit URLs SHALL determine the initial document or preview. Root arrivals without explicit preview queries SHALL restore valid personal destinations or session defaults, subject to intentional deselection and unchanged scope, fallback, fragment, and paused-media rules.

#### Scenario: Explicit and saved destinations respect preview priority and scope
- **WHEN** an initial preview destination is resolved
- **THEN** known non-binary documents, previewable images, and recognized audio/video SHALL be valid explicit/saved destinations
- **AND** explicit commit-preview and other supported queries SHALL override saved documents; absent an explicit root preview query a valid personal document path SHALL restore, otherwise session default
- **AND** media URLs/saved previews SHALL open paused without restoring audition sessions; explicit paths SHALL not widen CLI single-file scope
- **AND** unknown paths SHALL retain static-fallback/SPA behavior, fragments SHALL retain applicable normal post-render handling, and intentional deselection SHALL override implicit restoration

#### Scenario: Root URL restores the personal document
- **WHEN** the workspace root is opened and personal state names a valid document
- **THEN** the preview and file selection restore that document

#### Scenario: Root URL falls back to the session default
- **WHEN** the root URL has no valid saved destination or intentional-empty state
- **THEN** the session default is selected

#### Scenario: Navigating directly to a document URL renders that document
- **WHEN** an explicit known document URL is opened and a different destination is saved
- **THEN** the explicit URL determines preview and selection

#### Scenario: Refreshing an explicit document preserves it
- **WHEN** a document URL is refreshed
- **THEN** that document remains the initial preview

#### Scenario: Refreshing an image Follow switched to preserves it
- **WHEN** Follow displayed an image and its explicit URL is refreshed
- **THEN** that image is previewed with Follow off

#### Scenario: Root URL restores a saved image
- **WHEN** personal state names a valid previewable image
- **THEN** a root arrival restores that image

#### Scenario: Explicit preview query wins over saved document
- **WHEN** a supported explicit preview query is present
- **THEN** the requested preview is displayed instead of a saved document

#### Scenario: A direct link outside a single-file watch scope is rejected
- **WHEN** an explicit path is outside a CLI single-file scope
- **THEN** the existing scoped-session explanation is shown without widening the scope

#### Scenario: A video URL is refreshed
- **WHEN** an allowed recognized video's URL is opened or refreshed
- **THEN** the SPA shows that video's paused preview rather than autoplaying or selecting another document

#### Scenario: Root arrival restores saved audio without autoplay
- **WHEN** personal state names an allowed recognized audio file
- **THEN** its paused preview is restored without restoring prior playback position or active auditioning

### Requirement: Server returns the SPA shell for unknown HTML-preferring navigations
Unknown-path navigation fallback SHALL serve the SPA shell for HTML-preferring navigations without an existing static file under any watched root. Non-HTML-preferring unknown requests SHALL retain `404 Not Found` behavior.

#### Scenario: Accept preference distinguishes SPA navigation from raw resource requests
- **WHEN** a top-level browser navigation prefers `text/html` in `Accept` and its path is neither a known viewable document nor existing static file under any watched root
- **THEN** the server SHALL return the same SPA HTML shell used for known viewable paths rather than 404, and SPA boot renders "Document not found"
- **WHEN** an unknown-path request is non-HTML-preferring, such as `curl` with `Accept: */*` or a subresource with `Accept: image/*`
- **THEN** server behavior SHALL remain `404 Not Found`

#### Scenario: HTML-preferring navigation to an unknown path serves the SPA shell
- **WHEN** the server receives a GET to `/no-such-doc.md` with `Accept: text/html,application/xhtml+xml,*/*`
- **AND** no document is known at that path
- **AND** no static file exists at that path
- **THEN** the response status is `200`
- **AND** the response body is the SPA shell HTML (the same body served at `/`)
- **AND** the SPA, once booted, renders the in-app "Document not found" empty state

#### Scenario: curl to an unknown path still returns 404
- **WHEN** the server receives a GET to `/no-such-doc.md` with `Accept: */*`
- **AND** no document is known at that path
- **AND** no static file exists at that path
- **THEN** the response status is `404`
- **AND** the response body is `Not Found`

#### Scenario: HTML-preferring navigation to a watched image serves the SPA shell
- **WHEN** the server receives a GET to `/diagram.png` with `Accept: text/html,application/xhtml+xml,*/*`
- **AND** `diagram.png` is a known file under a watched root
- **THEN** the response status is `200`
- **AND** the response body is the SPA shell, which renders `diagram.png` in the preview
- **AND** the response is NOT the file's bytes

### Requirement: Force follow mode off when arriving via a direct document URL
An explicit non-root URL resolving to a known non-binary document, previewable image, or recognized media file SHALL disable Follow at boot regardless of the launch default, and the control SHALL reflect that state. The user SHALL remain able to re-enable Follow explicitly. Root arrival SHALL retain existing initial-Follow resolution. Opening media through any URL SHALL not initiate playback.

#### Scenario: Direct link arrival turns follow mode off
- **WHEN** an explicit document, image, or recognized media URL is opened with launch Follow enabled
- **THEN** Follow is disabled and its toggle reflects that state

#### Scenario: Default-URL arrival honors the CLI follow default
- **WHEN** the workspace root is opened without a saved overriding preference or intentional-empty state
- **THEN** the existing launch Follow default applies

#### Scenario: User can re-enable follow after a direct-link arrival
- **WHEN** the user enables Follow after a direct-link arrival
- **THEN** existing eligible document/image catch-up behavior resumes without autoplaying media

### Requirement: Navigate document history with the browser back and forward buttons
`popstate` SHALL restore preview destinations in-app without additional history writes. Back/Forward destination changes SHALL disable Follow; same-document fragments SHALL preserve it. Media history SHALL preserve independently active playback without starting or replacing audition sessions.

#### Scenario: History restores media, unavailable destinations, and fragments without side effects
- **WHEN** `popstate` restores documents, previewable images, or recognized media
- **THEN** in-app preview loading SHALL avoid pushing/replacing history, and unknown/out-of-scope destinations SHALL use existing empty-preview rules
- **AND** media SHALL be paused except the same clip's independently active session SHALL continue without duplicate source
- **AND** destination-changing Back/Forward SHALL disable Follow, but same-document fragment-only transitions SHALL scroll to fragment/top without reload, history change, or Follow change
- **AND** history alone SHALL not start or replace an independently active audition session

#### Scenario: Back button restores a previously selected document
- **WHEN** Back follows navigation across several document destinations
- **THEN** the preceding document and sidebar selection are restored without full-page navigation

#### Scenario: Forward button restores a document the user just stepped back from
- **WHEN** Forward follows a document-history Back action
- **THEN** the later document and selection are restored

#### Scenario: Back button returns to an image Follow switched to
- **WHEN** history contains a previewable image destination
- **THEN** Back restores the image preview without a document-not-found notice

#### Scenario: Popstate to a no-longer-existent document renders empty preview
- **WHEN** the destination was deleted or is outside current scope
- **THEN** the appropriate unavailable preview is shown while Files remains usable

#### Scenario: Browser back disables follow mode
- **WHEN** Back changes the preview destination while Follow is on
- **THEN** Follow turns off and later file writes do not undo that navigation

#### Scenario: Popstate that only changes the fragment scrolls within the same document
- **WHEN** only the fragment changes in the current document's history
- **THEN** the preview scrolls to its target or top without reloading or changing Follow

#### Scenario: Back restores a video preview while another clip is auditioned
- **WHEN** Back resolves to a recognized video and a different audition session is active
- **THEN** that video's preview opens paused and does not replace or duplicate the active audition

### Requirement: Navigate Git Log commit previews by URL
Git Log commit previews SHALL use same-origin SPA-root URLs with `repository` and `commit` queries. They MUST resolve only against current bounded repository commit-log state, restore on direct arrival, refresh, and `popstate`, and show unavailable rather than unrelated documents when unresolved.

#### Scenario: Commit destination resolution stays within current bounded state
- **WHEN** a commit preview URL arrives directly, is refreshed, or is restored by `popstate`
- **THEN** the browser MUST resolve it against repository commit-log data already in the current bounded state payload
- **AND** absent repository/commit data MUST produce a clear empty-preview unavailable state, not unrelated document selection

#### Scenario: Direct commit preview URL renders the commit message
- **WHEN** a user navigates directly to `/?repository=<repositoryId>&commit=<commitSha>`
- **AND** the current state payload contains that repository and commit in its bounded commit log
- **THEN** the SPA boots with that commit message rendered in the main preview
- **AND** no document is selected in the file tree
- **AND** Follow mode is disabled

#### Scenario: Refreshing a commit preview URL restores the commit preview
- **WHEN** a user has opened a commit preview whose URL contains `repository` and `commit` query parameters
- **AND** the user refreshes the page
- **THEN** the SPA boots and renders the same commit preview again
- **AND** the URL remains the commit preview URL

#### Scenario: Back button restores the previous preview from a commit preview
- **WHEN** a user opens a document preview
- **AND** the user opens a commit preview from the Git Log
- **AND** the user clicks the browser back button
- **THEN** the active preview returns to the previous document
- **AND** the sidebar selection matches that document

#### Scenario: Forward button restores a commit preview
- **WHEN** a user has stepped back from a commit preview to a document preview
- **AND** the user clicks the browser forward button
- **THEN** the active preview returns to the commit preview
- **AND** no document is selected in the file tree

#### Scenario: Commit preview URL references unavailable data
- **WHEN** a user navigates to a commit preview URL whose repository or commit is not present in the current bounded state payload
- **THEN** the SPA renders an empty-preview state explaining that the commit preview is unavailable
- **AND** the sidebar remains usable

#### Scenario: Active commit preview is re-resolved after state refresh
- **WHEN** the active preview is a commit preview
- **AND** the browser receives a refreshed state payload
- **THEN** the browser re-resolves the active repository and commit against the refreshed payload
- **AND** the preview renders the refreshed commit data when the commit is still present
- **AND** the preview renders an unavailable empty state when the commit is no longer present

### Requirement: Open external links from the preview in a new browser tab
Absolute `http:`/`https:` preview anchors SHALL open a new tab/window without unloading the SPA, using safe renderer markings preserved through sanitization. Both Markdown and AsciiDoc MUST apply the rewrite uniformly; relative and fragment links MUST retain in-app handling.

#### Scenario: External-link rewrite survives sanitization without capturing relative links
- **WHEN** Markdown or AsciiDoc renders absolute `http:`/`https:` anchors
- **THEN** the renderer MUST add `target="_blank"` and `rel="noopener noreferrer"` before sanitization, whose `<a>` allowlist MUST permit both attributes
- **AND** same-origin relative `other.adoc`, `guides/setup.md`, and fragment-only `#section` links MUST NOT receive those markings and MUST continue through cross-document and in-page handlers respectively

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
Rendered-preview fragment clicks SHALL push changed fragment URLs and scroll to matching elements, allowing Back to restore the same document's prior scroll state. Identical URLs MUST NOT add history, and hash-only navigation MUST NOT disable Follow.

#### Scenario: Fragment history preserves the current document and Follow state
- **WHEN** a rendered-preview anchor whose href begins `#` is clicked
- **THEN** the system SHALL push current pathname plus search query plus new fragment so Back reaches the same document's prior fragment or fragment-less scroll state, not a previously selected document
- **AND** it MUST scroll the matching element into view as before
- **AND** if resulting URL is identical it MUST NOT push, making repeated active-TOC clicks no-ops
- **AND** hash-only navigation MUST NOT disable Follow because it changes no active document

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
