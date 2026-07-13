## 1. Server: compute file facts

- [x] 1.1 Add `FileFacts` type to `src/shared/types.ts` and extend `RenderedDocument` in `src/server/render-dispatch.ts` with an optional `fileFacts` field
- [x] 1.2 Create `src/document/file-facts.ts`: line count + byte size + mtime from the already-read source / `fs.stat`, plus `git log -1` and `git status --porcelain` for the path via `safeGit`, with escape-before-serialize and degrade-to-non-git on any failure
- [x] 1.3 Colocate `src/document/file-facts.test.ts`: git root (clean, dirty, never-committed), non-git root, git-failure degradation, HTML escaping of author names
- [x] 1.4 Wire facts collection into `renderDocument` (concurrent with rendering via `Promise.all`) and confirm `/api/document` payloads carry `fileFacts` for both `view=rendered` and `view=source`

## 2. Client: facts strip in Source and Diff views

- [x] 2.1 Add the strip slot to `src/index.html` below the preview title/path/type row, with styles in `src/styles.css` (single spare line, collapses when hidden, added/removed styling for diff counts)
- [x] 2.2 Create `src/preview/file-facts-strip.ts`: render Source variant (author · freshness · sha · lines · size), Diff variant (vs base · +N −N · author · sha) composed from `fileFacts` plus the client-side repository snapshot, and the non-git variant (lines · size · mtime); include relative-time formatting and the freshness/uncommitted segment logic
- [x] 2.3 Colocate `src/preview/file-facts-strip.test.ts`: variant selection per view, non-git degradation, never-committed state, dirty vs clean freshness segment
- [x] 2.4 Wire visibility: `mount.ts` renders the strip after each document mount, `view-mode.ts` toggles it on view flips without refetch, and commit / review-score / empty previews hide it

## 3. Client: on-disk change signal

- [x] 3.1 Add `signalActiveDocumentUpdated()` to the strip/header module: trailing-edge timer that sets `.is-updated` on the freshness segment (Source/Diff) and reveals a transient "Updated" chip in the header (Rendered); clear on navigation and non-document previews
- [x] 3.2 Call it from the `shouldReload` path in `src/shell/events.ts`
- [x] 3.3 Add pulse CSS with a `prefers-reduced-motion` static fallback
- [x] 3.4 Unit-test the trailing-edge behavior (rapid events keep the signal lit, settles after quiet, navigation clears)

## 4. E2E and verification

- [x] 4.1 Add `tests/e2e/file-facts.e2e.ts`: strip visible in Source view with git facts, hidden in Rendered view, Diff variant shows base + counts, on-disk edit flips freshness to uncommitted and fires the signal, Rendered view shows the transient Updated chip
- [x] 4.2 Run `bun test`, `bun test:e2e`, and `bun run dev` against `testdata/watch-docs` to eyeball the strip in all three views and under rapid file writes
