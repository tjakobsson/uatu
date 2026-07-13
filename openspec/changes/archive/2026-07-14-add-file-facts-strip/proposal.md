## Why

When inspecting a file in Source or Diff view, uatu shows nothing about the file itself — who last touched it, when, how big it is, or whether it carries uncommitted edits. Reviewers switching to these views are in "inspect the file" mode (vs. "read the document" mode), and repo-derived facts belong there, the way GitLab frames a file with its last-commit bar. Additionally, when the currently-viewed file changes on disk, the preview silently reloads in place with no signal at all — easy to miss, or jarring without explanation.

## What Changes

- Add a **file facts strip** to the preview, shown only in Source and Diff views (never in Rendered view, where the frontmatter metadata card already serves the reading posture):
  - Source view: last-commit author, date, short SHA, line count, byte size.
  - Diff view: compare base ref, additions/deletions, last-commit author + short SHA.
  - Non-git roots degrade to line count + byte size only.
- Add a **freshness segment**: when the file's on-disk state is newer than its last commit (uncommitted edits), the strip shows `modified <relative time> · uncommitted` in place of the last-commit date.
- Add a **calm change signal**: when the actively viewed file changes on disk and live-reloads, the UI signals it — a pulse on the facts strip's freshness segment in Source/Diff view, and a transient "Updated" indicator in the preview header in Rendered view. The signal must stay calm under rapid successive events (stays lit, does not strobe).
- Server computes file facts in the document render pipeline and attaches them to the `/api/document` payload; the client gates display purely by view mode.
- Explicitly out of scope: per-file history navigation, freeze-while-reading (deferring auto-reload).

## Capabilities

### New Capabilities

- `file-facts`: the file facts strip in Source/Diff views (git last-commit facts, line count, byte size, diff stats), its freshness/uncommitted segment, its non-git degradation, and the on-disk-change signal in all views.

### Modified Capabilities

<!-- none — no existing capability's requirements change; the strip is additive chrome and the change signal adds an affordance without altering follow-mode Rule C/D reload behavior -->

## Impact

- `src/server/render-dispatch.ts` — compute facts (stat, line count, git last-commit lookup) and extend the `RenderedDocument` payload.
- `src/review/load.ts` — reuse/extract the `safeGit` helper for the per-file `git log -1` and dirty-state lookups.
- `src/shared/types.ts` — new `FileFacts` payload type shared by server and client.
- `src/preview/` — new facts-strip renderer; wiring in `mount.ts` / `view-mode.ts` to show/hide by view; transient updated-indicator in `header.ts`.
- `src/shell/events.ts` — trigger the change signal when a file event reloads the active document.
- `src/index.html`, `src/styles.css` — strip markup slot and styles (pulse animation, reduced-motion fallback).
- One extra `git log -1` + `git status --porcelain` subprocess pair per document render in git roots (~tens of ms, local only).
