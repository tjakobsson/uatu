## MODIFIED Requirements

### Requirement: Browse supported documents from watched roots
The browser UI SHALL display a sidebar tree grouped by watched root. The tree SHALL list every file accepted by the ignore and exposure filters under each root, recursively. Files classified as Markdown, AsciiDoc, or as viewable text SHALL render as clickable entries that can become the active preview. Files classified as binary SHALL render as non-clickable entries that show a file-type icon but cannot change the active preview. Files matching default-denied secret patterns, hardcoded ignored names, `.uatuignore`, or active `.gitignore` rules MUST NOT appear in the sidebar. The preview pane SHALL render the currently selected non-binary file: Markdown files through the Markdown pipeline, AsciiDoc files through the AsciiDoc pipeline, other text files through the syntax-highlighted code render path.

#### Scenario: Sidebar lists every non-ignored file under each watched root
- **WHEN** watched roots contain a mix of Markdown, AsciiDoc, source code, configuration, and binary files
- **THEN** the sidebar displays all accepted files within the hierarchy of their corresponding watched root
- **AND** Markdown, AsciiDoc, and other text files appear as clickable entries
- **AND** binary files appear as non-clickable entries

#### Scenario: Selecting a Markdown file renders its preview
- **WHEN** a user selects a Markdown file from the sidebar
- **THEN** the preview pane renders that file through the Markdown pipeline
- **AND** the active selection updates to the chosen file

#### Scenario: Selecting an AsciiDoc file renders its preview
- **WHEN** a user selects an AsciiDoc file (`.adoc` or `.asciidoc`) from the sidebar
- **THEN** the preview pane renders that file through the AsciiDoc pipeline
- **AND** the active selection updates to the chosen file

#### Scenario: A `.asc` file is not rendered as AsciiDoc
- **WHEN** the watch root contains a `release-1.0.tar.gz.asc` PGP signature file
- **THEN** the sidebar lists it as a regular text entry rather than as an AsciiDoc document
- **AND** selecting it renders its contents through the syntax-highlighted code path, not the AsciiDoc pipeline

#### Scenario: Selecting a non-Markdown text file renders its preview
- **WHEN** a user selects a non-Markdown, non-AsciiDoc text file (e.g. `.yaml`, `.py`, `.json`) from the sidebar
- **THEN** the preview pane renders that file as syntax-highlighted code
- **AND** the active selection updates to the chosen file

#### Scenario: A binary entry cannot be selected
- **WHEN** a user clicks a binary tree entry
- **THEN** the active selection does not change
- **AND** the preview is not refreshed

#### Scenario: Secret-like files are excluded by default
- **WHEN** a watched root contains common secret-bearing files such as `.env`, `.env.local`, `.npmrc`, credential JSON, or private-key files
- **THEN** those files do not appear as clickable or non-clickable sidebar entries
- **AND** they cannot become the active preview document by direct document ID request

### Requirement: Serve adjacent files from watched roots as static content
For any request path that does not match a known API or built-in asset route, the server SHALL attempt to resolve the path against the union of watched roots and, if the path maps to an existing allowed file inside a watched root, serve that file statically. Static fallback serving MUST apply the same hardcoded ignore, default secret-file denylist, `.uatuignore`, and active `.gitignore` exposure rules as the browser tree. Static fallback serving MUST verify containment after resolving real filesystem paths and MUST NOT serve files reached through symlink escapes outside the watched root. The rendered preview HTML MUST preserve the author's original `src` and `href` URLs verbatim (no URL rewriting); the browser SHALL resolve those references using a per-document base so that relative references such as `<img src="./hero.svg">` in a README just work. Any requested path that resolves outside every watched root, is ignored, is secret-like, is malformed, or cannot be safely resolved MUST receive a non-success response and MUST NOT read or stream the file.

#### Scenario: A README's centered hero image loads via the static file fallback
- **WHEN** a previewed Markdown file contains `<img src="./hero.svg">` whose target exists next to the document and is not ignored or secret-like
- **THEN** the rendered image's `src` attribute is preserved as `./hero.svg`
- **AND** the browser resolves it through the per-document base and receives the image from the static file fallback

#### Scenario: Unrelated paths are 404
- **WHEN** the server receives a request for a path that does not map to any file inside a watched root
- **THEN** the server responds with 404

#### Scenario: Traversal attempts are rejected
- **WHEN** a request path resolves (via `..`) outside every watched root
- **THEN** the server responds with 404 and does not read the file

#### Scenario: Ignored files are not served directly
- **WHEN** a watched root contains a file hidden by `.uatuignore` or an active `.gitignore` rule
- **THEN** a direct static fallback request for that file receives a non-success response
- **AND** the server does not stream the ignored file contents

#### Scenario: Symlink escapes are rejected
- **WHEN** a request path maps through a symlink inside the watched root to a file outside the watched root
- **THEN** the server responds with 404 and does not stream the outside file contents

#### Scenario: Secret-like files are not served directly
- **WHEN** a watched root contains a default-denied secret-like file
- **THEN** a direct static fallback request for that file receives a non-success response
- **AND** the server does not stream the secret-like file contents

#### Scenario: Malformed URL encoding fails safely
- **WHEN** the server receives a fallback request path with malformed percent-encoding
- **THEN** the server responds with a non-success response
- **AND** request handling continues without an uncaught exception

### Requirement: Pin the session to a single non-binary file
The browser UI SHALL provide a pin control on the active document that narrows the running session to that file without restarting the process. Pin SHALL be available for any visible non-binary file (Markdown or text). The server MUST reject file-scope mutations for unknown, ignored, secret-like, or binary document IDs and MUST leave the current scope unchanged when rejecting them. While pinned, the sidebar MUST show only the pinned file and changes to other files MUST NOT alter the active preview. While pinned, follow mode MUST NOT be enabled: the follow control MUST be disabled and its pressed state MUST be false, and pinning while follow was on MUST turn follow off. An unpin control MUST restore the previous folder-scoped view and re-enable the follow control. If the pinned file is deleted on disk, the session MUST automatically revert to folder scope and notify the UI. Pin state is per-session and MAY reset on page reload.

#### Scenario: Pinning narrows the session to one Markdown file
- **WHEN** a user clicks the pin control on the currently previewed Markdown file
- **THEN** the sidebar shows only that pinned document
- **AND** changes to other files under the watched root do not change the preview

#### Scenario: Pinning narrows the session to one text file
- **WHEN** a user clicks the pin control on the currently previewed non-Markdown text file
- **THEN** the sidebar shows only that pinned file
- **AND** changes to other files under the watched root do not change the preview

#### Scenario: Unpinning restores folder scope
- **WHEN** a user clicks the unpin control while a file is pinned
- **THEN** the sidebar re-populates with all non-ignored files under the watched roots

#### Scenario: Deleted pinned file reverts scope
- **WHEN** the pinned file is deleted on disk
- **THEN** the session automatically returns to folder scope
- **AND** the UI reflects the updated sidebar contents

#### Scenario: Pinning disables follow mode
- **WHEN** follow mode is enabled and a user pins the active file
- **THEN** follow mode is turned off
- **AND** the follow control is disabled while pinned

#### Scenario: Unpinning re-enables follow
- **WHEN** a user unpins the active file
- **THEN** the follow control is re-enabled (though follow itself remains off until the user activates it)

#### Scenario: Invalid file-scope mutation is rejected
- **WHEN** a client posts a file scope for a document ID that is unknown, ignored, secret-like, or binary
- **THEN** the server responds with a non-success response
- **AND** the current scope remains unchanged
