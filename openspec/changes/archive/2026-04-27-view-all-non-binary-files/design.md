## Context

Today the watcher's notion of "document" is hardcoded to `.md` and `.markdown` everywhere: `walkMarkdownFiles` in `src/server.ts` filters by extension, `isMarkdownPath` is the gating predicate for follow eligibility, the CLI rejects non-Markdown file paths up front, and `renderDocument` always runs the GFM pipeline. Other files exist on disk and can be served via the static-asset fallback when referenced from a README, but they are otherwise invisible to the UI.

The user-facing goal is to make every non-binary file a first-class citizen in the watch session — listed in the tree, viewable in the preview, eligible for follow and pin — while keeping the existing Markdown experience untouched. The render path for non-Markdown files reuses the syntax highlighting already wired into the Markdown pipeline (`highlight.js/lib/common`), so no new highlighting infrastructure is needed.

Two new external signals enter the system: a project's `.gitignore` (read by default) and an optional `.uatuignore` (gitignore syntax, the user's escape hatch). Both layer on top of the existing hardcoded directory denylist (`node_modules`, `.git`, `dist`, etc.) which remains non-negotiable.

## Goals / Non-Goals

**Goals:**

- Sidebar lists every file under each watched root, with binary files visible but non-clickable.
- Non-Markdown text files render in the preview as syntax-highlighted code that visually matches the existing Markdown fenced-code rendering.
- Follow mode, pin, and the on-startup default document all operate on any non-binary file.
- `.uatuignore` (root only, gitignore syntax with `!` negation) lets users filter the indexed set without touching code.
- `.gitignore` is respected by default; `--no-gitignore` opts out for users who want to see everything.
- Big files (≥ 1 MB) render without syntax highlighting to keep the browser responsive.
- Existing Markdown rendering, the static-asset fallback, the live-reload SSE channel, and all current scenarios continue to work unchanged.

**Non-Goals:**

- Per-directory `.uatuignore` nesting. Single file at the watch root only.
- A general `uatu.config.json` for non-ignore settings. Configurable follow rules, port defaults, and similar live in a separate future change.
- Editing files in the browser. Preview is read-only.
- Rich preview for binary types (images inline, PDFs embedded). Binary = listed but disabled, full stop. Images referenced from Markdown still load via the static-asset fallback as today.
- Syntax-highlight language detection beyond the extension map. If an extension isn't mapped, the file renders as plain escaped text — same path the existing "unknown info string" Markdown scenario already takes.

## Decisions

### Decision 1: Two render paths, not one wrap-in-fence pipeline

Non-Markdown files render through a direct call to highlight.js, **not** by wrapping the source in a fenced code block and feeding it back through the Markdown pipeline.

```
   .md / .markdown   ──►  renderMarkdownToHtml(source)              (unchanged)
   any other text    ──►  renderCodeAsHtml(source, language)        (new)
                              │
                              ├── highlightSource(source, language)
                              └── wrap in <pre><code class="hljs language-X">…</code></pre>
   binary            ──►  not rendered; sidebar entry is disabled
```

**Rationale:**

- The wrap-in-fence approach has a real escaping landmine: any source containing a literal triple-backtick (shell scripts that emit Markdown, doc generators, code that quotes Markdown samples) breaks the outer fence. Solving that requires scanning for the longest run of backticks and emitting a longer fence — code we'd have to write anyway.
- Going direct skips the unnecessary micromark + sanitize round-trip for content that can never have Markdown features, and produces identical visual output (same `hljs` class names, same theme).
- `highlightSource` is already a private helper in `src/markdown.ts`. Promoting it to an exported function and adding a thin `renderCodeAsHtml` wrapper is ~10 lines.

**Alternatives considered:**

- Wrap-in-fence ("everything is markdown"). Rejected for the escaping risk and the unnecessary pipeline weight.
- A separate highlighter library. Rejected — `highlight.js/lib/common` is already loaded for Markdown fenced blocks and ships ~37 common languages.

### Decision 2: Extension → language map, mirroring `file-icons.ts`

Language resolution lives in a new module `src/file-languages.ts` (or co-located in `file-icons.ts`) keyed by lowercased extension. A trivially-extensible record: one entry per extension, generic fallback to "no language" (which renders as plain escaped text inside `<pre><code class="hljs">`).

Initial entries cover the obvious common cases: `.ts`/`.tsx` → `typescript`, `.js`/`.jsx` → `javascript`, `.py` → `python`, `.rb` → `ruby`, `.go` → `go`, `.rs` → `rust`, `.java` → `java`, `.kt` → `kotlin`, `.sh`/`.bash` → `bash`, `.zsh` → `bash`, `.yml`/`.yaml` → `yaml`, `.json` → `json`, `.xml` → `xml`, `.html` → `xml`, `.css` → `css`, `.scss` → `scss`, `.toml` → `ini`, `.ini` → `ini`, `.dockerfile`/`Dockerfile` → `dockerfile`, `.sql` → `sql`, `.c`/`.h` → `c`, `.cpp`/`.cc`/`.hpp` → `cpp`. Adding more is one-line PRs.

### Decision 3: Filter resolution order, with first-match wins

```
   ┌────────────────────────────────────────────────────────────────┐
   │  1. Hardcoded directory denylist (node_modules, .git, dist…)   │
   │     Always wins. Not user-overridable.                         │
   ├────────────────────────────────────────────────────────────────┤
   │  2. .uatuignore (gitignore syntax, supports ! negation)        │
   │     Read once at watch start from the watch root.              │
   ├────────────────────────────────────────────────────────────────┤
   │  3. .gitignore (gitignore syntax)                              │
   │     Read by default. Skipped when --no-gitignore is passed.    │
   ├────────────────────────────────────────────────────────────────┤
   │  4. Binary detection                                           │
   │     Extension hints first. Unknown extensions sniff first 8 KB.│
   │     Binary files PASS the filter — they appear in the tree as  │
   │     disabled entries.                                          │
   └────────────────────────────────────────────────────────────────┘
```

The first three layers compose into a single matcher (using the `ignore` npm package). The matcher is wired into both `walkAllFiles` (replacing `walkMarkdownFiles`) and chokidar's `ignored` option, so files that the indexer skips also stop firing watcher events. Binary detection runs after the matcher accepts a file, and tags it `kind: "binary"` rather than excluding it from the tree.

`.uatuignore` ordering before `.gitignore` lets a user un-ignore something that `.gitignore` excludes (e.g. `!CHANGELOG.generated.md`), since `ignore` follows gitignore semantics where later patterns override earlier ones within the same source — but across our two sources, we feed `.uatuignore` patterns *after* `.gitignore` into the matcher so `.uatuignore`'s negations and additions take precedence. (Implementation note: confirm at coding time whether this is one matcher with concatenated patterns or two matchers consulted in order; `ignore` supports both.)

### Decision 4: Single root-only `.uatuignore`

`.uatuignore` is read once at session start, from the watch root if the root is a directory, or skipped entirely if the root is a single file (since the user named the file explicitly). Subdirectory `.uatuignore` files are ignored.

**Rationale:** simplest thing that works. Per-directory nesting is a known git pattern but adds noticeable complexity (matcher must walk up the tree per file, watcher events must reload nested files, edge cases with nested negation). No user has asked for it. Easy to add later if a real use case shows up.

When multiple watch roots are supplied (`uatu watch docs notes`), each root reads its own `.uatuignore` and `.gitignore` independently. Patterns are root-relative.

### Decision 5: `DocumentMeta` gains a `kind` discriminator

```ts
type DocumentKind = "markdown" | "text" | "binary";

type DocumentMeta = {
  id: string;
  name: string;
  relativePath: string;
  mtimeMs: number;
  rootId: string;
  kind: DocumentKind;
};
```

Three kinds, not two, because the render dispatch needs to distinguish Markdown (full GFM pipeline) from plain text (highlight.js code path). Binary files carry `kind: "binary"` so the sidebar renderer can disable the row.

The `kind` is computed once at scan time in `walkAllFiles` and refreshed on file events (an `.md` could be renamed to `.txt`, etc.). It's the only new persistent piece of state needed.

### Decision 6: Binary detection — extension hints first, NUL-byte sniff fallback

Three-layer detection:

1. **Known-text extensions** (everything in the language map, plus a small extra list: `.txt`, `.log`, `.csv`, `.tsv`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.env`, files with no extension that match common text names like `Makefile`, `Dockerfile`, `LICENSE`, `README`). Treated as text without reading.
2. **Known-binary extensions** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.ico`, `.pdf`, `.zip`, `.gz`, `.tar`, `.exe`, `.dll`, `.so`, `.dylib`, `.wasm`, `.woff`, `.woff2`, `.ttf`, `.otf`, `.mp3`, `.mp4`, `.mov`, `.wav`, `.svg` — treat SVG as binary for preview purposes since it's already served via the static fallback). Tagged binary without reading.
3. **Unknown extensions**: read first 8 KB. Binary if the buffer contains a NUL byte, or if more than 30% of bytes are outside the printable ASCII range (excluding common whitespace `\t\n\r`). Otherwise treat as text with `language: undefined`.

The sniff runs at scan time, not at render time, so the cost is paid up front and the result is cached on `DocumentMeta`. For very large unknown-extension files the sniff still reads only the first 8 KB.

### Decision 7: 1 MB syntax-highlight cutoff

Files at or above 1 MB render as plain escaped text inside `<pre><code class="hljs">` — no highlight.js call, no syntax tokenization. Markdown files larger than 1 MB still render through the GFM pipeline (the markdown engine itself is fast; it's the highlighter on a single huge code block that dominates).

The threshold is a constant in `src/markdown.ts` (named `SYNTAX_HIGHLIGHT_BYTES_LIMIT` or similar) and not user-configurable in this change.

### Decision 8: Use the `ignore` npm package for gitignore semantics

`ignore` (https://www.npmjs.com/package/ignore) implements full gitignore syntax including negation, directory anchors (`/foo`), trailing slashes, and the various edge cases. Zero runtime dependencies, ~20 kB unpacked, MIT-licensed, widely used (by Prettier, ESLint, etc.). Reimplementing gitignore matching from scratch is a known footgun.

### Decision 9: Default document selection — most recently modified non-binary file

`defaultDocumentId` already sorts by `mtimeMs` then `relativePath`. We only widen the input set: any non-binary `DocumentMeta` is eligible. Binary files are excluded from the default selection (a binary file can't be previewed, so picking it as the default would land the user on a disabled tree row with an empty preview).

### Decision 10: Follow eligibility — any non-binary file change

`createWatchSession` currently filters `changedId` to Markdown paths only (`isMarkdownPath(absolutePath) && eventName !== "unlink"`). The new check is "is this path indexed and not binary?" The watcher already only emits events for paths that pass the ignore matcher, so the in-session check simplifies to "look up the path in the current `roots` and confirm `kind !== "binary"`."

This widens the previously narrow follow set considerably. The user explicitly accepted the trade-off: `.uatuignore` is the immediate escape hatch for noisy text files (`bun.lock`, `*.min.js`, `package-lock.json`), and configurable follow rules are a separate future change.

## Risks / Trade-offs

- **Lockfile churn yanks the preview.** A `bun install` rewrites `bun.lock`, follow mode jumps to it, the user loses their place. → Mitigation: ship a sample `.uatuignore` snippet in the README documenting common patterns (`*.lock`, `package-lock.json`, `*.min.js`, `dist/`). The default `.gitignore`-respect already filters most of this for projects that have one.
- **`.gitignore` excludes things the user wants to see.** A generated changelog committed for review, a debug build's output. → Mitigation: `.uatuignore` supports `!negation`, and `--no-gitignore` is the nuclear option.
- **Binary sniff false positives/negatives.** A UTF-16 text file (rare) trips the NUL-byte heuristic and gets tagged binary. A binary blob with no NUL bytes in the first 8 KB might pass. → Mitigation: the extension hint layers catch the common cases. The 8 KB sniff is conservative — we'd rather mark a weird-encoding text file as binary (user can still see it in the tree) than crash the preview trying to render a binary blob as code.
- **Highlighting cost on first render.** Opening a 500 KB JSON file runs highlight.js on the whole content. Slower than Markdown but bounded. → Mitigation: 1 MB cutoff. If complaints surface for files between 100 KB and 1 MB, lower the cutoff or add a UI hint.
- **Sidebar visual noise.** Whole repos have hundreds of files. The tree could become unwieldy. → Mitigation: `.gitignore` respect cuts most build/dependency noise. `.uatuignore` is the user's tuning knob. Out of scope for this change: search/filter in the sidebar.
- **The existing `ignoredNames` denylist overlaps with what `.gitignore` already excludes.** Most `.gitignore` files exclude `node_modules/` and `dist/` already. → Acceptable: the hardcoded list is a safety net for projects without a `.gitignore`, or when `--no-gitignore` is used. Two layers excluding the same path is harmless.
- **"Pin" UX changes meaning slightly.** Pin used to imply "lock to this Markdown doc"; now it pins any file. The label "Pinned" is generic enough to absorb the change. → No mitigation needed; the affordance already reads correctly for non-Markdown.
- **Existing E2E tests assume Markdown-only sidebars.** They may need updates to assert that adjacent non-Markdown files now appear. → Mitigation: budget for E2E test updates in the implementation tasks. New tests cover both the new behavior and that existing scenarios still pass.

## Migration Plan

This is a behavior change in a tool with no persistent server-side state and no external integrations. The migration is the deploy: cut a release, users `bun install`, run `uatu watch`, and the new behavior is live. No data migration, no rollback procedure beyond reverting the release.

For users who want the old Markdown-only behavior temporarily, a `.uatuignore` containing `*` followed by `!*.md` and `!*.markdown` would approximate it, though that's not a goal we optimize for.

## Open Questions

- Do we want a tiny visual affordance in the tree to distinguish "viewable code" from "viewable Markdown" rows beyond the file icon? Probably not — the icon already differentiates extensions. Defer to UX feedback after first release.
- Should `--no-gitignore` have a positive form (`--gitignore` to force it on)? Symmetrical CLIs are nice but YAGNI. Skip unless someone asks.
