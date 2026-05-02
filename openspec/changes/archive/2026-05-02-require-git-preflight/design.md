## Context

`uatu watch` currently accepts arbitrary directories or files, starts a recursive chokidar watcher, waits for the watcher to become ready, scans the watched roots, and only then starts printing the usual startup output. That works for normal repository-sized inputs, but accidental broad roots such as a home directory can make startup appear hung because the UI is not available until expensive filesystem work has finished.

The product intent is a codebase watcher. Git repository membership is already part of the review sidebar model, and it is a cheap signal that a watched path is probably a project rather than a broad personal directory.

## Goals / Non-Goals

**Goals:**

- Fail fast before server or watcher startup when any watched root is outside a git worktree.
- Allow explicit non-git watching with `--force`, with a clear warning that indexing may be slow.
- Show a TTY-only indexing message during initial watcher/index startup, then clear it and show the existing logo and URL when ready.
- Make loaded `.uatu.json` review scoring configuration visible even when it does not change the current score.
- Preserve clean stdout for non-interactive use: redirected or piped startup output remains only the URL.
- Keep the implementation small and local to startup parsing/preflight/output behavior.

**Non-Goals:**

- Streaming partial indexing results to the browser.
- Making home-directory watches fast under `--force`.
- Changing runtime repository review behavior after a session starts.
- Replacing `.uatuignore`, `.gitignore`, or hardcoded denylist behavior.
- Changing the configured scoring math for matched risk, support, and ignore areas.

## Decisions

### D1: Use git membership as a startup prerequisite by default

After path resolution validates existence, type, and binary-file rejection, startup will probe each watch entry with `git rev-parse --show-toplevel`. Directory entries use their absolute path as the probe directory; file entries use their parent directory. If any probe fails and `--force` is not set, startup exits with a clear error that lists the offending input roots and mentions `--force`.

Alternative considered: perform a bounded filesystem-size preflight. That catches broad directories but adds heuristic thresholds and can still touch many files. Git probing is cheaper, easier to explain, and matches the codebase-oriented purpose.

### D2: Keep `--force` as an explicit escape hatch

`--force` bypasses the git prerequisite only. It does not disable existing missing-path, denied-path, binary-file, or port validation. When non-git roots are present under `--force`, startup prints a warning to stderr before indexing begins.

Alternative considered: hard-require git with no override. That is simpler but removes useful local-preview cases for scratch directories, generated docs, and temporary files.

### D3: Show indexing status only for interactive terminals

When stdout is a TTY, startup writes a short single-line indexing message before the initial watch session starts. Once startup completes, that line is cleared and the existing ASCII banner and URL are printed. When stdout is not a TTY, no indexing text or banner is printed, preserving the current script-friendly URL-only behavior.

Alternative considered: print indexing status to stderr. That avoids stdout manipulation but does not achieve the desired visual replacement with the normal logo.

### D4: Keep preflight before watcher startup

The git prerequisite must run before `createWatchSession().start()`, because the user-visible problem is slow or surprising recursive watch initialization. The startup sequence becomes path resolution, git preflight, optional warning/status, watcher/index startup, then URL/banner/browser open.

Alternative considered: start the server immediately and show indexing in the browser. That would improve perceived responsiveness but requires partial state/loading behavior in the SPA and is larger than this guardrail change.

### D5: Represent unmatched configured review areas separately from score drivers

Matched risk, support, ignore, and warning entries remain score drivers because they affect scoring or explain a warning. Configured areas that do not match the current change should be exposed as zero-impact configuration facts so the UI can show that `.uatu.json` loaded without implying a score contribution. The score explanation can then render each configured area with either matched files or a "no files matched" state.

Alternative considered: add zero-score drivers for every unmatched configured area. That would reuse the existing rendering path, but it blurs the meaning of drivers: today drivers are facts that contributed to the current score explanation. A separate representation keeps score math and configuration visibility distinct.

## Risks / Trade-offs

- Existing non-git usage breaks by default -> Document the breaking change and provide `--force` with a clear error message.
- Git probing can fail if `git` is unavailable on PATH -> Treat it as non-git/unavailable for startup and allow `--force` to proceed.
- TTY line clearing can render poorly in unusual terminals -> Keep the status single-line and make cleanup best-effort before printing the existing banner.
- Multi-root sessions may mix git and non-git roots -> Report every non-git root so users can fix the command without repeated runs.
- Showing unmatched configuration could feel noisy in small changes -> Keep it in the configuration/warnings section and mark unmatched areas as zero-impact rather than adding them to the score-driving list.
