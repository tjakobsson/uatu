## Why

UatuCode's code-rendering pipeline today is `highlight.js` plus uatu's own
`attachLineNumbers` DOM helper. The look and feel work, but the library is
narrowly focused on tokenizing-and-coloring — uatu has to hand-roll line
gutters, has no shared notion of "highlighter state," and has no path toward
the diff-rendering capability we want next. `@pierre/diffs` (Apache-2.0, from
the same authors as `@pierre/trees` which already powers our document tree)
provides a Shiki-based code renderer with first-class server-side rendering,
real line gutters, theme-aware light/dark, expand-context APIs, and — as a
free downstream — `FileDiff` / `MultiFileDiff` / `PatchDiff` components that
unlock a follow-on change for in-app diff viewing. Adopting it now as the
single code-rendering layer simplifies uatu's render code, retires the
hand-rolled gutter, gives us one consistent visual language across source
view and fenced code blocks, and lays the groundwork for the diff-viewing
capability.

This change is scope-limited to renderer adoption. It does not introduce
diff-viewing surfaces in the UI; those land in a separate follow-on change
that builds on the foundation established here.

## What Changes

- Add `@pierre/diffs` as a runtime dependency; it brings `shiki`,
  `@shikijs/transformers`, `diff`, `@pierre/theme`, and `lru_map` along with
  it (all permissive-licensed).
- Server-side preload Shiki at watch-session startup so the highlighter is
  warm before the first preview request.
- Replace `highlight.js`'s use in `src/markdown.ts` (fenced code blocks) with
  `@pierre/diffs`'s `FileRenderer` AST API, spliced directly into the
  existing hast tree the Markdown pipeline already produces.
- Replace `highlight.js`'s use in `src/asciidoc.ts` (source/listing blocks)
  with the same `FileRenderer` AST path, after the existing Mermaid
  interception runs.
- Replace the whole-file source-view render path (today: server-side
  highlighting via hljs, then client-side `attachLineNumbers` to add a sibling
  gutter `<span>`) with `@pierre/diffs/ssr` `preloadFile` server-side plus
  client-side `File.hydrate` to attach interactivity. The whole-file `<pre>`
  remains a Light-DOM element so the Selection Inspector continues to work
  unchanged.
- Retire `highlight.js` from `package.json`; retire `attachLineNumbers` from
  `src/app.ts`; retire the github-style hljs CSS rules from `src/styles.css`
  in favor of Shiki theme variables.
- Wire the existing theme preference (light/dark mode follows the rest of the
  preview) to a chosen pair of Shiki themes (likely the bundled
  `github-light-default` / `github-dark-default`).
- **BREAKING for the renderer contract** — the rendered DOM shape for
  source view and fenced blocks changes (different class names, different
  gutter implementation). The user-visible behavior (syntax highlighting,
  line gutter, copy-to-clipboard, Selection Inspector line capture, copy
  button, dark/light theming) is preserved.
- Mermaid block detection (Markdown fenced ` ```mermaid ` and AsciiDoc
  `[source,mermaid]` / `[mermaid]`) continues to intercept before any
  syntax-highlight pass — no semantic change, just an updated description of
  the surrounding pipeline.

## Capabilities

### New Capabilities

_None. This change adopts a new dependency to fulfill existing capability
requirements differently; it does not introduce a new capability._

### Modified Capabilities

- `document-rendering`: source-of-truth for code-highlighting behavior moves
  from "highlight.js GitHub style" to "Shiki theme tied to the active light /
  dark preference"; the visual contract for fenced code blocks is preserved
  but pinned to the Shiki theme rather than to a static hljs stylesheet.
- `document-source-view`: the line-number gutter implementation reference
  changes; the spec's existing requirement that the whole-file `<pre>`
  carries a distinguishing class (so the Selection Inspector can identify it)
  is preserved with the class renamed/repositioned to match the new
  renderer's DOM.
- `selection-inspector`: the reference to the per-fenced-block gutter
  location at `src/app.ts:1393` is removed; the inspector's contract that
  it counts newlines in the whole-file `<pre><code>` element's `textContent`
  is preserved, and is explicitly required to remain compatible with the new
  renderer's gutter (which must not contribute to `code.textContent`).

## Impact

- **Code**: `src/markdown.ts`, `src/asciidoc.ts`, `src/file-languages.ts`,
  `src/app.ts` (retire `attachLineNumbers`, adjust the source-view render
  path to hydrate `File`), `src/server.ts` (Shiki preload at startup),
  `src/styles.css` (drop hljs token rules, add Shiki theme wiring).
- **Dependencies**: add `@pierre/diffs`; remove `highlight.js`. The
  transitive license footprint is reviewed by the existing `license-check`
  (all permissive; Apache-2.0 is already on the allow-list).
- **Bundle**: Shiki and Oniguruma WASM replace highlight.js; net bundle
  change is positive in features per byte but slightly larger in absolute
  bytes. SSR keeps the first-paint cost on the server.
- **Tests**: `src/markdown.test.ts`, `src/asciidoc.test.ts`,
  `src/selection-inspector.test.ts`, and any e2e tests touching code blocks
  need their DOM-shape assertions reviewed against the new renderer's output.
- **No change** to: the live-reload SSE channel, the Markdown / AsciiDoc
  parsers themselves, the Mermaid pipeline, the Selection Inspector pane
  behavior, the file tree, or the terminal.
- **Sets up** (out of scope for this change): the follow-on change that adds
  a Changes sidebar pane and Diff view in the preview, which will reuse the
  same `@pierre/diffs` server/client wiring landed here.
