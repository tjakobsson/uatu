## Why

This project needs a fast local way to browse rendered Markdown documents from one or more directories without manually reopening files after every save. A CLI-first watch mode with a browser UI keeps the workflow simple while creating a foundation for a standalone documentation viewer.

After the first implementation pass, the rendering and presentation requirements became more specific: the preview should start in light mode, follow GitHub-style Markdown presentation more closely, support Mermaid diagrams, and preserve the project's ability to remain MIT-licensed by avoiding copyleft dependencies.

## What Changes

- Add a `uatu watch [PATH...]` command that treats positional paths as watched roots and defaults to the current directory when no paths are provided.
- Start a local browser-based UI that shows a sidebar tree of watched Markdown files and a preview pane for the selected document.
- Enable live refresh for the active document and a default-on follow mode that switches the preview to the latest changed Markdown file.
- Auto-open the browser when possible, always print the local URL, and provide CLI flags to disable auto-open and follow mode.
- Implement the runtime in TypeScript with Bun and package the tool as a standalone executable built from the Bun project.
- Render Markdown using a local GitHub Flavored Markdown-compatible pipeline and style the preview to match GitHub's light-mode Markdown presentation by default.
- Support Mermaid diagram rendering for fenced `mermaid` code blocks in the preview.
- Restrict bundled and runtime dependencies to permissive, non-copyleft licenses so the project can remain MIT-licensed.
- Limit v1 rendering support to Markdown and defer AsciiDoc support to a later change.

## Capabilities

### New Capabilities
- `document-watch-browser`: Watch local directories, browse supported documents in a sidebar, and preview them in a browser with optional follow mode, GitHub-style rendering, and Mermaid support.

### Modified Capabilities

None.

## Impact

- Introduces the first user-facing CLI command and its flags.
- Requires a Bun-based local HTTP server, filesystem scanning/watching, and a GitHub Flavored Markdown-compatible rendering pipeline.
- Requires a browser UI with a file tree, preview pane, live update behavior, and light-mode GitHub-style Markdown presentation.
- Requires Mermaid integration for fenced diagram blocks.
- Requires dependency license review for bundled and runtime packages.
- Requires a Bun compile/distribution path for a standalone executable.
