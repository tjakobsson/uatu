## ADDED Requirements

### Requirement: Same-tab navigation preserves workspace terminal state
The terminal SHALL preserve each workspace's per-tab visibility and pane references across page reload, navigation to another workspace and back, and browser history restoration. Leaving a page SHALL release its terminal connections without terminating its shells or recording the panel as user-hidden. When the same tab returns to a workspace with previously visible terminals and those PTYs are still alive and unclaimed, it SHALL restore the panel and reattach the same shells automatically without a takeover action or replacement shell. A hidden terminal SHALL remain hidden. Each workspace SHALL retain its own visibility independently. Browser-tab and installed-PWA navigation SHALL follow the same contract. Restoration SHALL NOT steal keyboard focus.

#### Scenario: Reload restores a running terminal
- **WHEN** a user reloads a workspace with a visible terminal and a live shell that no other client claims
- **THEN** the terminal becomes visible and interactive with the same shell state
- **AND** the user does not need to open Terminal or activate Take over

#### Scenario: Workspace round trip restores multiple panes
- **WHEN** the user leaves workspace A with multiple visible terminal panes, opens workspace B, and returns to A in the same tab
- **AND** A's shells remain alive and unclaimed
- **THEN** A restores its pane arrangement and reconnects those shells without creating additional PTYs
- **AND** A's stored dock, dimensions, and display mode remain in effect

#### Scenario: Visibility belongs to each workspace
- **WHEN** A has a visible terminal and B has a hidden terminal in the same tab
- **AND** the user switches from A to B and back
- **THEN** B's terminal stays hidden and A's terminal is restored visible

#### Scenario: Browser restores a cached page
- **WHEN** browser history restores a workspace page after its terminal connections were released on departure
- **THEN** the visible terminal reconciles its saved panes with live inventory and resumes available shells
- **AND** obsolete connection callbacks do not remove the restored panes or hide the panel

### Requirement: Attachment recovery preserves presentation and explicit ownership
A terminal connection failure SHALL NOT by itself be treated as shell exit, pane closure, or a request to hide the terminal. A visible pane restoring a saved PTY SHALL remain visible while its attachment is reconciled with authenticated inventory. Recovery SHALL distinguish a detached PTY, an occupied PTY, a missing PTY, and unavailable inventory or authentication. Transient restore failures SHALL receive bounded automatic recovery, after which the panel SHALL present an actionable result rather than retry indefinitely. Neither recovery nor a saved pane reference SHALL authorize takeover or automatic replacement-shell creation. A confirmed missing or exited PTY SHALL be reported as ended or unavailable rather than offered for takeover. A confirmed explicit takeover by another client SHALL retain the existing Take back behavior without automatic reclamation.

#### Scenario: Previous connection is released after restore begins
- **WHEN** a saved-pane restoration encounters its previous connection still attached
- **AND** that connection is released within the bounded recovery window without another client claiming the PTY
- **THEN** the pane automatically attaches to the now-detached PTY using an ordinary attach
- **AND** the panel stays visible and no takeover action is required

#### Scenario: Another client keeps the terminal
- **WHEN** a saved PTY remains attached to another client throughout the recovery window
- **THEN** the panel stays visible and offers an explicit takeover action for that PTY
- **AND** the existing holder stays interactive until the user explicitly takes over
- **AND** copied or duplicated-tab pane references do not bypass this rule

#### Scenario: Hub accepts the browser connection but the child rejects attachment
- **WHEN** the browser-side WebSocket opens through the Hub but attachment fails before terminal reconstruction completes
- **THEN** the client treats it as an attachment failure and reconciles the saved PTY
- **AND** the failure does not delete the pane or persist hidden visibility

#### Scenario: Inventory cannot be reached
- **WHEN** recovery cannot obtain authenticated terminal inventory within its bounded window
- **THEN** the pane retains its saved PTY reference and the panel shows a retry or authentication action appropriate to the failure
- **AND** unavailable inventory is not presented as proof of another holder or shell exit

#### Scenario: Saved shell no longer exists
- **WHEN** recovery successfully reads inventory and the saved PTY is absent
- **THEN** the panel reports that terminal as ended or unavailable and offers an explicit way to open a new shell
- **AND** it neither attempts takeover of that PTY nor silently replaces it

#### Scenario: Explicit takeover does not start a recovery fight
- **WHEN** another client explicitly takes over an attached terminal
- **THEN** the displaced pane presents its existing Take back action
- **AND** navigation or pending retry callbacks do not automatically reclaim the terminal

#### Scenario: User action supersedes recovery
- **WHEN** the user hides or closes a terminal while its restoration is pending
- **THEN** pending recovery cannot reopen the panel or attach a superseded pane
- **AND** hiding keeps the shell alive while explicit confirmed termination retains its existing destructive behavior
