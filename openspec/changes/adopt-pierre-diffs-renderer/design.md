## Context

UatuCode's preview pipeline renders code in three places, all currently
going through `highlight.js`:

1. **Whole-file source view** (`src/app.ts`): server emits a
   `<pre class="uatu-source-pre"><code class="hljs">…</code></pre>`; the
   client calls `attachLineNumbers` to insert a sibling `<span
   class="line-numbers">` gutter; the Selection Inspector counts newlines in
   `code.textContent` to capture `@path#Lstart-end` references.
2. **Markdown fenced code blocks** (`src/markdown.ts`): the markdown
   pipeline hands fenced blocks to `hljs.highlight(...)` and stitches the
   result back as a string into the rendered HTML, with a per-block gutter
   added by the same `attachLineNumbers` client-side helper.
3. **AsciiDoc source / listing blocks** (`src/asciidoc.ts`): asciidoctor
   emits stub `<pre><code class="hljs">…</code></pre>` markers (with raw,
   escaped source as the content); the markdown highlight pass later visits
   them via the shared rendering path.

The renderer adoption keeps all three render points but routes them through
`@pierre/diffs` instead. The Mermaid interception (Markdown ` ```mermaid `,
AsciiDoc `[source,mermaid]` and bare `[mermaid]`) continues to short-circuit
the block before any highlighter runs, unchanged.

The library's API surface (verified against `@pierre/diffs@1.1.21`):

- `@pierre/diffs/ssr` exports `preloadFile`, `preloadFileDiff`,
  `preloadMultiFileDiff`, `preloadPatchDiff`, `preloadDiffHTML`,
  `preloadUnresolvedFile*`, and a low-level `renderHTML(children: Element[])`.
- `preloadFile({ file, options, annotations })` returns
  `{ prerenderedHTML: string, file, options, annotations }` after running
  Shiki server-side.
- `FileRenderer` (from the main entry) exposes `renderFullAST` /
  `renderCodeAST` returning hast `ElementContent[]`, suitable for splicing
  into the existing markdown / asciidoc hast pipeline.
- The browser-side `File` class accepts a Light-DOM `fileContainer` and a
  `hydrate({ fileContainer, prerenderedHTML, file })` call that attaches
  interactivity to the server-emitted HTML. Shadow DOM is only used by the
  optional `web-components.js` wrapper (listed under `sideEffects`).
- License is `Apache-2.0`, already permitted by `src/license-check.ts`.

The Selection Inspector contract (per the `selection-inspector` spec) reads
newline characters from the whole-file `<pre><code>` element's `textContent`
to derive 1-indexed source line numbers. This is the load-bearing constraint
that shapes how the new gutter must be wired.

## Goals / Non-Goals

**Goals:**

- Single code-rendering layer (`@pierre/diffs`) across whole-file source
  view, Markdown fenced blocks, and AsciiDoc listing blocks.
- Server-side rendering of highlighted HTML, matching uatu's existing
  "server emits HTML, browser hydrates" architecture; no client-side flash
  of unhighlighted code.
- Selection Inspector continues to work against the whole-file `<pre>`
  unchanged in behavior — captured line numbers remain correct.
- Light Shiki theme by default, dark theme available, both following uatu's
  existing theme preference plumbing.
- Mermaid interception untouched.
- `highlight.js` and `attachLineNumbers` removed from the codebase.

**Non-Goals:**

- Diff viewing (new sidebar pane, Diff toggle, diff preview): out of scope,
  handled by a follow-on change.
- Streaming highlight (`FileStream`, `CodeToTokenTransformStream`): not
  needed for preview-sized files; whole-file render is fast enough.
- Web-worker pool for highlighting (`@pierre/diffs/worker`): uatu's preview
  is server-rendered and the browser hydrates; a worker pool is overkill at
  this scale.
- Custom Shiki theme: pick from the bundled themes for now; a custom theme
  matched to uatu's aesthetic can come later if needed.
- Changing the Selection Inspector's behavioral contract; we keep
  `textContent`-newline counting as the line-capture mechanism.

## Decisions

### D1. Server-side rendering, not client-only

Use `@pierre/diffs/ssr` (`preloadFile`, `preloadPatchDiff`, etc.) to bake
highlighted HTML on the server and ship it to the browser inline. The client
then calls `new File(options).hydrate({ fileContainer, prerenderedHTML, file })`
to attach interactivity.

**Why over client-only:** uatu's existing rendering model is
"server emits HTML over the SSE-driven channel; client mounts it." Going
client-only would (a) introduce a first-paint flash of unhighlighted code,
(b) defeat the offline-friendly story (no Shiki grammars cached locally yet),
and (c) duplicate Shiki bootstrap state across every browser tab.

**Why over streaming:** preview-sized files don't need progressive token
delivery; whole-file render is fast and simpler to reason about.

### D2. Pre-warm the highlighter at session start

Call `preloadHighlighter` (from `@pierre/diffs`) during watch-session
startup, registering the languages enumerated by `src/file-languages.ts`. The
goal is for the first preview request to find Shiki ready, not paying the
grammar-load cost in the request-response path.

**Why:** Shiki's grammar/theme loads are async and the first call would
otherwise add a few hundred milliseconds to the first preview render. We
already pay startup cost for the watcher, indexer, and terminal; adding
highlighter pre-warm here is a natural fit.

**Alternative considered:** lazy load per request. Rejected because
preview-first-paint is a visible quality bar and the pre-warm cost is one-shot.

### D3. AST splice for Markdown / AsciiDoc fenced blocks; HTML string for whole-file source view

Two integration styles, picked per use site:

- **Whole-file source view** uses `preloadFile` → `prerenderedHTML` string.
  The server stitches that string into the page response; the browser
  hydrates via `File.hydrate(...)`.
- **Fenced / listing blocks inside Markdown / AsciiDoc** use
  `FileRenderer.renderCodeAST(result)` to obtain hast `ElementContent[]`,
  which is spliced directly into the existing hast tree the
  Markdown / AsciiDoc pipelines already produce. The final
  `hast-util-to-html` call serializes the combined tree.

**Why two integrations:** Markdown and AsciiDoc pipelines already operate on
hast nodes (uatu depends on `hast-util-from-html` and `hast-util-sanitize`).
Splicing AST avoids string-parse-stringify round-trips and keeps the
sanitizer's view consistent. The whole-file path doesn't have a pre-existing
hast tree to splice into, so the `prerenderedHTML` string is the right unit
there.

### D4. Adapt the Selection Inspector and copy-to-clipboard to the new DOM contract

Empirical probing of `@pierre/diffs@1.1.21`'s output (both `preloadFile`
prerendered HTML and `FileRenderer`'s `contentAST`) shows the per-line
structure is `<div data-line="N">{token spans}</div>` with NO `\n` characters
between consecutive line elements. The gutter is rendered inside `<code>`
rather than as a sibling. This violates the original assumption that we
could keep counting newlines in `code.textContent`.

We therefore adapt rather than reshape. The Selection Inspector's contract
changes: it walks from the selection's start / end DOM nodes up to the
nearest ancestor carrying `data-line`, and reads that attribute as the line
number. This is **more robust** than newline counting — it doesn't depend on
whitespace, copes with soft-wrap or virtualization, and gives us direct
access to per-line attributes that future features (annotations, expand-
context) can read from. Copy-to-clipboard performs the analogous walk: it
gathers `<div data-line>` children of the source view, joins their
`textContent` with `\n`, and writes that to the clipboard.

The "selection ending at the start of the next line" semantic is preserved
explicitly: if the range's end boundary sits at the leading edge of a line
element (`range.endOffset === 0`), the inspector reports the prior line as
`endLine`. The behavior mirrors the existing newline-counting semantic; only
the implementation changes.

**Why this over the "assemble the `<pre>` ourselves" fallback** (originally
described as a fallback in this section): assembling our own `<pre>` would
strip `<div data-line>` wrappers and lose the per-line attribute trail that
the follow-on diff change wants intact. Adopting `@pierre/diffs`'s DOM as
written keeps uatu aligned with the library's evolution and unblocks future
per-line features (annotations, expand-context, gutter utility) on source
view without further refactor.

### D5. Class name for the whole-file `<pre>`: keep the `uatu-source-pre` distinguisher

The source-view spec requires the whole-file `<pre>` to carry a
distinguishing class so the Selection Inspector can tell it apart from
fenced-block `<pre>` elements inside Markdown / AsciiDoc body content. We
keep the existing `uatu-source-pre` class and apply it on the host
`fileContainer` (or directly on `<pre>` via `File.options.onPostRender`).

**Why:** the class is an external contract: tests, the inspector module, and
documented spec scenarios all reference its existence. Keeping the same
class name avoids a rename ripple while still letting the DOM around it
change.

### D6. Theme strategy: bundled `github-light-default` / `github-dark-default`

Use Shiki's bundled `github-light-default` for light mode and
`github-dark-default` for dark mode. Register both at startup via
`preloadHighlighter`. The renderer's `themeType` is driven by the existing
light/dark preference signal that the rest of the preview already reads.

**Why these themes:** they're aesthetically closest to today's hljs
GitHub-style output, minimizing visual churn for existing users.

**Alternative considered:** custom theme matching uatu's accent palette.
Deferred — picking from bundled themes is cheaper and lets us validate the
overall integration before investing in custom theming.

### D7. Language registration is driven by `src/file-languages.ts`

`src/file-languages.ts` is currently the lookup table from file name to
hljs language identifier. Renaming/reshaping it into a Shiki-friendly map
(`BundledLanguage` identifiers) becomes the single source of truth for which
grammars Shiki preloads.

**Why:** this file already enumerates the languages uatu supports; reusing
it keeps "supported languages" one well-known list, and the migration is
mostly an identifier rename (`typescript`, `python`, `json`, etc. — the
identifiers overlap between hljs and Shiki for the common cases).

Languages not in this map fall back to plain-text rendering — same behavior
as today when hljs has no matching grammar.

### D8. Mermaid interception runs before any highlight pass

The Markdown pipeline's Mermaid handler (in `src/markdown.ts`) already
matches the fenced block's info string and renders Mermaid placeholders
before the highlight pass. The AsciiDoc pipeline does the same for
`[source,mermaid]` and `[mermaid]` blocks. We preserve this ordering — the
highlight pass under `@pierre/diffs` is positioned downstream of Mermaid
detection.

**Why:** Mermaid blocks are diagrams, not code; they should never go through
the highlighter regardless of which highlighter is in use.

### D9. Retirement, not coexistence

`highlight.js` is removed from `package.json` once A1–A6 land. The hljs CSS
rules in `src/styles.css` are removed in the same change. `attachLineNumbers`
is deleted from `src/app.ts`.

**Why:** carrying two highlighters indefinitely costs bundle size and
introduces visual inconsistency between code blocks rendered by different
paths. The whole point of adopting `@pierre/diffs` is unifying the
rendering; partial adoption defeats that.

## Risks / Trade-offs

- **Risk**: `@pierre/diffs` renders the gutter inside `<code>` (contrary to
  the assumption in D4), breaking Selection Inspector line counting.
  → **Mitigation**: A2 includes an explicit verification step before
  proceeding to A3/A4. If the gutter position is wrong, we fall back to
  using `FileRenderer`'s `gutterAST` and `contentAST` separately and
  assembling the `<pre>` ourselves (the library exposes both).

- **Risk**: Bundle size grows enough to hurt initial page load.
  → **Mitigation**: Shiki's grammars are lazy by default; only the
  registered languages get bundled. SSR keeps the first-paint cost
  server-side. Measure bundle size before/after; if it regresses
  unacceptably, narrow the registered language set further.

- **Risk**: Shiki async startup blocks the first preview request.
  → **Mitigation**: D2's pre-warm at session start; gate the HTTP server's
  "ready" state on the highlighter being loaded. The watcher itself doesn't
  depend on the highlighter and can start in parallel.

- **Risk**: AsciiDoc's existing `hljs.*` shim (the regex allowlist in
  `src/asciidoc.ts:121` and the placeholder `<code class="hljs">` emission
  at `src/asciidoc.ts:182`) carries some implicit assumptions that the
  highlight pass runs over its output.
  → **Mitigation**: A4 includes a focused review of the asciidoc render
  path; the new integration calls `FileRenderer.renderCodeAST` on the
  asciidoctor-extracted source text directly, removing the hljs-flavored
  placeholder entirely.

- **Risk**: Visual regression in existing snapshot/e2e tests due to changed
  DOM shape (different class names, different gutter implementation).
  → **Mitigation**: tests assert behavior (line numbers visible,
  copy-to-clipboard yields source without numbers, Inspector captures
  correct ranges) rather than literal HTML structure where possible. The
  proposal flags this; tasks.md includes a step to triage and update
  fixture assertions.

- **Trade-off**: Adopting a beta-channel-adjacent dependency (`@pierre/diffs`
  is on `1.1.21` stable, but the package as a whole is young and the API
  surface is large). We already accepted this trade for `@pierre/trees`
  and the `1.1.x` line has 20+ patch releases, suggesting active
  maintenance.

- **Trade-off**: Two integration styles (AST splice vs HTML string) instead
  of one. The cost is a small amount of duplication in how the renderer is
  invoked from different call sites; the benefit is that each call site uses
  the unit (hast nodes or HTML) that fits its surrounding pipeline.

## Migration Plan

This change is a single coordinated migration shipped together (one PR / one
archive). There is no parallel-running phase: hljs and `@pierre/diffs`
coexist briefly during local development only.

1. Land A1 (Shiki preload + language registration) without changing any
   render path. The new dependency is in `package.json`, but nothing reads
   from it yet. Existing tests should still pass.
2. Land A2 (whole-file source view migration). At this point, source view
   is on `@pierre/diffs`; fenced blocks are still hljs. Cross-validate
   Selection Inspector behavior.
3. Land A3 (Markdown fenced blocks) and A4 (AsciiDoc listing blocks). All
   render paths now go through `@pierre/diffs`.
4. Land A5 (theme wiring) — at this point Shiki themes drive the visual
   output; uatu's existing light/dark mode toggle plumbs through.
5. Land A6 (retire hljs, `attachLineNumbers`, hljs CSS). The codebase no
   longer references `highlight.js`.
6. Land A7 (verification): Mermaid still works; Selection Inspector still
   works; copy-to-clipboard still works; light/dark toggle still works.

If a failure mode appears between steps (e.g. A2's gutter position breaks
the Inspector), the fix is local to that step — the prior steps don't roll
back. The retirement of hljs in A6 is the only one-way door; everything
before it can coexist with hljs.

## Open Questions

- Should we register a custom Shiki theme matched to uatu's accent palette,
  or accept the bundled `github-light-default` / `github-dark-default` as
  the long-term theme? — Deferred (D6).
- For the source view, do we want to opt into `@pierre/diffs`'s gutter
  utility feature (per-line hover affordances) now, or keep the simpler
  "numbers only" gutter and add the utility hooks later? — Default to
  "numbers only" for parity with today; revisit with the diff-view change.
- The follow-on change for diff viewing will need to decide on patch-vs-
  file-pair feed for `preloadPatchDiff` vs `preloadFileDiff`. Not in scope
  here but flagged so the renderer integration doesn't make that decision
  prematurely.
