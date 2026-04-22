## 1. CLI and runtime bootstrap

- [x] 1.1 Initialize the Bun/TypeScript application structure and create the `uatu watch` command entrypoint.
- [x] 1.2 Implement positional watched-root parsing with `.` as the default when no paths are provided.
- [x] 1.3 Add startup flags for browser auto-open, follow mode, and port selection, then print the local URL on startup.
- [x] 1.4 Start the local HTTP server and add browser auto-open behavior with graceful fallback when opening fails.

## 2. Markdown indexing and watch pipeline

- [x] 2.1 Implement recursive Markdown discovery for one or more watched roots and keep roots grouped separately in the in-memory index.
- [x] 2.2 Implement Markdown document loading and rendering for the selected file.
- [x] 2.3 Implement filesystem change handling for Markdown file create, delete, rename, and modify events using Bun or Node-compatible filesystem APIs.
- [x] 2.4 Add reconciliation logic so the file index can recover from missed or ambiguous watcher events.

## 3. Browser UI and live preview

- [x] 3.1 Embed and serve the browser UI assets from the Bun executable.
- [x] 3.2 Build the sidebar tree that shows watched roots and recursively discovered Markdown files.
- [x] 3.3 Build the preview pane for the active Markdown document.
- [x] 3.4 Add a live update channel so index and preview changes propagate without a full page reload.

## 4. Follow mode and verification

- [x] 4.1 Implement default-on follow mode that switches to the latest changed Markdown file.
- [x] 4.2 Disable follow mode on manual sidebar selection and keep the selected document pinned until follow is re-enabled.
- [x] 4.3 Add automated tests for Bun CLI defaults, sidebar indexing, live refresh, and follow-mode behavior.
- [x] 4.4 Build and manually verify the `bun build --compile` standalone workflow for `uatu watch`, browser launch, and local browsing.

## 5. Rendering fidelity and licensing

- [x] 5.1 Replace the current Markdown renderer with a permissively licensed GitHub Flavored Markdown-compatible pipeline.
- [x] 5.2 Replace the current preview styling with GitHub light-mode Markdown presentation as the default UI theme.
- [x] 5.3 Render fenced `mermaid` code blocks as Mermaid diagrams in the browser.
- [x] 5.4 Audit direct and bundled dependencies to ensure the change uses no copyleft-licensed packages or assets.
- [x] 5.5 Add tests and manual verification for GFM features, Mermaid rendering, and default light-mode presentation.

## 6. Developer-only E2E testing

- [x] 6.1 Add Playwright as a developer-only E2E test dependency and script surface, including an interactive local run mode.
- [x] 6.2 Add an isolated E2E workspace bootstrap so browser tests can mutate watched files without changing tracked fixtures.
- [x] 6.3 Add Playwright coverage for the sidebar/preview flow, follow-mode behavior, and Mermaid rendering.
- [x] 6.4 Verify the E2E suite runs locally without being bundled into the end-user `uatu` executable.
