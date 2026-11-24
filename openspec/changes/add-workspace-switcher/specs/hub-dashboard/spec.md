## MODIFIED Requirements

### Requirement: Hub-served sessions expose hub navigation
Hub-served sessions SHALL expose the workspace switcher (workspace-switcher) for dashboard, Settings and workspace navigation. Opening it SHALL never interrupt the current page or its terminal connections; outside a hub the switcher's Hub sections MUST stay hidden. The hub's brand header SHALL show the logo centered with the wordmark beneath it and no tagline.

#### Scenario: Hub context exposes named navigation
- **WHEN** a hub-session-shaped base path and answering hub API at the origin root establish hub serving
- **THEN** the switcher SHALL name the current checkout and list every other registered workspace under Checkouts by name with its running or stopped state, with `Hub dashboard` and `Settings` in its footer
- **AND** duplicate names SHALL be disambiguated by path or stable-id detail
- **AND** the switcher SHALL NOT offer Sign out; it stays on the Hub's own pages

#### Scenario: Current workspace navigation respects browser intent
- **WHEN** the switcher is open
- **THEN** the current running workspace is named in its status card and is not a navigation target, so the page, its document URL and its terminals stay as they are
- **WHEN** explicit browser gestures open another checkout's row in another tab or window
- **THEN** normal link behavior SHALL remain

#### Scenario: A stopped current workspace retains recovery navigation
- **WHEN** the current workspace is stopped
- **THEN** the status card SHALL offer Start and in-place recovery

#### Scenario: A page has no Hub serving context
- **WHEN** the page is outside a hub, including a source-run child at the default path or bare `--base-path`
- **THEN** the switcher MUST NOT show Checkouts or the Hub links, and is absent unless the session serves GitHub data

#### Scenario: Switching workspaces from inside a session
- **WHEN** a user inside a hub-served session opens the switcher
- **THEN** they see the dashboard and Settings links and the other workspaces with running or stopped state
- **AND** activating another running workspace navigates to its stable session URL, while a stopped workspace is started first

#### Scenario: Selecting the current running workspace
- **WHEN** the user opens the switcher on the current running workspace
- **THEN** that workspace is the status card, not a row to activate, so the switcher closes on Escape or a tap outside with the current page and document URL unchanged
- **AND** open terminals retain their panes, connections, and shell processes without showing a takeover action

#### Scenario: Opening the current workspace in another tab
- **WHEN** the user explicitly opens a workspace's link in a new tab or window using browser link gestures (another checkout's row in the switcher, or the dashboard's row for this one)
- **THEN** the browser opens the workspace there normally
- **AND** the original page and its terminal connections remain intact

#### Scenario: Starting the current stopped workspace
- **WHEN** the current workspace is stopped and the user activates Start in the switcher's status card
- **THEN** the Hub starts that workspace and the current page recovers in place without navigating

#### Scenario: Duplicate names are distinguishable
- **WHEN** two registered workspaces share one display name
- **THEN** the switcher provides path or stable-id detail that distinguishes them without requiring names to be unique

#### Scenario: No hub affordance outside a hub
- **WHEN** the SPA runs under a source-run session child or under a base path with no hub answering at the origin root
- **THEN** no Hub navigation is shown

### Requirement: The workspace switcher chip reflects real session state
The switcher's chip and touch button, its open dialog, and the shell connection indicator SHALL consistently reflect authoritative hub session state. Starting the current stopped workspace SHALL recover in place without navigation.

#### Scenario: Hub updates and cached-page restores refresh all session indicators
- **WHEN** workspace state changes, a page-cache restore occurs, or a switcher state refresh completes
- **THEN** the chip, the touch button and the open dialog SHALL update from the brokered activity topic as workspace state changes and from fresh hub state on restores and completed refreshes so they cannot disagree
- **AND** they SHALL use hub-reported state, never assume a viewed session is running even after dashboard stop or back/forward-cache restore
- **AND** the shell connection indicator SHALL derive stopped state from that same hub report
- **WHEN** the current workspace is stopped
- **THEN** the switcher's status card SHALL offer Start and successful Start SHALL leave the page to recover from the stream without navigating

#### Scenario: A cached page of a stopped session shows a truthful chip
- **WHEN** the user stops a session from the dashboard and returns to its page via browser history
- **THEN** the switcher chip's indicator shows not-running and the touch button's face dims
- **AND** opening the switcher shows the same state

#### Scenario: A stop elsewhere updates the chip without a refresh
- **WHEN** the viewed workspace's session is stopped from another device while its page is open
- **THEN** the chip's indicator turns not-running from the stream update, without the switcher being opened or the page reloaded

#### Scenario: The current workspace's row starts its stopped session
- **WHEN** the user opens the switcher on a page whose session is stopped and activates Start in the status card
- **THEN** the hub is asked to start that session and the card shows it starting
- **AND** the page is not navigated away; the chip's indicator and the connection indicator turn live once the started session's state arrives

#### Scenario: Chip and indicator agree
- **WHEN** the hub reports the current workspace's session not running
- **THEN** the switcher chip shows not-running and the connection indicator reads `Stopped`
- **AND** neither claims the session is running while the other says it is stopped

### Requirement: The switcher surfaces other workspaces' activity
The in-session switcher SHALL report other accessible workspaces' live activity, with the badge and menu-state rules below. Viewing finished Chat SHALL clear its state across devices. Activity presentation MUST NOT reveal conversation content or titles, and MUST NOT vary by mode beyond the switcher's existing placement rules.

#### Scenario: Other-workspace activity is presented privately and consistently
- **WHEN** the brokered activity topic reports other accessible workspaces
- **THEN** the switcher SHALL show session running state, agent work, awaiting interaction, and finished work since last viewing Chat
- **AND** a Checkouts row's running state SHALL read `Awaiting you`, `Working` (with a spinner in place of its status dot), `Finished`, or idle by absence of a word
- **AND** the collapsed chip and the touch switcher button SHALL carry a badge while any other workspace awaits the user, a distinct badge while any other workspace has finished unviewed work, and SHALL distinguish both from mere agent activity; when several apply the chip shows the most urgent in the order awaiting, finished, working
- **AND** presentation MUST NOT reveal conversation content/titles or vary by mode beyond existing placement rules
- **WHEN** a finished workspace's Chat is opened
- **THEN** its entry and badge SHALL clear on every device without reload

#### Scenario: An agent finishes in another workspace
- **WHEN** an agent in a workspace the user is not viewing transitions from working to idle
- **THEN** that workspace's Checkouts row changes from working to finished without the switcher being reopened
- **AND** the collapsed chip shows a finished badge

#### Scenario: Background work reads as working
- **WHEN** an agent in another workspace has ended its turn but still holds a backgrounded task
- **THEN** that workspace's entry still reads as working

#### Scenario: Opening the finished workspace clears the state
- **WHEN** the user opens a finished workspace and its chat surface is in view
- **THEN** the workspace's entry no longer reads finished and the badge clears on the user's other open pages

#### Scenario: A question elsewhere badges the chip
- **WHEN** an agent in another running workspace asks the user a question
- **THEN** the collapsed switcher chip shows an awaiting-interaction badge
- **AND** that workspace's Checkouts row names it as awaiting the user
- **AND** the badge clears once the interaction is answered from any device

#### Scenario: Awaiting outranks finished on the chip
- **WHEN** one other workspace awaits the user and another has finished unviewed work
- **THEN** the collapsed chip shows the awaiting badge
- **AND** each Checkouts row still names its own state

### Requirement: Hub offers explicit worktree lifecycle navigation
The workspace switcher SHALL focus on switching and on creating worktrees in the current repository through **+ New**, with explicit checkout identity. Real switcher and dashboard surfaces SHALL preserve lifecycle, provenance, safety, accessible interaction, and independent workspace context without generic Details navigation.

#### Scenario: Picker repository identity and grouping are unambiguous
- **WHEN** the switcher shows workspaces with or without repository-family membership
- **THEN** the status card SHALL name the current checkout's repository followed by its branch, identically for main and child, and the chip and touch button SHALL name its branch
- **AND** Checkouts rows SHALL share one left edge without indentation or tree lines, naming a main checkout by its repository and a worktree by its branch, with the branch and one state on a muted second line; checkouts of more than one repository SHALL be grouped under compact repository headings (the current repository's first), and a row never repeats its repository
- **AND** workspaces without a repository family SHALL keep only their display name without branch; grouping and identity MUST NOT be inferred from names

#### Scenario: Dashboard hierarchy preserves focused lifecycle and policy access
- **WHEN** the dashboard or switcher exposes worktree actions
- **THEN** the switcher SHALL have switching and one **+ New** for the current repository's main checkout, without Details or other repositories' forks (those stay on the dashboard)
- **AND** the dashboard SHALL retain original rows/actions, explicit parent/repository hierarchy, exact branch child names and parent forks, with all group rows on one left edge and no child indentation/tree lines
- **AND** generic Details SHALL be absent; live-inherited parent credentials/shared policy SHALL be managed through Hub Settings' own navigation, without heading/child Configure controls
- **AND** Open/Start/Stop and Remove from Uatu (unregister) remain distinct from guarded owned-only Delete worktree, using existing secondary affordances when available

#### Scenario: Worktree recovery and opening preserve context on real surfaces
- **WHEN** the real switcher or dashboard surfaces are displayed
- **THEN** inventory, discovery, recovery, and missing-path states SHALL be reviewable, and errors SHALL provide relevant inline retry/actions
- **AND** compact creation omits policy/path/base readouts and defaults stopped without switching; explicit Open SHALL use separate stable `/s/<workspace-id>/` context and restore its own files/preview/terminal/chat without conversation migration
- **AND** external registration preserves path/ownership; missing/uncertain trees remain unavailable without silent recreation
- **AND** keyboard, touch, themes, and titlebar inset SHALL be supported, with no-capability dashboard behavior unchanged

#### Scenario: Fork targets the selected main workspace
- **WHEN** the reviewer activates **+ New** in the switcher or the fork on either of two main workspace rows on the real dashboard
- **THEN** a small dropdown offers New branch / worktree, Existing branch and Register worktree…, and creation targets that parent only without a source/path readout in the popup
- **AND** Register worktree… opens a compact list of only the checkouts Git lists for that repository that Uatu has not registered — each with its branch, ownership label and path, offering Register workspace for an external tree and Retry registration for a retained Uatu-created checkout — with `Every worktree Git lists is registered.` and Cancel when there are none
- **AND** neither child has a fork action or independent credential/settings form

#### Scenario: Compact creation has an explicit starting branch
- **WHEN** New branch / worktree is selected
- **THEN** the popup contains target title, Name, Create from and Create/Cancel; Create from uses the shared local/remote editable fuzzy combobox plus adjacent Fetch
- **AND** initial choice prefers local main then sole remote main, otherwise stays empty; current checkout does not control defaults and refetch never reapplies them
- **WHEN** Existing branch is selected
- **THEN** an editable fuzzy combobox covers all local/remote branches with badges and qualified names; picking fills the input exactly, edits clear selection and disable Create, reopening permits reviewing all refs, and arrows/Enter/Escape, focus, touch and empty results are supported
- **AND** the adjacent Fetch remote branches icon explicitly refreshes cached refs, preserving query and a valid choice or invalidating a disappeared choice, with loading and inline errors; opening does not fetch
- **AND** neither popup contains extra metadata/destination/configuration/ownership readouts; cancellation and no submission do not mutate
- **AND** clicking an initial local or remote row without typing commits the exact input value and enables successful Create

#### Scenario: Preserve dashboard and existing lifecycle access
- **WHEN** worktree capability data is present
- **THEN** the original dashboard row renderer, paths, status dots, shell/credential summaries, style and applicable Rename/Stop/Start/Remove actions remain, augmented by nesting, branch labels and parent forks
- **AND** children follow their parent while retaining truthful individual status/actions, and child rename remains excluded
- **AND** there is no generic Details navigation or per-repository Configure control, and the switcher's only worktree control is **+ New**; parent policy on the Hub's Settings page, relevant recovery actions and guarded owned-only Delete remain available outside the focused switcher

#### Scenario: Nested rows show unobtrusive truthful provenance
- **WHEN** child workspaces appear on the original-style dashboard
- **THEN** their exact branch remains primary and a small muted label states ownership first (the switcher's rows leave provenance out and show the branch and state instead): `External worktree` for a registered external tree, `Ownership uncertain` for an unverifiable one, and otherwise `from <recorded-source-ref>` or, for a Uatu-owned branch with no recorded history, `origin unknown`
- **AND** new branch sources reflect the exact selected starting ref, remote-created tracking branches show their selected remote ref, and existing-local/external branches without recorded history remain unknown
- **AND** labels do not change with parent checkout/configuration or upstream updates

#### Scenario: Current main checkout is not creation provenance
- **WHEN** the main workspace is checked out on feature/foo
- **THEN** dashboard and switcher display feature/foo compactly, distinct from repository identity and child origin labels
- **WHEN** the checkout changes, is detached, or its branch is unknown
- **THEN** refresh reflects the current ref or explicit Detached HEAD / Branch unknown state without guessing main or modifying child sourceRef

#### Scenario: Picker labels every checkout the same way and groups without indentation
- **WHEN** a user opens the switcher from a child worktree of a repository
- **THEN** the status card reads that checkout's repository followed by its branch, in the same weight and size as a main checkout's own repository-then-branch reading, and the chip keeps its running/stopped indicator and its activity badge
- **WHEN** the switcher lists checkouts of two repositories
- **THEN** **+ New** in the Checkouts heading belongs to the current repository, each repository's rows sit under its own small heading, and every row shares one left edge with no indentation or tree lines
- **AND** the switcher fits a 390 px viewport without horizontal overflow in both colour schemes

#### Scenario: Worktree actions are available without leaving the workspace
- **WHEN** a user opens the switcher while viewing a document or conversation
- **THEN** worktree registration, create and explicit switch actions are available there without first visiting the Hub dashboard
- **AND** opening or refreshing that list does not change the active document, terminal or conversation context

#### Scenario: Created workspace is opened deliberately
- **WHEN** creation succeeds without a start request
- **THEN** the popup closes, the source list/switcher/dashboard refreshes, the source remains selected and a small `Created <branch>` confirmation, rendered at the top of the viewport below the titlebar inset and in the app's success colour, offers Open while leaving the child stopped
- **AND** no Worktree ready, Details or registration popup opens automatically on any SPA, dashboard or review creation path
- **AND** only explicit Open starts then navigates to its separate stable session URL displaying its own files, preview, terminal and chat

#### Scenario: Partial creation is not described as total failure
- **WHEN** checkout creation succeeds but registration fails
- **THEN** a compact actionable error in the originating flow explains that the checkout and branch remain and offers same-checkout Retry registration rather than duplicate Create or a metadata dump

#### Scenario: Small screen deletion remains intelligible
- **WHEN** a touch user reviews deletion
- **THEN** the compact `Delete worktree?` dialog identifies `<parent display name> / <branch>` with no full path, internal IDs, ownership, status card, duplicate fields or configuration inside
- **AND** stopped copy is “The worktree’s files will be removed. The Git branch will be kept.” with Cancel and destructive Delete
- **AND** running copy is “Its Uatu terminal and agent sessions will stop, then the worktree’s files will be removed. The Git branch will be kept.” with Cancel and destructive Stop and delete, with no extra checkbox
- **AND** normal cases fit the phone viewport without dialog overflow or scrolling

#### Scenario: Safety blocker stays compact and cannot be bypassed
- **WHEN** preflight or recheck identifies dirty/untracked/ignored data, a lock, external ownership/activity, nested dependency or stop failure
- **THEN** a short actionable reason replaces normal deletion consequences and prevents proceeding, with Cancel/Close and retry only where meaningful
- **AND** files and registration remain; no force action or promise to stop unknown external applications is shown
- **WHEN** explicitly authorized known Uatu activity stops successfully and all checks pass
- **THEN** deletion closes the dialog and removes the row, preserves the branch, and uses existing safe navigation if the removed workspace was active

#### Scenario: Back restores usable navigation
- **WHEN** the user opens a worktree and returns via the switcher or browser history
- **THEN** the opening indicator clears, authoritative or explicitly stale checkout state is shown, and the returning workspace restores its own document/preview, terminal context and selected conversation
- **AND** neither workspace's conversations are migrated or replaced by those from the other checkout
