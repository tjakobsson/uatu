# desktop-macos-shell delta — add-desktop-git-init

## ADDED Requirements

### Requirement: Opening a non-git folder offers repository initialization
Before starting a server for a folder, the app SHALL determine whether the
folder is inside a git worktree by running `git rev-parse --show-toplevel`
for that folder with the resolved login-shell environment. When the folder is
not inside a git worktree, the app SHALL present a confirmation dialog
offering to initialize a new git repository there instead of spawning a
server that is certain to fail the CLI's git preflight. On confirmation the
app SHALL run `git init` in the folder and, if it succeeds, start the server
for the folder as usual. On decline the app SHALL return to the launcher
without starting a server. If `git init` fails, the app SHALL show the
window's failure state containing the git error output. If the git executable
itself cannot be launched, the app SHALL skip the preflight and start the
server as it does today. The app MUST NOT pass `--force` to the server; the
CLI git preflight in `serve-cli-startup` is unchanged.

#### Scenario: Non-git folder is initialized and served
- **WHEN** the user opens a folder that is not inside a git worktree
- **AND** confirms the initialization dialog
- **THEN** the app runs `git init` in that folder
- **AND** starts the bundled server for it and loads the session as usual

#### Scenario: Declining initialization returns to the launcher
- **WHEN** the user opens a folder that is not inside a git worktree
- **AND** declines the initialization dialog
- **THEN** no server process is spawned
- **AND** the window shows the launcher again

#### Scenario: Git folder opens without any dialog
- **WHEN** the user opens a folder inside an existing git worktree (including a subdirectory of a repository)
- **THEN** no initialization dialog appears
- **AND** the server starts immediately

#### Scenario: git init fails
- **WHEN** the user confirms initialization and `git init` exits non-zero
- **THEN** the window shows the failure state including the git error output
- **AND** offers the existing "Try Again" and "Choose Folder…" actions

#### Scenario: git is unavailable
- **WHEN** the git executable cannot be launched for the preflight
- **THEN** the app starts the server for the folder without showing an initialization dialog

## MODIFIED Requirements

### Requirement: Launcher offers folder selection and recent folders
When a window has no served folder, the app SHALL show a launcher with the app
identity, a folder picker, and a list of recently served folders (most recent
first, shared across windows, bounded in length). Selecting a recent entry or
picking a folder SHALL start a server for it and record it as the most recent
entry, subject to the git-repository preflight: a folder that is not inside a
git worktree first goes through the initialization offer, and a declined
folder is neither served nor recorded as a recent entry.

#### Scenario: Reopening a recent folder
- **WHEN** the user clicks an entry in the recents list
- **THEN** a server starts for that folder and the entry moves to the top of the list

#### Scenario: Recents persist across app restarts
- **WHEN** the user quits and relaunches the app
- **THEN** the previously served folders still appear in the recents list

#### Scenario: Declined non-git folder is not recorded
- **WHEN** the user picks a non-git folder and declines initialization
- **THEN** the folder does not appear in the recents list
