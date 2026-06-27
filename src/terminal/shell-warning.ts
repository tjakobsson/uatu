// Shell-fallback diagnostics. When `$SHELL` is unset/empty, terminals opened in
// uatu run `/bin/sh` instead of the user's login shell. uatu does NOT synthesize
// a shell — the user may have unset `$SHELL` deliberately — it only makes the
// consequence visible, on two surfaces with two different cadences:
//
//   - Startup, once: a stdout warning printed when `uatu watch` boots (and the
//     terminal backend is available). This is a process-global fact known at
//     boot, and the operator who sees it is the one whose environment can be
//     fixed. See `SHELL_UNSET_STARTUP_WARNING` / `shellIsUnset` in `cli.ts`.
//   - Per terminal: a dim notice written into each opened session before its
//     first prompt, for the browser user staring at the downgraded shell. See
//     `SHELL_FALLBACK_NOTICE`, sent from `server.ts`.

// `$SHELL` counts as present only when it is non-empty after trimming; an empty
// or whitespace-only value is treated as unset (it cannot name a real shell).
export function shellIsUnset(env: NodeJS.ProcessEnv): boolean {
  return !(env.SHELL && env.SHELL.trim() !== "");
}

// Startup, stdout. Future tense — nothing has spawned yet; terminals opened
// later will run `/bin/sh`. Printed via cli.ts's `uatu: ${...}` convention, so
// it carries no prefix of its own. Leads with the consequence so the reader
// understands why setting `$SHELL` matters, rather than reading it as uatu
// helpfully choosing a shell for them.
export const SHELL_UNSET_STARTUP_WARNING =
  "$SHELL is not set, so terminals opened in uatu will run /bin/sh instead of your login shell. Set SHELL before launching uatu to use your usual shell.";

// Per session, in-terminal. Present tense — this shell already IS `/bin/sh`.
// Dim-styled, one line, written before the prompt and only on the fallback path.
export const SHELL_FALLBACK_NOTICE = `\x1b[2muatu: $SHELL is not set, so you have /bin/sh instead of your login shell. Set SHELL where uatu is launched to get your usual shell.\x1b[0m\r\n`;
