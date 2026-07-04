# Design — rename-watch-to-serve

## Context

The CLI's only verb is `watch`, a leftover from when uatu was a Markdown file-watcher. The product is now a local serve loop (preview + review burden + terminal + follow), the README already pitches it as "following what an AI coding agent is doing", and the implementation vocabulary has split (`SERVE_IDLE_TIMEOUT_SECONDS` next to `WatchOptions`). The repo already has a proven deprecation playbook from the `--mode` sunset in `simplify-modes-and-follow`.

## Goals / Non-Goals

**Goals:**
- `uatu serve [PATH...]` is the canonical, documented command.
- Bare `uatu [PATH...]` (including zero args) starts a session — the common launch gets the shortest spelling.
- `uatu watch` keeps working for one release with a stderr deprecation warning; clean removal after.
- All user-facing text (usage, errors, README, ARCHITECTURE.md, CLAUDE.md, `bun run dev`) speaks serve vocabulary.

**Non-Goals:**
- Internal type renames (`WatchSession`, `WatchOptions`, `WatchEntry`, `runWatch`, …) — deferred to a follow-up; they're churn without user impact and would bloat this diff.
- Renaming the `document-watch-index` and `watch-freeze-diagnostics` capabilities — their requirements don't define the CLI verb.
- Any behavior change to flags, port selection, or startup output beyond the verb and wording.

## Decisions

- **`serve` over alternatives (`open`, `follow`, bare-only).** Docs-preview precedent is decisive (`mkdocs serve`, `jekyll serve`, `hugo server`), and keeping a named verb preserves subcommand namespace for future surfaces (e.g. an explore/guiding command), which a bare-only CLI would forfeit.
- **Bare invocation defaults to serve, breaking `uatu` → help.** For a tool launched constantly next to an agent session, the zero-argument path should do the useful thing. Help remains one flag away (`-h`/`--help`), and the parser routes: recognized command → that command; `-`-prefixed first arg → flag handling; anything else → `serve` with all args as paths.
- **Alias mechanics mirror the `--mode` sunset.** One release of accept-warn-forward, then the token loses command meaning. The warning goes to stderr so piped-stdout consumers (scripts capturing the URL) never see it. After the window, `uatu watch` naturally becomes "serve the path `watch`" — which for most users produces a clear "root does not exist: watch" error rather than silent misbehavior.
- **New capability `serve-cli-startup` supersedes `watch-cli-startup` wholesale** rather than editing scenarios in place. A full supersede keeps the spec folder name honest (the drift was the point of this change) and archives cleanly; the old capability's requirements are REMOVED with migration pointers.
- **Sequencing after `remove-deprecated-leftovers`.** That change edits `watch-cli-startup` (drops `--mode`); this one removes the capability. Landing them in order avoids two concurrent deltas fighting over the same requirement, and the new spec is written against the post-`--mode` text.

## Risks / Trade-offs

- [Muscle memory / scripts using `uatu watch`] → One full release of identical behavior plus warning; the alias forwards rather than errors, so nothing breaks on day one.
- [A user has a directory literally named `watch` after the window ends] → `uatu watch` then serves that directory, which is the documented bare-invocation semantics; ambiguity exists for exactly one token and only after the warning release.
- [Bare `uatu` no longer prints help, surprising first-time users] → First-time users inside a git repo get a running session and a browser tab — arguably better onboarding than a usage dump; outside a git repo they get the clear non-git preflight error which mentions `--force`.
- [PWA install identity or printed URL changing] → Untouched; the rename is argv-layer only, port and origin behavior unchanged.

## Migration Plan

1. Land `remove-deprecated-leftovers` first.
2. Single PR for this change: parser + usage + docs + `bun run dev`.
3. Next release ships the alias warning; the release after removes the alias (tracked as a one-line follow-up task in that release's change).
Rollback: straight revert; no persisted state involved.

## Open Questions

None — the alias-removal release timing follows whatever cadence the repo uses for the `--mode` precedent.
