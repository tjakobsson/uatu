# Design — fix cross-document links

## Why an Asciidoctor attribute, not a post-pass

Asciidoctor exposes the cross-document file-extension behavior through the `relfilesuffix` document attribute. Setting it to `.adoc` (instead of the default empty value, which falls back to `outfilesuffix=.html`) suppresses the rewrite at the source — the rendered HTML carries `href="other.adoc"` directly. The alternative is to post-process the HTML and replace `.html` with `.adoc` in anchor `href`s, but that is fragile (what about an author who wrote `link:notes.html[]` deliberately?) and lossy (we would have to distinguish "Asciidoctor synthesized this" from "the author wrote it"). The attribute is the documented, surgical knob — use it.

The choice of `.adoc` (rather than the empty string) keeps `.asciidoc`-suffixed targets working too: with empty `relfilesuffix` Asciidoctor strips the recognized doc extension and appends nothing, producing `href="other"` which is also broken. With `relfilesuffix=.adoc`, `xref:other.asciidoc[…]` is left untouched (Asciidoctor only strips its own canonical `.adoc`), so both extensions survive end-to-end.

## Why intercept clicks instead of routing through the static fallback

Two routes exist for an in-preview link click: (a) let the browser navigate to the URL and have the server's static-file fallback serve the raw bytes, or (b) intercept the click in the SPA and switch the preview through `loadDocument`.

Route (a) bypasses the renderer entirely. For a `.adoc` file, Chromium has no registered text MIME and prompts a download; for `.md`, the user sees raw text instead of the GitHub-styled preview. Route (b) keeps the rendering pipeline in the loop, preserves SSE-driven live reload, keeps the sidebar selection in sync, and gives us a single place to evolve cross-doc behavior (e.g. add `pushState` later for shareable per-doc URLs). Route (b) is the only one that meets the user's actual expectation: "click a link, see the linked document rendered."

The interception is opt-in by URL shape: only when `anchor.href` resolves (against the per-document `<base href>`) to a workspace-relative path that matches a known non-binary document. Everything else falls through to the browser's default behavior — including binary docs (so a hand-authored link to a PDF still triggers the browser's native fetch/download), modifier-clicks, `target="_blank"`, external origins, and non-http(s) protocols.

## Why the in-page anchor handler stays separate

The existing `initInPageAnchorHandler` short-circuits as soon as it sees an `href` that does NOT start with `#`. It is concerned with same-document fragment scrolling (TOC entries, `<<id>>` xrefs to local anchors). The new cross-document handler short-circuits as soon as it sees an `href` that DOES start with `#`. The two are complementary, run as two `addEventListener` registrations on the same element, and never overlap. Combining them into one handler would intermix two unrelated state machines — easier to keep them apart.

## Why `user-content-` prefix mirroring lives in both handlers

Both handlers need to map an author-written fragment (`#section`) onto sanitize's `user-content-section` id. The in-page handler does it directly because it operates within the currently rendered document. The cross-document handler does it after `loadDocument` resolves, against the freshly-rendered new document. The logic is small enough (one prefix, one selector retry) that duplicating it across the two handlers is cheaper than extracting a shared module — and it keeps each handler self-contained.

## Why the fixture lives under `testdata/watch-docs/`, not under E2E extras

The earlier draft of the E2E tests used the `__e2e/reset` extras mechanism to inject `links-index.{adoc,md}` per-test. That keeps the baseline file count constant but makes the fixture invisible when a developer runs `bun run src/cli.ts watch testdata/watch-docs` to manually exercise the feature. Permanent fixtures double as living examples in the watch demo and as inputs for the E2E tests. The cost is updating the file-count assertions across the existing E2E suite (4 → 7); that's a one-time, mechanical edit.

## Trade-offs accepted

- **No URL change on cross-doc navigation.** The page URL pathname stays at `/` even when the previewed document changes. This matches the sidebar click path's existing behavior, so the cross-doc handler doesn't introduce a new mental model. A future change can add `pushState` so deep-links work; bringing it in here would mean teaching the SSE/follow-mode/scope code paths about URL state at the same time.
- **Modifier-clicks preserved.** Cmd/Ctrl-click opens the linked URL in a new tab, which goes through the static-file fallback (raw bytes). That's the expected platform behavior and keeps the "open in new tab" affordance working at all; users who actually want a rendered preview in a new tab need a separate workflow we don't ship today.
- **Mixed-format cross-doc references** (e.g. an `.adoc` file linking to an `.md` file) work because the handler resolves any non-binary document path, not just same-format. This is incidental and small; we keep it.
