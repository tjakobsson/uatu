# simplify-repo-config — design

## Context

`.uatu.json` is read by four independent loaders (`sidebar/tree-config.ts`, `terminal/config.ts`, `mono/config.ts`, and the review settings parser inside `review/load.ts`, which the `remove-review-burden` change deletes). Each re-reads and re-parses the file with its own warning behavior. Taxonomy finding from exploration: only the `tree` block (exclude patterns + gitignore respect) is a fact about the repository's content; fonts and clipboard policy are reader preferences, and clipboard specifically is a consent setting. The bundled-font default chain (`--terminal-font-family` → `--mono-font-family` → Hack Nerd Font Mono) already works with zero configuration — the payload fields are conditional overrides.

## Goals / Non-Goals

**Goals:**
- `.uatu.json` contains exactly one block: `ignore` (renamed `tree`), semantics unchanged.
- One loader, owned by `src/ignore/`, is the only code that parses the file.
- Font and clipboard behavior collapse to the existing defaults with no config path.
- Zero visual/behavioral difference for a repo with no overrides configured.

**Non-Goals:**
- Hub user settings for fonts/clipboard (future change; this change creates the vacancy, not the replacement).
- Changing ignore semantics, built-in defaults, or `--no-gitignore` precedence.
- Removing the `review` block (that belongs to `remove-review-burden`).

## Decisions

1. **Rename `tree` → `ignore` with no alias period.** The loader reads only `ignore`; an existing `tree` block is silently unread, like any unknown key. Alternative — warn on `tree` presence for one release — rejected as migration machinery the user base doesn't need; the release note carries it.
2. **The loader moves to `src/ignore/config.ts`.** `ignore/engine.ts` currently imports `loadTreeConfig` from `sidebar/` — an inverted dependency (policy engine importing from a UI folder). After the move, `sidebar/` has no `.uatu.json` knowledge. The live re-read behavior (matcher cache invalidation on `.uatu.json`/`.gitignore` change in `watch-session.ts`) is preserved verbatim.
3. **Clipboard policy hardcodes to `notify`, and the other branches are deleted.** `notify` is today's default: OSC 52 writes go through, a coalescing pane toast reports them. `confirm`/`silent`/`off` become unreachable without config, so their client code is deleted rather than kept dormant — dead switches are debt. The `TerminalClipboardPolicy` type collapses. When clipboard policy returns as a hub user setting, it returns through the state payload, not `.uatu.json`, and can reintroduce the richer policies then.
4. **`monoConfig`/`terminalConfig` leave the state payload entirely.** They were conditional override fields; with no source, the fields and their client apply-paths (`applyMonoConfig`, terminal font application from payload) are removed. The CSS defaults in `styles.css` are the single source of monospace truth. `src/mono/` is dissolved if `apply.ts` has no remaining caller (its only job was writing the override variable).
5. **Warning surface stays for the one remaining block.** Invalid `ignore.exclude`/`ignore.respectGitignore` values keep the warn-and-fallback behavior and continue to surface through the config-warnings channel (per `remove-review-burden`'s `configWarnings`; if this change lands first, the warnings ride the existing review-warnings path until that change renames it).

## Risks / Trade-offs

- [Someone's `terminal.fontSize` silently stops applying] → Accepted and announced; the bundled default is the designed experience. The touch runtime font-size control (separate spec'd feature) is unaffected — it is runtime state, not config.
- [Both this and `remove-review-burden` touch `shared/types.ts`/`cli.ts`/`watch-session.ts`] → Land sequentially; whichever lands second rebases trivially since both only delete from those files.
- [Deleting `confirm`/`off` clipboard code loses tested security-relevant behavior we may want back] → The OSC 52 bridge's hard limits (write-only, 100 KB cap, selection-param filtering) are untouched; only the user-facing policy variants go. Git history and the archived spec retain the behavior for reintroduction via hub settings.
- [`mono-font` spec becomes near-empty] → It retains the single-variable + no-hardcoded-stack requirements, which are real invariants; fine.

## Migration Plan

Single PR. Users rename `tree` → `ignore` in their `.uatu.json` (one minute, single-digit users) and delete `mono`/`terminal` blocks at leisure — they're ignored either way. Rollback = revert.

## Open Questions

- None blocking. Whether `src/mono/apply.ts` survives as a no-op-default writer or dissolves into `styles.css` alone is decided at apply time by what the boot path still needs.
