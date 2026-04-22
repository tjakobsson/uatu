## Context

The repository currently has no application code, so this change establishes both the first end-user command and the first runtime architecture. The product shape is a CLI-first local tool that starts a localhost server, opens a browser UI, indexes Markdown files under one or more watched roots, and keeps the preview in sync with filesystem activity.

The most important constraints are: the tool must be distributed as a standalone executable, the primary user workflow starts in the terminal, and v1 should stay limited to Markdown so the watch/browse/follow experience can be proven before adding more formats. The implementation direction has changed from Go to TypeScript with Bun so the CLI, local HTTP server, and browser assets can live in one runtime and build pipeline.

The rendering requirements are now more specific than in the first cut. The preview should default to light mode, feel visually close to GitHub's Markdown presentation, and support Mermaid diagrams inside Markdown. The project also has a licensing constraint: bundled and runtime dependencies must avoid copyleft licenses so the project can remain MIT-licensed.

The long-lived capability name for this area should stay format-neutral even though the current scope remains Markdown-only. That keeps the spec extensible when additional document formats such as AsciiDoc are introduced later.

## Goals / Non-Goals

**Goals:**
- Provide a `uatu watch [PATH...]` command with sensible defaults and minimal required flags.
- Render Markdown documents in a browser UI with a sidebar tree grouped by watched root.
- Support live refresh of the active document and default-on follow mode for the latest changed Markdown file.
- Render GitHub Flavored Markdown-compatible output locally, styled like GitHub's light-mode Markdown presentation.
- Render Mermaid diagrams from fenced `mermaid` code blocks.
- Keep bundled and runtime dependencies compatible with a permissive-license policy.
- Provide a developer-only end-to-end test workflow that can be run locally before CI and later in pipeline automation.
- Keep the distribution story compatible with a single standalone executable.

**Non-Goals:**
- Support AsciiDoc in v1.
- Add root management, search, tabs, or history to the browser UI.
- Build a general-purpose file browser for arbitrary file types.
- Require anything except the `uatu` binary at runtime.
- Expose Playwright, browser automation tooling, or test-only dependencies to end users of the compiled binary.

## Decisions

### Implement the runtime in TypeScript and compile it with Bun
This product is fundamentally a local web application with a CLI entrypoint: it starts a local HTTP server, serves a browser UI, watches the filesystem, and coordinates live updates. Bun fits that shape well because it can run the CLI and server directly in TypeScript while also compiling the project into a standalone executable for distribution.

Alternatives considered:
- Go: stronger "true native binary" story, but weaker fit for a browser-first local app and for future AsciiDoc support if that returns.
- Node.js without Bun compile: workable during development, but weaker distribution ergonomics because it reintroduces an external runtime requirement.
- Rust: also a valid standalone-binary option, but adds more implementation complexity without a clear product advantage for this first cut.

### Use Bun's standalone executable workflow for distribution
The distributed artifact should still feel like a single-file CLI tool even if it carries the Bun runtime internally. Bun's compile support keeps the development model close to the deployed model and can bundle server code and frontend assets into one executable.

Alternatives considered:
- Shipping a plain npm package: simpler to publish, but not aligned with the desire for a standalone executable.
- Building a desktop shell such as Electron or Tauri: unnecessary for a localhost-and-browser workflow.

### Render Markdown locally with a GitHub Flavored Markdown-compatible pipeline
The preview should behave like GitHub README rendering without depending on network access or GitHub's REST API. The practical target is local GFM-compatible rendering for common README features such as tables, task lists, autolinks, strikethrough, and fenced code blocks. An MIT-licensed parser stack such as `micromark` plus `micromark-extension-gfm` is a better fit than a generic Markdown renderer because it aligns more directly with the GFM spec while staying permissively licensed.

Alternatives considered:
- GitHub's `/markdown` API: closer to GitHub's own HTML output, but unsuitable for an offline local tool and requires network access and possibly credentials.
- Keep `markdown-it`: workable for basic Markdown, but weaker as an explicit GFM fidelity choice now that GitHub-style rendering is a stated goal.
- Bind to `cmark-gfm`: BSD-2 licensed and close to GitHub semantics, but adds native binding and packaging complexity to the Bun executable.

### Use GitHub Markdown CSS light theme as the default presentation
The preview should default to light mode and look visually familiar to GitHub users. Using the MIT-licensed `github-markdown-css` light stylesheet is the most direct way to align typography, spacing, tables, blockquotes, and code block presentation without hand-maintaining a fragile approximation.

Alternatives considered:
- Maintain a custom light theme: more control, but higher drift risk from GitHub's presentation.
- Support both light and dark in the initial scope: valuable later, but not necessary for the first target now that light mode has been explicitly prioritized.

### Render Mermaid diagrams in the browser from fenced code blocks
Mermaid support should be driven by fenced code blocks marked with the `mermaid` info string. The server-side Markdown renderer should preserve those blocks in a recognizable form and the browser should hydrate them into diagrams using the MIT-licensed `mermaid` package.

Alternatives considered:
- Pre-render diagrams on the server: possible, but more expensive and less aligned with Mermaid's browser-first runtime.
- Defer Mermaid support again: rejected because Mermaid support is part of the updated rendering requirement.

### Enforce a permissive-license dependency policy
The project should remain MIT-licensed and should not bundle or depend at runtime on copyleft-licensed packages. Direct and bundled dependencies should be restricted to permissive licenses such as MIT, BSD, ISC, or Apache-2.0, and new rendering choices should be evaluated against that policy before adoption.

Alternatives considered:
- Allow copyleft transitive or bundled dependencies if they are popular: rejected because it conflicts with the explicit project licensing constraint.
- Restrict every dependency to MIT only: possible, but stricter than the stated requirement and not necessary to avoid copyleft.

### Use Playwright as a developer-only E2E test harness
This project benefits from real browser-level tests because its core value is a live local browser experience driven by filesystem changes. Playwright is the better fit than Puppeteer because it provides a stronger test runner, UI mode for local interactive runs, and better built-in waiting, tracing, and assertions. The Playwright dependency should remain dev-only and must not be bundled into the `uatu` executable or required by end users.

Alternatives considered:
- Puppeteer: capable browser automation, but weaker out-of-the-box test runner ergonomics for this project.
- No E2E browser tests: simpler, but leaves follow mode, Mermaid hydration, and live preview behavior under-tested.
- Using the compiled binary inside every E2E run: closer to production, but slower for local iteration. The default E2E flow can target the Bun runtime while the standalone binary remains covered by separate smoke checks.

### Make local interactive E2E runs a first-class developer workflow
Contributors should be able to run the E2E suite interactively before CI using Playwright's UI or headed modes. The workflow should prepare an isolated watched workspace, start the local `uatu watch` session without auto-opening the browser, and let Playwright drive the same localhost UI that an end user would see.

Alternatives considered:
- Rely only on CI execution: rejected because local iteration speed matters for a UI-heavy tool.
- Reuse tracked fixture files directly without isolation: simpler, but fragile because E2E tests intentionally mutate watched files.

### Use positional paths as watched roots and default to the current directory
`uatu watch [PATH...]` matches common CLI conventions by treating paths as primary operands and flags as behavioral modifiers. If no paths are provided, the command will watch `.` so the simplest invocation remains short and useful.

Alternatives considered:
- Repeated `-d/--dir` flags: explicit but noisier for the primary input.
- Requiring at least one path: stricter, but worse ergonomics for common local use.

### Use explicit watched roots with recursive discovery
The command invocation defines the trust and indexing boundary. Each supplied root is scanned recursively for Markdown files and shown as its own group in the sidebar. This keeps the mental model clear and avoids turning the tool into an unrestricted filesystem watcher.

Alternatives considered:
- Watching a single implicit workspace root: simpler internally, but less useful when users want a curated set of folders.
- Supporting dynamic root management in the browser UI: valuable later, but unnecessary for v1.

### Split the product into an indexed browser view and a follow controller
The browser UI has two stable pieces of state: the document tree and the currently selected document. Follow mode is treated as a selection policy, not the whole product. When follow mode is enabled, eligible filesystem changes switch the selected document to the latest changed Markdown file. Manual sidebar selection disables follow mode and pins the selected document.

Alternatives considered:
- Always jumping on any document change: simpler, but makes manual browsing frustrating.
- Treating follow mode as secondary and defaulting it off: safer, but not aligned with the intended `watch` workflow.

### Combine filesystem watching with index reconciliation
The implementation should react quickly to filesystem events but should not trust watcher semantics alone for long-running correctness. A watcher-driven index update path using Bun or Node-compatible filesystem APIs should be paired with reconciliation logic that can repair missed create, delete, or rename events.

Alternatives considered:
- Polling-only scans: simpler, but less responsive.
- Watcher-only tracking: faster on paper, but more brittle across editors and platforms.

### Keep the SSE channel alive without surfacing server timeout noise
The browser preview relies on a long-lived server-sent events connection for live updates. Because that connection is expected to sit idle between file changes, the Bun server should disable or explicitly override the default idle timeout rather than letting normal operation emit timeout warnings in the terminal.

Alternatives considered:
- Leaving the default timeout and printing a friendlier message: rejected because the timeout itself is not an error condition for this app.
- Reconnecting on a short timeout: possible, but noisier and less stable than simply treating the SSE stream as intentionally long-lived.

## Risks / Trade-offs

- Filesystem event behavior differs across platforms and editors -> Keep the in-memory index repairable through rescans or reconciliation passes.
- Follow mode can feel unpredictable if it fights manual browsing -> Disable follow mode automatically on manual sidebar selection.
- A browser UI inside a CLI tool adds frontend surface area -> Keep the UI narrow: sidebar, preview pane, follow toggle, and connection state only.
- Exact GitHub parity is difficult without GitHub's own post-processing pipeline -> Target local GFM-compatible behavior and GitHub-style presentation rather than byte-for-byte HTML parity.
- Mermaid runs client-side code to render diagrams -> Use Mermaid's safer configuration defaults and keep rendering local to trusted user files.
- License policy can constrain package selection -> Prefer spec-oriented permissive packages over more convenient copyleft options.
- Long-lived SSE streams require server timeout tuning -> Disable the Bun idle timeout for this local app so expected idle periods do not look like failures.
- A Bun-compiled executable is standalone but not "native" in the same sense as Go -> Accept the larger bundled runtime in exchange for a simpler full-stack implementation path.

## Migration Plan

No migration is required because the repository has no existing released behavior. The current implementation should be updated in place to replace the first-pass dark custom theme and generic Markdown renderer with the light GitHub-style presentation, GFM-compatible rendering, Mermaid support, and dependency license checks.

## Open Questions

- Whether to expose a `--host` flag in v1 or keep the server bound to localhost only.
- How aggressive the reconciliation strategy should be before it becomes unnecessary complexity for the first release.
