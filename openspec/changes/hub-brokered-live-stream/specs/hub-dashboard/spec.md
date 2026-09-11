## MODIFIED Requirements

### Requirement: The workspace switcher chip reflects real session state
The in-session workspace switcher's collapsed chip SHALL show the current workspace's live indicator from hub-reported state, never from an assumption that the viewed session is running: a session page can outlive its server (a stop from the dashboard, a back/forward-cache restore). The chip and the open menu SHALL update from the brokered live stream's activity topic as workspace state changes, and additionally from fresh hub state on page-cache restores and whenever the menu's state refresh completes, so chip and menu can never disagree.

#### Scenario: A cached page of a stopped session shows a truthful chip
- **WHEN** the user stops a session from the dashboard and returns to its page via browser history
- **THEN** the switcher chip's indicator shows not-running
- **AND** opening the menu shows the same state

#### Scenario: A stop elsewhere updates the chip without a refresh
- **WHEN** the viewed workspace's session is stopped from another device while its page is open
- **THEN** the chip's indicator turns not-running from the stream update, without the menu being opened or the page reloaded

## ADDED Requirements

### Requirement: The switcher surfaces other workspaces' activity
The in-session workspace switcher SHALL show, for each other workspace the user may access, whether its session is running, whether an agent is working in it, and whether an interaction awaits the user — sourced from the brokered stream's activity topic. The collapsed chip SHALL carry a badge while any other workspace has an interaction awaiting the user, and SHALL distinguish that from mere agent activity. Activity presentation MUST NOT reveal conversation content or titles, and MUST NOT vary by mode beyond the switcher's existing placement rules.

#### Scenario: An agent finishes in another workspace
- **WHEN** an agent in a workspace the user is not viewing transitions from working to idle
- **THEN** that workspace's entry in the switcher menu changes from working to idle without the menu being reopened

#### Scenario: A question elsewhere badges the chip
- **WHEN** an agent in another running workspace asks the user a question
- **THEN** the collapsed switcher chip shows an awaiting-interaction badge
- **AND** the menu entry for that workspace names it as awaiting the user
- **AND** the badge clears once the interaction is answered from any device
