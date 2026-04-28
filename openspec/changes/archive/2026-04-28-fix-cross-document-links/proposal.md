## Why

Cross-document links between rendered documents are broken in two related ways:

1. **AsciiDoc URL rewriting.** Asciidoctor's default rewrites `xref:other.adoc[…]` (and the `<<other.adoc#section,…>>` shorthand) to `href="other.html"`. The existing requirement *Serve adjacent files from watched roots as static content* already says the rendered preview HTML "MUST preserve the author's original `src` and `href` URLs verbatim (no URL rewriting)" — the renderer was simply violating it. A user clicking such a link hits a `.html` URL that does not exist and gets a 404.
2. **Click-time navigation.** Even with the URL preserved, a default click on `<a href="other.adoc">` triggers a full browser navigation. The server's static-file fallback then serves the raw `.adoc`/`.md` bytes — Chromium has no recognized text MIME for `.adoc`, so it offers a download; for `.md` the user gets raw plain text. In both cases the preview pipeline is bypassed entirely.

Fixing only (1) leaves the user in the same place practically — the link no longer 404s, but it still escapes the SPA. Fixing only (2) keeps the renderer wrong. Both ship together in this change.

## What Changes

- Pass `relfilesuffix=".adoc"` to Asciidoctor so `xref:other.adoc[…]` and `<<other.adoc#section,…>>` keep their `.adoc` extension end-to-end. The `link:` macro already preserves its target — only `xref` shapes were affected.
- Add a click handler in the browser UI that intercepts anchor clicks in the preview pane. When the resolved URL maps to a known non-binary document under any watched root, the click loads that document through the in-app `loadDocument` path instead of letting the browser perform a full navigation. A fragment in the URL (e.g. `other.adoc#section`) scrolls the matching element into view after load, mirroring sanitize's `user-content-` id prefix the way the existing in-page anchor handler does.
- Skip interception for: modifier-clicks (Cmd/Ctrl/Shift/Alt), `target` other than `_self`, fragment-only hrefs (already handled by the in-page handler), external origins, non-`http(s):` protocols (`mailto:`, `javascript:`), binary documents, and paths that don't resolve to any document in the current state.
- Add permanent demo fixtures under `testdata/watch-docs/` so the cross-document link path can be exercised manually:
  - `links-demo.md` — links to `README.md` and `guides/setup.md`.
  - `links-demo.adoc` — `xref:`, `<<>>` shorthand, and `link:` macro to the cheat sheet, plus `xref:guides/notes.adoc[…]` for the subdirectory case.
  - `guides/notes.adoc` — small AsciiDoc target.
- Add `bin` to `package.json` so `bun link` exposes `uatu` globally, and tighten the README's Features section + add an "Install globally with `bun link`" section.

Out of scope:

- Resolving in-app navigation through `history.pushState` so the page URL reflects the current document. (Today the SPA shell URL is unchanged across document switches; this matches the sidebar click path's existing behavior. A separate change can address shareable per-document URLs.)
- Heuristics for renaming the linked file's extension when the author wrote a stale extension (e.g. `xref:other.md[…]` from inside an `.adoc` file). Cross-format mixed extensions go through the static fallback unchanged.

## Capabilities

### New Capabilities

(none — cross-document navigation belongs inside the existing `document-watch-browser` capability alongside Markdown and AsciiDoc rendering and the static-file fallback.)

### Modified Capabilities

- `document-watch-browser`:
  - **Adds** a new requirement *Navigate cross-document anchor clicks inside the preview* describing the SPA click-interception behavior.
  - **Modifies** the *Render AsciiDoc in light mode* requirement to clarify that cross-document `xref` shapes MUST preserve the original file extension in the rendered `href` (no `.adoc` → `.html` rewrite). The existing in-document `<<id>>` clause is retained verbatim.

## Impact

- **Code**:
  - `src/asciidoc.ts` — pass `relfilesuffix: ".adoc"` to `asciidoctor.convert`.
  - `src/app.ts` — new `initCrossDocAnchorHandler` plus a small `findDocumentByRelativePath` helper and a `scrollToFragment` helper that mirrors the in-page anchor handler's `user-content-` prefix logic.
  - `package.json` — `"bin": { "uatu": "./src/cli.ts" }` for `bun link` global install.
  - `README.md` — densified Features section and a new install section.
  - `testdata/watch-docs/{links-demo.md, links-demo.adoc, guides/notes.adoc}` — new permanent fixtures.
- **Tests**: 8 new unit tests covering AsciiDoc xref preservation across `xref:`, `<<>>` shorthand, `link:`, fragments, subdirectories, `.asciidoc` extension, and the bare in-doc `xref:id[]` case. 1 new Markdown unit test locking in the existing pass-through. 5 new Playwright E2E tests covering href shape, in-app SPA navigation for both formats, the subdirectory case, and sidebar selection following the navigation. Existing E2E file-count assertions updated from 4 → 7 baseline (and downstream extras tests adjusted accordingly).
- **Spec**: one ADDED requirement, one MODIFIED requirement, both in `openspec/specs/document-watch-browser/spec.md`. No changes to `repository-workflows`.
- **Validation commands**: `bun test`, `bun run check:licenses`, `bun run build`, `bun run test:e2e` continue to be the gate. All existing tests pass; the new tests cover the regression and the SPA navigation behavior.
