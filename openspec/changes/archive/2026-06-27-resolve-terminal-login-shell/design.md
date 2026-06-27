## Context

The terminal server selects the PTY shell inline in `src/terminal/server.ts` with `options.shell ?? process.env.SHELL ?? "/bin/sh"`. That is correct for normal interactive launches but collapses to `/bin/sh` *silently* in sandboxes (e.g. sbx) that omit `SHELL`. The original direction for this change reconstructed the login shell from the user database (`os.userInfo()` → `/etc/passwd` → macOS `dscl`). That was rejected during implementation:

- It is a hand-rolled, per-platform reimplementation of the libc `getpwuid()` primitive. Each source only covers one case (`/etc/passwd` misses macOS Directory Services and LDAP/NSS; `dscl` is macOS-only).
- `os.userInfo()` — the actual `getpwuid` binding — is **broken under Bun**: it echoes `$SHELL` and returns `"unknown"` when `SHELL` is unset, so the cross-platform source contributes nothing on the runtime uatu ships on.
- It added a synchronous `execFileSync("dscl", …, { timeout: 2000 })` on the terminal-open hot path — a hang risk in a project that already maintains a watchdog subsystem.
- It is not what an interactive emulator does. xterm, tmux, and VS Code's terminal trust `$SHELL`; they do not reverse-engineer the login shell.

The motivating complaint was not "the shell is wrong" but "the shell downgraded **unexpectedly**." So the fix targets the surprise, not the shell value.

## Goals / Non-Goals

**Goals:**

- Trust `$SHELL` when it points at a non-empty value; keep `/bin/sh` as the final fallback.
- Make the `/bin/sh` fallback visible and actionable on both relevant surfaces (operator stdout + browser terminal).
- Leave the child `SHELL` exactly as inherited — never synthesize it.
- Cover the behavior with deterministic unit tests that do not depend on the host's `SHELL` or installed shells.

**Non-Goals:**

- Reconstruct the login shell from the user database (`/etc/passwd`, `dscl`, `os.userInfo()`). Explicitly dropped.
- Add user-facing shell configuration to `.uatu.json` or CLI flags.
- Support Windows shell selection before Bun's PTY backend supports Windows.
- Change terminal authentication, session lifecycle, or browser protocol behavior.

## Decisions

### Decision 1: Trust `$SHELL`, keep selection inline

Resolution stays in `server.ts` as `options.shell ?? envShell ?? "/bin/sh"`, where `envShell` is `$SHELL` only when non-empty after trimming. No `src/terminal/shell.ts` resolver, no user-database probing, no executability/sentinel validation. An empty or whitespace-only `$SHELL` is treated as unset (the previous `?? ` chain would have spawned `""`).

Alternative considered: a terminal-local resolver with a validated user-database source chain. Rejected — see Context.

### Decision 2: Announce the `/bin/sh` fallback on two surfaces, at two cadences

When `$SHELL` is unset/empty the terminal still starts `/bin/sh`, but now says so on the surface and at the cadence that matches each audience:

- **stdout, once at startup:** when `uatu watch` boots and the terminal backend is available, cli.ts prints `uatu: $SHELL is not set, so terminals opened in uatu will run /bin/sh instead of your login shell. …`. This is a process-global fact known at boot, so it is checked once at startup — not lazily on the first terminal open — and it reaches the operator running uatu, whose environment is the one that can be fixed. Gated on terminal availability; if there is no terminal, `$SHELL` is irrelevant.
- **in-terminal, every open:** the server writes a dim one-line notice into each opened session before the shell's first prompt. This reaches the browser user staring at the downgraded shell. Each session is its own context, so it fires per open.

Both messages live in `src/terminal/shell-warning.ts` so the wording stays in one place; `shellIsUnset(env)` is the shared "$SHELL effectively unset" predicate. The notice never blocks startup — a failed `socket.send` is swallowed like any other PTY write.

Alternative considered: emit the stdout warning lazily from the server on first fallback open (guarded once-per-process). Rejected — a missing `$SHELL` is knowable at boot, and printing it at startup puts it where the operator is already looking, instead of whenever someone first happens to open a terminal.

Alternative considered: warn on only one surface. Rejected — the operator (who can fix it) and the browser user (who sees it) may be different people, and each needs its own surface.

### Decision 3: Never synthesize the child `SHELL`

`ptyEnv` leaves `SHELL` exactly as inherited; uatu does not set it to the spawned shell on the fallback path. If `SHELL` is unset, the user may have unset it deliberately, and it is not uatu's place to fabricate one or to hide the gap from programs launched in the terminal. The warning explains the consequence; the decision stays with the user.

Alternative considered: overwrite `ptyEnv.SHELL` with the resolved shell so child programs see a consistent value. Rejected — it papers over the user's environment and asserts a choice (`/bin/sh`) the user did not make.

## Risks / Trade-offs

- [Risk] The in-terminal notice adds a line to fresh scrollback. -> Mitigation: only on the fallback path (never when `$SHELL` is set), dim-styled, one line, before the prompt.
- [Risk] The once-per-process stdout guard could suppress the warning across unrelated sessions. -> Mitigation: acceptable — it is a process-global fact; a test reset hook re-exercises the first-warning path.
- [Trade-off] A genuinely sandbox-misconfigured environment still gets `/bin/sh`, not the user's login shell. -> Accepted: the correct fix is to set `$SHELL` in the launcher, and the warning now points the operator at exactly that.

## Migration Plan

No migration required. Users with a valid `$SHELL` get the same shell and see nothing new. Users with missing `$SHELL` get the same `/bin/sh` they already got, now with an explanation.

## Open Questions

- None.
