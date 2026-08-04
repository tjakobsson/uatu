# hub-dashboard Delta Spec

## ADDED Requirements

### Requirement: Dashboard lists sessions and workspaces with live status
The hub SHALL serve an authenticated dashboard listing running sessions and stopped registered workspaces. Each running session SHALL show its workspace name and path and a live shell summary sourced from the child's terminal session inventory (shell count, attached/detached, best-effort foreground-process label); each stopped workspace SHALL offer resume. Activating a running session SHALL navigate to its `/s/<id>/` URL. The dashboard SHALL be served under the hub origin so it shares the PWA installation with the sessions it links to.

#### Scenario: Running session shows live shell detail
- **WHEN** a session has two shells, one running a long-lived TUI, and the user opens the dashboard
- **THEN** the session's row reports the shells and the foreground-process label

#### Scenario: Jump into a session
- **WHEN** the user activates a running session's entry
- **THEN** the browser navigates to that session's `/s/<id>/` URL and the SPA loads

#### Scenario: Resume a stopped workspace
- **WHEN** the user activates resume on a stopped workspace
- **THEN** the hub starts a session for it via the workspace's backend and the entry becomes running

### Requirement: Dashboard can stop a running session
The dashboard SHALL offer a stop action per running session that terminates the session's server after an explicit confirmation naming the workspace, since stopping terminates that session's shells.

#### Scenario: Stop requires confirmation
- **WHEN** the user activates stop on a running session and confirms
- **THEN** the session's child process is terminated and the workspace moves to the stopped list

### Requirement: Dashboard can forget a stopped workspace
The dashboard SHALL offer a forget action on stopped workspaces that removes the registration only: the folder on disk MUST NOT be touched and SHALL reappear in the folder listing as an unregistered candidate. The hub SHALL reject forgetting a workspace whose session is running.

#### Scenario: Forgetting returns the folder to the candidates
- **WHEN** the user forgets a stopped workspace whose folder lives in the workspaces root
- **THEN** the workspace disappears from the registered list and its folder is offered again as an unregistered candidate

#### Scenario: A running session cannot be forgotten
- **WHEN** a forget request names a workspace with a running session
- **THEN** the hub rejects it and the registration is unchanged

### Requirement: Dashboard creates workspaces from the workspaces root
The dashboard SHALL offer workspace creation by picking from the direct subfolders of the hub's configured workspaces root, not by typing arbitrary server paths: the hub SHALL expose a folder listing (each subfolder with its name, whether it is a git repository, and whether it is already registered) and the dashboard SHALL present unregistered subfolders as candidates to serve. Creating from a non-git subfolder SHALL apply the git preflight: probe with `git rev-parse --show-toplevel` and, when the probe definitively reports no repository, offer to run `git init` before serving; on decline the folder SHALL NOT be registered or served. When the probe fails for any other reason the hub SHALL skip the offer and start the session, letting the CLI's own git preflight report. The dashboard SHALL additionally offer `git clone <url>`, cloning into the workspaces root, registering and serving the resulting folder; clone SHALL rely on the daemon user's ambient git credentials and the hub MUST NOT store credentials. Workspace-creation requests SHALL be resolved strictly against the workspaces root (folder names only — path separators and dot segments rejected). The hub MUST NOT pass `--force` to the server.

#### Scenario: Subfolders of the workspaces root are offered
- **WHEN** the user opens the dashboard on a hub whose workspaces root contains subfolders that are not yet registered
- **THEN** those subfolders are listed as candidates with their git status visible

#### Scenario: Non-git subfolder is initialized and served
- **WHEN** the user picks a subfolder that is not inside a git worktree and confirms initialization
- **THEN** the hub runs `git init` there, registers the workspace, and starts its session

#### Scenario: Declined initialization leaves no trace
- **WHEN** the user picks a non-git subfolder and declines initialization
- **THEN** no session starts and the folder is not added to the registry

#### Scenario: Clone creates a served workspace in the root
- **WHEN** the user submits a repository URL to clone
- **THEN** the hub clones it into the workspaces root, registers it with a stable id, and starts its session

#### Scenario: Path escapes are rejected
- **WHEN** a workspace-creation request names a folder containing a path separator or dot segment
- **THEN** the hub rejects it without touching the filesystem

#### Scenario: Failed clone or init is reported
- **WHEN** `git clone` or `git init` exits non-zero
- **THEN** the dashboard shows the git error output and no workspace is registered

### Requirement: Hub-served sessions expose hub navigation
When the SPA is served through a hub (a hub-session-shaped base path AND the hub API answering at the origin root), the sidebar header SHALL show a workspace switcher naming the current workspace, whose menu links to the hub dashboard and to every registered workspace (running state indicated; stopped workspaces labeled) and offers a sign-out entry. Outside a hub — local `uatu serve`, the desktop wrapper, a bare `--base-path` invocation — the affordance MUST stay hidden. The hub's brand header SHALL show the logo centered with the wordmark beneath it and no tagline.

#### Scenario: Switching workspaces from inside a session
- **WHEN** a user inside a hub-served session opens the workspace switcher
- **THEN** they see the hub dashboard link and the other workspaces with running/stopped state
- **AND** activating one navigates to that workspace's session URL

#### Scenario: No hub affordance outside a hub
- **WHEN** the SPA runs under local `uatu serve` (default base path) or under a base path with no hub answering at the origin root
- **THEN** the workspace switcher is not shown

### Requirement: Dashboard and login follow uatu's visual language
The hub's pages (login, dashboard, session-unavailable) SHALL use uatu's design system, not an ad-hoc theme: the same brand header (inline logo with its dark-scheme retint, wordmark typography), `color-scheme: light dark` with the app's `light-dark()` token palette so both schemes render correctly, the app's sans-serif body font with monospace reserved for paths and code, pane-style section headers, and the app's indicator-dot idiom for live/running state. Fixed single-scheme palettes MUST NOT be used.

#### Scenario: Both color schemes render correctly
- **WHEN** the dashboard is viewed under a light system scheme and under a dark system scheme
- **THEN** surfaces, text, and borders adapt via the token palette in both, with no illegible fixed-scheme colors

#### Scenario: The dashboard reads as uatu
- **WHEN** a user familiar with the uatu SPA opens the dashboard
- **THEN** the brand header, section headers, typography, and running-state indicators follow the same visual idioms as the SPA's sidebar chrome
