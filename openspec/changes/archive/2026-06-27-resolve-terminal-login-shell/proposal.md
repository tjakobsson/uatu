## Why

The embedded terminal chooses `process.env.SHELL` and falls back to `/bin/sh` when the variable is absent. In sandboxed/containerized environments such as sbx, PTY children may be launched without `SHELL`, so the terminal silently downgrades to `/bin/sh` and the user has no idea why or how to fix it.

An interactive terminal emulator's job is to honor `$SHELL` — that is the convention every emulator (xterm, tmux, VS Code's terminal) follows. Reconstructing the login shell from the user database (`/etc/passwd`, `dscl`, `os.userInfo()`) is a per-platform reimplementation of `getpwuid()` that is fragile, Bun-broken (`os.userInfo()` echoes `$SHELL`), and not what an emulator should do. The real defect is that the downgrade is *silent*. The fix is to make it *visible and actionable*, not to guess the shell.

## What Changes

- Keep the principled behavior: use a valid explicit override, then `$SHELL`, then `/bin/sh`. Treat an empty/whitespace `$SHELL` as unset.
- When `$SHELL` is unset, surface it on two surfaces at two cadences:
  - a warning on stdout printed **once at uatu startup** (when the terminal is available), for the operator running `uatu watch` (whose environment can be fixed);
  - a dim one-line notice inside **each new terminal session**, for the browser user (who sees the downgraded shell).
- Leave the PTY's `SHELL` exactly as inherited — never synthesize it. If the user left it unset they may have a reason; uatu surfaces the consequence but does not decide a shell on their behalf or hide the gap from child programs.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `embedded-terminal`: Clarify that the terminal trusts `$SHELL` and that the `/bin/sh` fallback is announced on stdout and inside the terminal.

## Impact

- Affected code: `src/terminal/server.ts` (shell selection + per-session notice), `src/cli.ts` (startup warning), and a small `src/terminal/shell-warning.ts` holding the shared predicate and message strings. No `src/terminal/shell.ts` resolver — that approach is dropped.
- Affected tests: `shell-warning.test.ts` (predicate + messages) and terminal server tests covering `$SHELL` pass-through and the per-session fallback notice.
- No new runtime dependencies or public API changes.
