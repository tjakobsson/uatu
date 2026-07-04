# Design — remove-deprecated-leftovers

## Context

Three deprecation stories from April–May 2026 never got their final act: the `--mode` flag (spec-mandated for removal one release after `simplify-modes-and-follow`), the `.uatuignore` startup advisory (transition aid for `live-reload-ignore-rules`), and the legacy localStorage migration keys in `src/shell/state.ts`. On top of that, a code-health sweep found ~40 exported symbols with no external importer, and the README's usage section has drifted from `usageText`. This change is a coordinated sweep of all of them — small individually, but together they make the help text lie and keep dead concepts in the vocabulary.

## Goals / Non-Goals

**Goals:**
- `--mode` fails as an unknown flag; help text lists exactly the flags the parser honors.
- `.uatuignore` gets zero special handling anywhere in the codebase.
- Legacy localStorage keys and their one-time cleanup code are gone.
- Public API surface shrinks to what is actually imported (tests count as importers).
- README usage documentation matches `--help` output.

**Non-Goals:**
- No behavior change for any live flag.
- No renaming (the `watch`→`serve` question is the separate `rename-watch-to-serve` change).
- No restructuring of `session.ts` (separate `split-server-session-module` change).
- Not removing localStorage keys that are still actively written (e.g. `COMPARE_TARGET_KEY`, `FILES_PANE_FILTER_KEY`) — only de-exporting them where nothing external imports them.

## Decisions

- **Delete the `--mode` parser branch rather than keep a friendlier error.** The spec already committed to "unknown CLI argument" semantics; a bespoke "removed flag" message would be new surface for a dead concept. The generic `unknown flag: --mode` path is the contract.
- **De-export rather than delete for internal-only symbols.** Most of the ~40 symbols are used within their module; the smell is needless public surface, not dead code. Symbols with zero references anywhere (including their own module) are deleted. Symbols referenced only by their colocated test keep the export — tests are legitimate consumers.
- **Legacy localStorage cleanup code goes entirely.** The migration ran for every user who launched uatu since 2026-05-20. Stale keys left in old browser profiles are harmless orphans; carrying cleanup code forever to delete them is worse than leaving them.
- **README reconciliation is docs-only.** The single source of truth for flags is `usageText`; the README's usage block is rewritten to match it verbatim (minus the banner line).

## Risks / Trade-offs

- [Someone still passes `--mode` in a script] → The exit is loud and immediate (`unknown flag`), and the flag has warned "no effect" on every launch for six weeks. Acceptable per the existing spec's own sunset schedule.
- [A "dead" export is actually consumed by something the sweep missed (dynamic import, e2e helper)] → Verify with `bun test` + `bun run test:e2e` + `bun run build` before merge; de-exporting is compile-time-checked by `tsc`, so a missed consumer fails the build, not production.
- [Removing `.uatuignore` warning strands a user who still relies on the old file] → The file has had no effect for two months; the warning's job is done. README keeps no mention of `.uatuignore`.

## Migration Plan

Single PR. No data or deploy migration — the only persisted state touched is browser localStorage, where cleanup code is *removed*, not added. Rollback is a straight revert.

## Open Questions

None.
