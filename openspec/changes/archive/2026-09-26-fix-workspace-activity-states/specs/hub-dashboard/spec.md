## MODIFIED Requirements

### Requirement: The switcher surfaces other workspaces' activity
The in-session workspace switcher SHALL show, for each other workspace the user may access, whether its session is running, whether an agent is working in it, whether an interaction awaits the user, and whether work there has finished since the user last viewed its chat — sourced from the brokered stream's activity topic. A menu entry SHALL name the four running states distinctly: awaiting the user, working, finished, and (by the absence of a word) idle. The collapsed chip SHALL carry a badge while any other workspace has an interaction awaiting the user, a distinct badge while any other workspace has finished unviewed work, and SHALL distinguish both from mere agent activity; when several apply the chip shows the most urgent, in the order awaiting, finished, working. When the user opens a finished workspace's chat, its entry and badge SHALL clear on every device without a reload. Activity presentation MUST NOT reveal conversation content or titles, and MUST NOT vary by mode beyond the switcher's existing placement rules.

#### Scenario: An agent finishes in another workspace
- **WHEN** an agent in a workspace the user is not viewing transitions from working to idle
- **THEN** that workspace's entry in the switcher menu changes from working to finished without the menu being reopened
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
- **AND** the menu entry for that workspace names it as awaiting the user
- **AND** the badge clears once the interaction is answered from any device

#### Scenario: Awaiting outranks finished on the chip
- **WHEN** one other workspace awaits the user and another has finished unviewed work
- **THEN** the collapsed chip shows the awaiting badge
- **AND** each menu entry still names its own state
