// The e2e harness's PTY shell: deterministic, whoever runs the suite.
//
// The product spawns `$SHELL` with the server's environment
// (src/terminal/server.ts). Passed through unchanged, that is the
// developer's own shell with their rc files (slow, multi-line prompts that
// race typed input) and, from macOS Terminal, `TERM_PROGRAM=Apple_Terminal`
// plus one shared `TERM_SESSION_ID`, which makes every test shell restore
// and then delete the same `~/.zsh_sessions` file. The harness instead
// hands the terminal server an explicit shell and environment:
//
// - zsh where it is installed (its line editor understands bracketed
//   paste, which macOS's bash 3.2 does not), bash otherwise;
// - HOME and ZDOTDIR pointing at a private directory whose only rc files
//   set a fixed prompt and no history file, so no user rc file runs;
// - the terminal-emulator session variables removed.
//
// Nothing here changes the product: it is only what the harness passes to
// createTerminalServer.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const E2E_SHELL_PROMPT = "uatu-e2e$ ";

const STRIPPED = [
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
  "ITERM_SESSION_ID",
  "ENV",
  "BASH_ENV",
  "PROMPT_COMMAND",
  "PS1",
  "RPROMPT",
];

export function e2eTerminalShell(): { shell: string; env: NodeJS.ProcessEnv } {
  const shell = ["/bin/zsh", "/usr/bin/zsh"].find(candidate => existsSync(candidate)) ?? "/bin/bash";
  const home = mkdtempSync(path.join(os.tmpdir(), "uatu-e2e-pty-home-"));
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));
  const rc = `PS1='${E2E_SHELL_PROMPT}'\nRPROMPT=''\nunset HISTFILE\n`;
  writeFileSync(path.join(home, ".zshrc"), rc);
  writeFileSync(path.join(home, ".bashrc"), rc);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of STRIPPED) delete env[name];
  Object.assign(env, {
    SHELL: shell,
    HOME: home,
    ZDOTDIR: home,
    // macOS's /etc/zshrc_Apple_Terminal honours this even if TERM_PROGRAM
    // comes back some other way.
    SHELL_SESSIONS_DISABLE: "1",
    BASH_SILENCE_DEPRECATION_WARNING: "1",
  });
  return { shell, env };
}
