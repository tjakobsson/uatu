## Context

uatu previews documents in three views: Rendered (markdown/asciidoc pipelines), Source (verbatim `<pre>`), and Diff. Rendered view already frames documents with the frontmatter metadata card (`src/preview/metadata-card.ts`) — author-*declared* metadata. Source and Diff views have no framing at all: nothing tells the reviewer who last touched the file, when, or how big it is. Separately, when the active file changes on disk, `src/shell/events.ts` silently reloads the preview in place (follow-mode Rule D) with no visual acknowledgment.

Relevant existing plumbing:

- `renderDocument(roots, documentId, {view})` in `src/server/render-dispatch.ts` reads the full source per render and returns the `RenderedDocument` payload served by `/api/document?id=&view=`.
- `safeGit(cwd, args)` in `src/document/git-base-ref.ts` is the sanctioned git-subprocess helper (re-exported via `src/review/load.ts`).
- Per-file `additions`/`deletions` against the compare target already reach the client in the repository review snapshot (`src/shared/types.ts`), and `baseRef` is on the diff payload.
- The client caches payloads per view in `src/preview/mount.ts`; Diff re-renders from cached payloads.
- The SSE `state` handler in `src/shell/events.ts` computes `shouldReload` when the changed file is the active one — the exact hook point for the change signal.

## Goals / Non-Goals

**Goals:**

- A facts strip framing Source and Diff views: git last-commit facts, freshness/uncommitted state, line count, byte size (Source); base ref + additions/deletions + last-commit facts (Diff).
- Graceful degradation for non-git roots and never-committed files.
- A calm, view-appropriate signal when the active document live-reloads.

**Non-Goals:**

- Per-file history navigation (a later change can link the SHA to the existing commit preview).
- Freeze-while-reading / deferred reload — the stale-hint machinery stays dormant.
- Any change to Rendered view's metadata card or to follow-mode Rules A–D.
- Word counts, reading time, or other prose metrics.

## Decisions

### 1. Facts computed server-side in `renderDocument`, attached to every payload

The server already reads the file to render it, so line count is a newline count on the in-hand source and byte size is `Buffer.byteLength` (or one `fs.stat`) — effectively free. Git facts are two `safeGit` calls against the document's root: `git log -1 --format=%an%x09%aI%x09%h%x09%s -- <path>` and `git status --porcelain -- <path>`. Facts attach to `RenderedDocument` as an optional `fileFacts` field regardless of the requested view.

*Why not client-side or view-conditional?* The client has no filesystem/git access, and making the payload shape depend on the view would fight the per-view payload cache in `mount.ts` (Diff re-renders from cached payloads). Unconditional server facts keep one shape and let the client gate purely on view mode. Recomputing per render means the live-reload path refreshes facts with zero extra machinery.

*Failure posture:* any git error, timeout, or non-git root degrades `fileFacts` to `{lines, bytes, mtime}` — the render must never fail because facts collection did.

### 2. New `FileFacts` type in `src/shared/types.ts`

```ts
type FileFacts = {
  lines: number;
  bytes: number;
  mtime: string;            // ISO
  git?: {
    author: string | null;
    authoredAt: string | null;  // ISO
    shortSha: string | null;    // null when never committed
    dirty: boolean;             // working tree differs from HEAD for this path
  };
};
```

`git` absent = non-git root or git failure. `shortSha: null` + `dirty: true` = never committed. All strings are escaped server-side before serialization, matching the `sanitizeMetadata` posture.

### 3. Strip is a new `src/preview/file-facts-strip.ts`, mounted in preview chrome, gated by view

A dedicated renderer builds the strip DOM from `FileFacts` + view mode; `mount.ts` calls it after each document render, and `view-mode.ts` flips its visibility when the user toggles views without a refetch. The strip lives in the preview header region (a slot in `index.html` below the title/path/type row), not inside the document body — it is chrome framing the body, and keeping it out of `#preview` innerHTML means body swaps don't destroy signal state.

*Diff variant sources its numbers client-side:* base ref and per-file additions/deletions already exist in the client's repository snapshot, so the Diff strip composes `fileFacts.git` (author, SHA) with snapshot data (base, +N/−N) rather than adding server duplication.

*Relative times* ("2m ago") are formatted client-side from the ISO `mtime`, mirroring how the git-log pane shows relative times; the strip re-formats on re-render (every file event re-renders anyway, so drift while idle is acceptable).

### 4. Change signal: CSS class driven by the existing reload path, trailing-edge timer

In `src/shell/events.ts`, where `shouldReload` triggers `loadDocument` for the active file, also call a `signalActiveDocumentUpdated()` from the new strip/header module. Implementation: set a `.is-updated` class; a module-level timer clears it N seconds after the *last* event (each event resets the timer — trailing edge). This yields "stays lit under rapid fire, settles when writes stop" without animation restarts: the pulse is a CSS transition on class add, and repeated adds while the class is present are no-ops visually.

- Source/Diff: class lands on the strip's freshness segment.
- Rendered: class reveals a small transient "Updated" chip in the preview header (same module owns both, so navigation-away clears both through one code path — `loadDocument` for a *different* id and the empty/commit/review-score preview renderers clear the signal).
- `prefers-reduced-motion`: the CSS swaps the pulse for a static highlight.

*Why not a toast or the stale-hint machinery?* Toasts are too loud for an event that fires continuously while an agent writes; stale-hint models "content is stale, offer refresh," which is the freeze-while-reading philosophy explicitly out of scope.

## Risks / Trade-offs

- [Two git subprocesses per render adds latency to `/api/document`] → Run `log`/`status` concurrently via `Promise.all` with the render; `safeGit` already carries timeouts. Local-only tool; tens of ms is acceptable. If it ever isn't, facts can move to a follow-up async fetch without changing the payload shape (field is optional).
- [`git status --porcelain` on every render of a hot file during agent streaming] → Bounded by render frequency, which is already debounced by the watch session; no new event source is introduced.
- [Dirty detection via `status --porcelain` misses `mtime`-only touches (content identical to HEAD)] → Correct behavior: git considers the file clean, and claiming "uncommitted" would be false. The freshness segment then shows the last-commit date; accepted.
- [Strip in header region competes for vertical space with title/path/type chips] → Strip renders as one spare line, only in Source/Diff, and collapses entirely when absent (no reserved space in Rendered view).
- [Renames: `git log -1 -- <path>` misses pre-rename history] → Accepted for v1; `--follow` costs more and the last-touch fact is still truthful for the current path.

## Open Questions

- None blocking. (Exact copy/format of the strip segments — e.g. `8.2 KB` vs `8.2 kB`, date formatting — is an implementation detail to settle in code review.)
