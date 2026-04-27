## Context

The watch session caches one `IgnoreMatcher` per dir-root (`matcherCache` in
`src/server.ts`) so subsequent `scanRoots` calls don't re-read the ignore
files on every refresh. Before this change the cache was populated once at
`start()` and never invalidated, leaving stale rules in effect after the user
edited `.uatuignore` or `.gitignore`. The implementation has shipped; this
design exists to document the decision so future readers understand why
the spec ties live-reload to the cache-eviction trigger and not to a polling
loop or an explicit reload command.

## Goals / Non-Goals

**Goals:**
- Spec-level guarantee that filtering reflects the *current* on-disk contents
  of `.uatuignore` / `.gitignore`, not a startup snapshot.
- Symmetric behaviour: rules that gain a pattern hide files; rules that drop
  a pattern restore them.

**Non-Goals:**
- Per-directory nested `.uatuignore` / `.gitignore` files (still out of scope —
  pre-existing requirement keeps that boundary).
- Reloading on `--no-gitignore`-flagged sessions: that flag short-circuits
  `.gitignore` entirely, so live edits to it are irrelevant by construction.
- Hot-reloading the hardcoded directory denylist (it's a constant).

## Decisions

**Trigger reload on the watcher event, not on a timer.**
- Chosen: when chokidar fires `change`/`add` for a file whose basename is
  `.uatuignore` or `.gitignore` and whose parent equals one of the watched
  dir-roots, evict the cache entry. The next `scanRoots` rebuilds the matcher.
- Alternative considered: poll on the existing 5-second reconcile timer. Rejected:
  adds latency the user can feel between save-and-see, and re-reads the ignore
  file even when nothing changed.
- Alternative considered: explicit `/reload-ignore` API. Rejected: more surface
  for no win — the watcher already sees the edit.

**Evict, don't pre-load.**
- Chosen: delete the cache entry on the event; let the upcoming `scanRoots`
  call rebuild it lazily.
- Alternative considered: synchronously re-load the matcher inside the event
  handler. Rejected: the event handler is sync; the loader is async; lazy
  rebuild keeps the handler simple and the rebuild happens before the
  refresh's `walkAllFiles` runs anyway.

## Risks / Trade-offs

- **Race between event and refresh** → `isPathIgnored` (chokidar's `ignored`
  predicate) consults the cache directly. Between the `delete` and the next
  `scanRoots`, it returns `false` (no matcher → fall-through), which means a
  brief window where chokidar may surface events for paths the *new* rules
  would hide. The next refresh's scan reconciles the visible tree from the
  filesystem with the rebuilt matcher, so the user-visible state converges
  correctly. Trade-off accepted: avoids a sync/async tangle in the handler.

- **No coverage for `.gitignore` live edits** → the unit test
  ("editing .uatuignore at runtime reapplies the new patterns") exercises only
  the `.uatuignore` path. The cache-eviction predicate is symmetric on the
  basename, so the same code path covers `.gitignore`. Documented as a scenario
  in the spec; not adding a duplicate unit test.
