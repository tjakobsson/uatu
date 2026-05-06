## Why

The first slice of UatuCode's "talk to AI coding agents" surface needs to produce *file/line references in the at-mention syntax those agents already understand* — concretely, Claude Code's `@<path>#L<start>-<end>` shape (the same shape claudecode.nvim emits from a Neovim visual selection). The browser's native copy and the existing per-block Copy button at `src/app.ts:1418` already cover plain text, so capturing the *text* of a selection adds nothing. What an AI-review workflow actually needs is the **path + line range identifier** the agent uses to pull the relevant code into its context.

Producing that identifier from a user selection runs into one architectural problem: the rendered HTML for Markdown / AsciiDoc has no source-position information. Threading source-line annotations through the Markdown and AsciiDoc render pipelines is feasible but invasive, and it still leaves edge cases (rendered images, metadata cards, cross-block selections) that map awkwardly back to source.

A cleaner answer is a **per-document Source / Rendered toggle**. Source view feeds the existing source-rendering pipeline — `<pre><code>` with the line-number gutter at `src/app.ts:1393` — for *any* file kind. The selection inspector then operates exclusively against the source-view DOM, where line counting is exact (each `\n` in `code.textContent` is a real source line) and uniform across Markdown, AsciiDoc, and source code. Less code than annotating two render pipelines, and the toggle is independently useful — read prose in Rendered view, flip to Source to grab a line reference.

## What Changes

- Add a per-document **Source / Rendered** view toggle in the preview header. The toggle is hidden for documents that have no rendered alternative (already source-only) and for non-document previews (commit views, review-score views, empty state).
- Add a Source-view rendering path that returns the file's verbatim text wrapped in the existing `<pre><code>` + line-number-gutter scheme, regardless of the file's kind.
- The user's view-mode preference is **global and persisted** in `localStorage` (one setting for the whole UI, like Mode and Follow), defaulting to Rendered.
- Add a **Selection Inspector** sidebar pane registered only in Review mode (Author hides it; Author's Follow auto-switches the active preview, which would routinely yank captures out from under the pane). The pane:
  - Captures `{ path, startLine, endLine }` from selections inside the source-view whole-file `<pre><code>` of the active document.
  - Displays the captured selection as a Claude-Code-style at-mention reference: `@<path>#L<startLine>-<endLine>` for multi-line, collapsed to `@<path>#L<n>` for single-line.
  - Copies that reference to the clipboard when the user clicks (or activates via keyboard) the displayed reference.
  - Shows an *active hint* in Rendered view ("Switch to Source view to capture a line range.") that flips the global view-mode toggle to Source when activated.
  - Ignores selections inside fenced code blocks rendered as descendants of Markdown / AsciiDoc body content (the per-fenced-block gutter is block-relative, not source-relative).
  - Clears its captured state on document swap and on view-mode toggle.
  - No keyboard shortcut, no automatic send to any external sink — those are explicit non-goals for this slice.

## Capabilities

### New Capabilities

- `document-source-view`: Per-document Source / Rendered preview toggle and the source-view rendering path it feeds. Foundation for any preview affordance that needs deterministic, source-aligned line numbering across all renderable file kinds.
- `selection-inspector`: Live, read-only Review-mode pane that observes the user's selection inside the source-view preview and produces a Claude-Code-style at-mention reference (`@path#L<a>-<b>`), copy-on-click. Foundation for later send-to-agent workflows.

### Modified Capabilities

- `document-watch-browser`: Mode-aware UI chrome refinements that fall out of building the Selection Inspector / Source view alongside the existing Mode toggle. Specifically: the Follow control is **hidden** in Review (was: rendered disabled), the live-connection indicator's **location** moves from the preview toolbar to the sidebar header under the UatuCode wordmark, the **label** becomes `Connected` (was: `Online` / `Reading — auto-refresh paused`), and the user's Author-mode Follow choice is **snapshotted** so it round-trips through Review automatically.

## Impact

- **Code**:
  - **Server**: extend the document-render endpoint (or add a sibling) so the client can request a source-view rendering for any file kind. The existing source-rendering path already handles `<pre><code>` + syntax highlighting for text files — this generalizes that path to apply to Markdown / AsciiDoc when source view is requested.
  - **Client**: new global view-mode state + persistence helper; new toggle UI in the preview header; rewritten `src/selection-inspector.ts` capturing line ranges instead of text; new pane DOM with reference display + copy button + hint slot; sidebar pane registered Review-only (already in place from the prior pane-only iteration).
  - **CSS**: pane content layout for the three states (placeholder, hint, reference), Source/Rendered toggle styling consistent with the existing Mode toggle.
- **APIs**: extend `GET /api/document` (or sibling) with a `view=source` parameter. No breaking change to the existing rendered response shape.
- **Dependencies**: none added.
- **Tests**: unit tests for the line-counting helper and the reference-format helper; Playwright e2e tests for the toggle, source-view rendering, the pane's three states, copy-on-click, fenced-code-block exclusion, and persistence.
- **Persistence**: one new `localStorage` key for the global view-mode preference; the pane participates in the existing per-mode pane state. Selection / pane-state-machine state itself remains ephemeral.
- **Out of scope (deferred)**:
  - Agent-IDE protocol bridges (Claude Code lock-file, opencode, MCP) — Stage 2.
  - Send-to-agent button or hotkey.
  - Alternative reference formats (opencode's syntax differs; v1 ships Claude format only).
  - Hotkeys for capture or copy.
  - Capture history.
  - Column-precision (lines only).
  - Per-document view-mode preference (one global preference only).
  - CLI override (`--view=source`) at startup — easy follow-up if useful.

## Note on existing implementation

A prior pass on this change captured selections as `{ path, text }` and rendered the text directly into the pane, without a Source/Rendered toggle and without click-to-copy. That work has produced reusable infrastructure (Review-only pane registration, Author-mode hidden behavior, selectionchange listener pattern, document-swap recompute hook, persistence wiring) but the captured *shape*, the *display*, and the *interaction* all need to be redone against this proposal. The implementer should treat the prior pane DOM and module structure as scaffolding to refactor — not as completed work.
