## MODIFIED Requirements

### Requirement: Terminal works in the watched repository directory
When the panel attaches a PTY, the shell SHALL start with its working directory set to the first watch root resolved by the CLI. The shell selection SHALL prefer a valid explicit terminal-server shell override, then the `SHELL` environment variable when it is non-empty, and SHALL fall back to `/bin/sh` only when those are unset or empty. The terminal SHALL NOT reconstruct the user's login shell from the user database. When `SHELL` is unset or empty and the terminal backend is available, uatu SHALL print a warning to stdout once at startup explaining that terminals will run `/bin/sh` instead of the user's login shell. When a terminal subsequently falls back to `/bin/sh`, uatu SHALL write a notice into each newly opened terminal session before the shell's first prompt. uatu SHALL NOT synthesize or modify the `SHELL` variable in the spawned PTY environment; the child inherits `SHELL` exactly as uatu received it.

#### Scenario: PTY inherits watch root as cwd
- **WHEN** uatu is started as `uatu watch ./some/dir` and the user opens the terminal panel
- **AND** the user types `pwd` and presses Enter in the terminal
- **THEN** the terminal output shows the absolute path of `./some/dir`

#### Scenario: PTY uses valid SHELL environment value
- **WHEN** the user's `SHELL` environment variable is set to `/opt/homebrew/bin/fish`
- **AND** the user opens the terminal panel
- **THEN** the spawned PTY runs `/opt/homebrew/bin/fish`
- **AND** the PTY inherits `SHELL=/opt/homebrew/bin/fish` unchanged
- **AND** no fallback warning is emitted

#### Scenario: Unset SHELL warns once at startup
- **WHEN** uatu starts with `SHELL` unset or empty
- **AND** the terminal backend is available
- **THEN** a warning naming `$SHELL` and `/bin/sh` is printed to stdout once at startup
- **AND** the warning is not repeated when terminal sessions are subsequently opened

#### Scenario: Missing SHELL falls back to sh with an in-terminal notice
- **WHEN** the user's `SHELL` environment variable is unset or empty
- **AND** no explicit terminal-server shell override is configured
- **AND** the user opens the terminal panel
- **THEN** the spawned PTY runs `/bin/sh`
- **AND** the spawned PTY's `SHELL` remains unset — uatu does not synthesize it
- **AND** a notice naming `$SHELL` and `/bin/sh` is written into the terminal session
