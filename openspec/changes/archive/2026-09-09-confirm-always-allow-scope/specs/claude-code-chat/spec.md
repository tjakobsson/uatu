## MODIFIED Requirements

### Requirement: Tool permissions are brokered interactively
When a Claude Code session asks for permission to use a tool, the request
SHALL surface as a pending permission in the owning conversation,
identifying the action and affected resources, and the user's approval or
rejection SHALL be returned to the session. An approval scoped to the
session SHALL suppress repeat prompts for equivalent actions within that
conversation where Claude Code supports it, and the card SHALL state that
reach in Claude Code's own terms — never another agent's. A permission
left pending when its session ends SHALL be resolved to a visible failed
or interrupted outcome rather than remaining pending forever.

The session-scoped approval SHALL NOT be sent on the first click: its
confirmation step SHALL list, in Claude Code's own permission-rule syntax,
exactly the session-scoped permission updates the reply will forward,
listed separately from the request's own resources. Every update the
reply forwards SHALL be listed, and nothing that is not forwarded SHALL be
listed. Updates that would persist beyond the live session MUST NOT be
forwarded and MUST NOT be listed. When Claude Code supplied no
session-scoped update for the request, the confirmation SHALL state that
confirming covers only this request. A request recovered after its live
announcement was missed SHALL confirm with the same listed updates the
live announcement would have shown.

#### Scenario: A tool request waits for the user
- **WHEN** a Claude Code turn requests permission for a file edit
- **THEN** the conversation shows a pending permission naming the action and file
- **AND** the turn proceeds only after the user approves
- **AND** rejection is reported back and the turn continues without the tool result

#### Scenario: The persistent-approval scope names Claude Code's reach
- **WHEN** a Claude Code permission card offers a persistent approval
- **THEN** its scope line describes what that approval covers under Claude Code
- **AND** it does not name another agent

#### Scenario: The confirmation lists the rules the reply will forward
- **WHEN** a Claude Code permission request carries session-scoped rule suggestions and the user chooses the persistent approval
- **THEN** the confirmation lists each suggested rule as a Claude Code permission rule, apart from the request's resources
- **AND** confirming forwards exactly those rules with the approval

#### Scenario: A persisting suggestion is neither forwarded nor listed
- **WHEN** a Claude Code permission request suggests a rule destined for a settings file
- **THEN** the confirmation does not list it
- **AND** confirming does not forward it

#### Scenario: No session-scoped suggestion means only this request
- **WHEN** a Claude Code permission request carries no session-scoped suggestion and the user chooses the persistent approval
- **THEN** the confirmation states that confirming covers only this request
- **AND** confirming approves the request without forwarding any rule

#### Scenario: A dead session's permission does not hang
- **WHEN** a Claude Code session ends while a permission is pending
- **THEN** the pending card resolves to a non-pending outcome the user can see
