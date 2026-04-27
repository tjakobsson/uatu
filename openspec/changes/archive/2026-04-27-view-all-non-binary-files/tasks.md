## 1. Dependencies and types

- [x] 1.1 Add `ignore` to `package.json` dependencies and run `bun install` to update `bun.lock`.
- [x] 1.2 Extend `DocumentMeta` in `src/shared.ts` with a `kind: "markdown" | "text" | "binary"` field.
- [x] 1.3 Update `flattenDocuments`, `hasDocument`, `defaultDocumentId`, `nextSelectedDocumentId`, and `buildTreeNodes` in `src/shared.ts` to honor `kind` (default selection skips binary; tree retains binary entries; follow eligibility excludes binary).
- [x] 1.4 Add `src/shared.test.ts` cases for the new `kind`-aware behavior of `defaultDocumentId` and `nextSelectedDocumentId`.

## 2. File classification (text vs. binary, language map)

- [x] 2.1 Create `src/file-languages.ts` with an extension → highlight.js-language map (initial entries: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.rb`, `.go`, `.rs`, `.java`, `.kt`, `.sh`, `.bash`, `.zsh`, `.yml`, `.yaml`, `.json`, `.xml`, `.html`, `.css`, `.scss`, `.toml`, `.ini`, `.sql`, `.c`, `.h`, `.cpp`, `.cc`, `.hpp`, `Dockerfile`).
- [x] 2.2 Export `languageForName(name: string): string | undefined` from `src/file-languages.ts`.
- [x] 2.3 Create `src/file-classify.ts` exporting `classifyFile(absolutePath: string, name: string): Promise<DocumentKind>` that uses: known-text extensions → `"text"`/`"markdown"`; known-binary extensions → `"binary"`; unknown → read first 8 KB, classify as `"binary"` if NUL byte present or non-printable byte ratio (excluding `\t\n\r`) exceeds 30 %, else `"text"`.
- [x] 2.4 Add unit tests `src/file-classify.test.ts` covering: known-text extension, known-binary extension, NUL-byte sniff, high non-printable ratio sniff, ASCII Makefile (no extension), small UTF-8 text, empty file.

## 3. Ignore engine

- [x] 3.1 Create `src/ignore-engine.ts` exporting `loadIgnoreMatcher({ rootPath, respectGitignore }): Promise<IgnoreMatcher>` that reads `.uatuignore` and (when `respectGitignore`) `.gitignore` from `rootPath` and returns a matcher built from `ignore`.
- [x] 3.2 Order patterns so `.uatuignore` takes precedence over `.gitignore` (later patterns override earlier ones inside `ignore`'s engine; verify with a test case for an `.uatuignore` `!negation` overriding a `.gitignore` exclude).
- [x] 3.3 Expose `IgnoreMatcher.shouldIgnore(relativePath: string, isDirectory: boolean): boolean` and `IgnoreMatcher.toChokidarIgnored(): (path: string) => boolean` for wiring into chokidar.
- [x] 3.4 Skip loading `.uatuignore` for single-file watch roots (per the spec scenario).
- [x] 3.5 Add `src/ignore-engine.test.ts` covering: `.uatuignore` only, `.gitignore` only, both with `.uatuignore` negation overriding `.gitignore`, `--no-gitignore` skip, missing files (no error).

## 4. Walker rewrite

- [x] 4.1 Rename `walkMarkdownFiles` → `walkAllFiles` in `src/server.ts`.
- [x] 4.2 In `walkAllFiles`, after the hardcoded directory denylist (`shouldIgnoreEntry`), consult the ignore matcher; if accepted and a file, call `classifyFile` and emit a `DocumentMeta` with `kind` set.
- [x] 4.3 Update `scanRoots` to thread the per-root `IgnoreMatcher` through (each watched root reads its own `.uatuignore`/`.gitignore`).
- [x] 4.4 Update `resolveWatchRoots` to accept any non-binary file path (use `classifyFile` to reject binary file paths with a clear error). Replace the `isMarkdownPath` check at the single-file branch.

## 5. Watcher integration

- [x] 5.1 Pass `ignored` to `chokidar.watch` using `IgnoreMatcher.toChokidarIgnored()` so excluded paths never fire events.
- [x] 5.2 In `createWatchSession`'s `watcher.on("all", ...)` handler, replace `isMarkdownPath(...) && eventName !== "unlink"` with a `kind`-aware check: a path is a follow-eligible change when its `DocumentMeta` exists in the current `roots` and `kind !== "binary"`.
- [x] 5.3 On rename / modify events, re-run `classifyFile` so a file crossing the binary boundary updates its `kind`.
- [x] 5.4 Update `fingerprintRoots` to include `kind` so the fingerprint changes when classification changes.

## 6. Render path for non-Markdown

- [x] 6.1 Export `highlightSource(source: string, language: string | undefined)` from `src/markdown.ts` (currently a private helper).
- [x] 6.2 Add `renderCodeAsHtml(source: string, language: string | undefined): string` that wraps `highlightSource` output in `<pre><code class="hljs language-X">…</code></pre>` (omit the `language-X` suffix when language is undefined). For source ≥ 1 MB, skip highlighting and emit `<pre><code class="hljs">{escapedSource}</code></pre>`.
- [x] 6.3 Define `SYNTAX_HIGHLIGHT_BYTES_LIMIT = 1_048_576` as a module constant in `src/markdown.ts`.
- [x] 6.4 Update `renderDocument` in `src/server.ts` to dispatch on `DocumentMeta.kind`: `"markdown"` → `renderMarkdownToHtml`; `"text"` → `renderCodeAsHtml(source, languageForName(name))`. Binary should never reach `renderDocument` (the API rejects it earlier — add an explicit guard returning a 4xx-equivalent error).
- [x] 6.5 Add `src/markdown.test.ts` cases for `renderCodeAsHtml`: known language emits `language-X`; unknown language emits no `language-` class; ≥ 1 MB source bypasses highlighting; HTML in the source is escaped.

## 7. CLI flag

- [x] 7.1 In `parseCommand` (`src/server.ts`), parse `--no-gitignore` and add `respectGitignore: boolean` to `WatchOptions`.
- [x] 7.2 Update `usageText` to document `--no-gitignore`.
- [x] 7.3 Thread `respectGitignore` through to `loadIgnoreMatcher`.
- [x] 7.4 Add `src/server.test.ts` cases for: `--no-gitignore` flag parses; default is `true`; flag is forwarded to the matcher loader.

## 8. UI / sidebar

- [x] 8.1 Update `src/file-icons.ts` to add icons for the most common new extensions and ensure the generic fallback is used for unmapped types.
- [x] 8.2 In `src/app.ts`'s `renderNodes`, render binary leaves as a non-clickable element (e.g. a `<span class="tree-doc-disabled">` with the icon and label) rather than a `<button>`.
- [x] 8.3 Add styling for `.tree-doc-disabled` in `src/styles.css` (muted text color, default cursor, no hover background).
- [x] 8.4 Confirm the click handler in `src/app.ts` no longer responds to binary entries (it already keys off `button[data-document-id]`, so this should be free — verify with a test).
- [x] 8.5 Update the `tree-empty` message wording to drop the "Markdown" assumption ("No supported documents …" remains accurate).

## 9. Server endpoint hardening

- [x] 9.1 In the `/api/document?id=…` handler, look up `DocumentMeta` by id and reject with 404 (or 415) if `kind === "binary"` — the static-asset fallback covers raw binary bytes via the file's URL.
- [x] 9.2 Add `src/server.test.ts` coverage for binary-id rejection and for the text-file render dispatch.

## 10. End-to-end coverage

- [x] 10.1 Add a Playwright test asserting a non-Markdown text file appears in the tree and renders as syntax-highlighted code on selection.
- [x] 10.2 Add a Playwright test asserting a binary file (e.g. a small `.png` from `testdata/`) appears in the tree as a non-clickable entry.
- [x] 10.3 Add a Playwright test asserting a `.uatuignore` pattern hides a file from the tree (use a temp fixture).
- [x] 10.4 Add a Playwright test asserting `--no-gitignore` exposes a file that `.gitignore` would have excluded.
- [x] 10.5 Add a Playwright test asserting follow mode switches the preview when a non-Markdown file changes.
- [x] 10.6 Verify existing E2E tests still pass with the widened tree (update assertions that previously asserted "only Markdown files visible" to the new model).

> Note: Playwright tests are committed but were not executed in the implementation sandbox because the Chromium download CDN is not on the network allowlist. Run `bun run test:e2e` locally to verify.

## 11. Documentation

- [x] 11.1 Update `README.md`: widened watch model, `.uatuignore` (with a sample snippet showing `*.lock`, `*.min.js`, `dist/`, and a `!` negation), `.gitignore` respect, `--no-gitignore` flag, the 1 MB highlight cutoff.
- [x] 11.2 Update `CLAUDE.md` only if its agent guidance contradicts the new behavior — otherwise skip. _(Skipped — `CLAUDE.md` is generic project boilerplate; no contradiction with new behavior.)_

## 12. Final validation

- [x] 12.1 Run `bun test`, `bun run check:licenses` (verify `ignore` package's MIT license is acceptable), `bun run build`, and `bun run test:e2e`. All must pass. _(`bun test`: 71 pass, 0 fail. `check:licenses`: 207 packages audited. `build`: succeeds. `test:e2e`: not executed in implementation sandbox — Playwright Chromium download is not on the network allowlist; run locally.)_
- [x] 12.2 Run `tsc` to confirm no new type errors. _(Confirmed: only pre-existing tsc errors remain — Bun-style `with { type: "file" }` imports and DOM nullability that pre-date this change.)_
- [x] 12.3 Run `openspec validate view-all-non-binary-files` and confirm the change is valid.
- [x] 12.4 Manual smoke test: `./dist/uatu watch .` against this repo and confirm that non-Markdown source files render with highlighting, binary files appear disabled, `.gitignore` is respected, and `.uatuignore` patterns filter as expected. _(Smoke-tested: 92 docs indexed across `markdown`, `text`, `binary` kinds; a text doc renders as `<pre><code class="hljs">…</code></pre>`; a binary doc id returns HTTP 415 from `/api/document`.)_

## 13. UI follow-up refinements (post-review)

User feedback after first run surfaced five UI gaps. Bundled into this change since they're all natural follow-throughs of the widened model.

- [x] 13.1 Sidebar counter: rename `"X docs"` → `"X files"`, surface binary subcount (`· Y binary`) and matcher-filtered hidden subcount (`· Z hidden`). Hidden count tracks `.uatuignore` and `.gitignore` rejections in the walker; hardcoded directory denylist hits do NOT count (those are infrastructure, not user choices).
- [x] 13.2 Move the connection indicator out of the sidebar (`.sidebar-meta`) and into the preview toolbar so it stays visible when the sidebar is collapsed. Updated CSS to fit the chip-rail style.
- [x] 13.3 Add a file-type chip to the preview header next to the path, populated from a new `kind` + `language` field on the rendered document payload. `markdown` files show "markdown"; non-Markdown text shows the highlight.js language label (e.g. `yaml`, `python`); unmapped extensions show `text`.
- [x] 13.4 Attach a copy-to-clipboard control to every `<pre><code>` block (Markdown fenced AND non-Markdown code render). Hover-revealed (always visible on touch); standard "Copy" → "Copied!" microinteraction. Mermaid blocks (rendered as inline SVG) do NOT receive a button.
- [x] 13.5 Spec deltas: added `Display sidebar file count breakdown`, `Show the active file's type in the preview header`, `Provide a copy-to-clipboard control on every code block`; modified `Animate the live connection indicator` to require placement outside the collapsible sidebar. Plus unit and Playwright coverage for each.
- [x] 13.6 Line numbers on non-Markdown code views: gutter `<span class="line-numbers">` inserted as a sibling of `<code>` so `code.textContent` (used by copy-to-clipboard) excludes them automatically. Markdown fenced code blocks do not get line numbers (GitHub-style behavior). Spec delta added; Playwright coverage asserts the gutter renders with the right values, fenced blocks stay clean, and the clipboard excludes line numbers.
- [x] 13.7 Title extraction bug fix: previously `extractTitle` regex-matched `^#\s+(.+)$` against raw Markdown source, so a `# Lockfiles` line inside a fenced code block would become the document title. Switched to scanning the rendered HTML for the first `<h1>` (still works for Markdown `# Title`, also picks up GitHub-style `<h1 align="center">` hero headings). Three regression tests added.
- [x] 13.8 Follow toggle catch-up: clicking Follow now immediately switches the active preview to the most recently modified non-binary file, instead of waiting for the next change event. Spec scenario `Enabling follow jumps to the latest modified file` added; E2E test covers it.
- [x] 13.9 Last-modified labels in the sidebar tree: every file leaf AND every directory shows a compact relative-time label (`now`, `5s`, `12m`, `2h`, `3d`, `4w`, `6mo`). Directory labels reflect the newest descendant file's mtime — bubbled up bottom-up in `sortTreeNodes`. A 1-second client tick keeps the labels live (with a no-op-write skip when the formatted value hasn't changed, so the cost stays trivial regardless of repo size). Spec requirement `Show last-modified time on each tree row` added; unit test for the bubble-up; Playwright tests for the labels' presence and live ticking.
