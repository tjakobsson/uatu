## 1. Shell Selection

- [x] 1.1 Resolve the PTY shell inline in `server.ts` as `options.shell ?? envShell ?? "/bin/sh"`, treating an empty/whitespace `$SHELL` as unset.
- [x] 1.2 Read `$SHELL` from an injectable `options.env` (default `process.env`) so the fallback path is testable.
- [x] 1.3 Remove the user-database resolver: delete `src/terminal/shell.ts` and `src/terminal/shell.test.ts`.

## 2. Fallback Warning

- [x] 2.1 Add `src/terminal/shell-warning.ts` with `shellIsUnset(env)` and the shared startup/notice message strings.
- [x] 2.2 In `cli.ts`, print the startup stdout warning once at boot when `$SHELL` is unset and the terminal backend is available.
- [x] 2.3 On the server fallback branch, write the dim one-line notice into each opened session before the shell's first prompt.

## 3. Server Integration

- [x] 3.1 Leave `ptyEnv.SHELL` exactly as inherited (no synthesis) while preserving inherited environment plus `TERM=xterm-256color` and `COLORTERM=truecolor`.
- [x] 3.2 Keep reattach behavior unchanged so existing PTYs continue running with their originally selected shell.

## 4. Tests

- [x] 4.1 Verify the configured shell spawns and the inherited `$SHELL` is left untouched (not clobbered), with no warning.
- [x] 4.2 Unit-test `shellIsUnset` (set/empty/whitespace/missing) and the message strings; verify the server writes the in-terminal notice when `$SHELL` is unset.
- [x] 4.3 Ensure tests do not require the developer or CI machine to have any non-standard shell installed.

## 5. Verification

- [x] 5.1 Run focused terminal tests for the affected server behavior.
- [x] 5.2 Run `bun test` and confirm the suite is green (606 pass, 0 fail).
- [x] 5.3 Run `openspec validate --changes resolve-terminal-login-shell` and confirm the change is valid.
