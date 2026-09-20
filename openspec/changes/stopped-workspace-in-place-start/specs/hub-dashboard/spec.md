## MODIFIED Requirements

### Requirement: The workspace switcher chip reflects real session state
The in-session workspace switcher's collapsed chip SHALL show the current workspace's live indicator from hub-reported state, never from an assumption that the viewed session is running: a session page can outlive its server (a stop from the dashboard, a back/forward-cache restore). The chip and the open menu SHALL update from the brokered live stream's activity topic as workspace state changes, and additionally from fresh hub state on page-cache restores and whenever the menu's state refresh completes, so chip and menu can never disagree. When the current workspace's session is stopped, its entry in the open menu SHALL offer to start it, as entries for other stopped workspaces do, and a successful start SHALL leave the page in place to recover from the stream rather than navigating. The switcher and the shell's connection indicator SHALL agree on whether the current session is stopped: both derive it from the same hub-reported state.

#### Scenario: A cached page of a stopped session shows a truthful chip
- **WHEN** the user stops a session from the dashboard and returns to its page via browser history
- **THEN** the switcher chip's indicator shows not-running
- **AND** opening the menu shows the same state

#### Scenario: A stop elsewhere updates the chip without a refresh
- **WHEN** the viewed workspace's session is stopped from another device while its page is open
- **THEN** the chip's indicator turns not-running from the stream update, without the menu being opened or the page reloaded

#### Scenario: The current workspace's row starts its stopped session
- **WHEN** the user opens the switcher menu on a page whose session is stopped and activates the current workspace's entry
- **THEN** the hub is asked to start that session and the entry shows it starting
- **AND** the page is not navigated away; the chip's indicator and the connection indicator turn live once the started session's state arrives

#### Scenario: Chip and indicator agree
- **WHEN** the hub reports the current workspace's session not running
- **THEN** the switcher chip shows not-running and the connection indicator reads `Stopped`
- **AND** neither claims the session is running while the other says it is stopped
