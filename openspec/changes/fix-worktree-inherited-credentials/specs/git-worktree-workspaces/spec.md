## MODIFIED Requirements

### Requirement: Workspace boundaries and credentials remain explicit
Each registered worktree SHALL have independent workspace identity, child/watch root, terminal cwd and provider directory context. Explicit switching through the existing workspace picker SHALL navigate to the selected checkout's separate `/s/<workspace-id>/` context for files, preview, terminal and chat, not replace the current workspace's checkout in place. Returning through the picker or browser history SHALL restore that workspace's own selected document/preview, terminal context and selected conversation. Conversations MUST remain attached to their original checkout and MUST NOT migrate or be copied by creation, discovery or switching. Delayed responses and live events from another workspace MUST NOT overwrite the active workspace's context. These observable boundaries SHALL be verified against real Hub state, real workspace children and real terminals. Registration SHALL atomically retain the explicit parent/repository relationship and exact local branch identity, defaulting to stopped. Credentials and shared workspace configuration SHALL be managed only on the parent and inherited live; parent updates SHALL propagate without child overrides or child credential/settings forms. Parent policy SHALL be disclosed, not implemented by copying secrets or adopting ambient credentials. Every surface that reports a child's credential policy SHALL report its parent's effective assignments and name the parent they are inherited from, rather than presenting the child's own empty assignment record as an absence of credentials. Assignments SHALL be recorded only against the workspace that owns the policy: a request to assign or unassign a credential that names a linked worktree SHALL be refused with a conflict naming that parent, before any workspace is stopped on the request's behalf, so no assignment is recorded against a child and a refused request costs a running child nothing. Checkout runtime and personal/per-device UI state MUST remain separate. Creation MUST NOT copy uncommitted or ignored source files, install dependencies, implicitly execute setup scripts, or claim security isolation; it SHALL explain that Git hooks/filters and later project configuration may execute.

#### Scenario: Source workspace remains unchanged
- **WHEN** a new worktree workspace is created and explicitly started
- **THEN** its terminal and agents use the new checkout and the source workspace's conversations and selection remain unchanged

#### Scenario: Parent policy changes after creation
- **WHEN** a user changes credential assignments or shared workspace configuration on the main parent
- **THEN** its children reflect the updated parent policy without child overrides or copied secrets
- **AND** their files, selected documents/conversations, terminal sessions, running state and personal/device preferences remain independent

#### Scenario: Parent configuration does not require parent runtime
- **WHEN** main Stop is requested while a child is running
- **THEN** only main stops; the child remains running
- **WHEN** a child is started while main is stopped
- **THEN** child start is permitted without starting main; parent remains the live configuration owner, not a runtime prerequisite

#### Scenario: Round trip restores each checkout's context
- **WHEN** a user selects a document and conversation in one workspace, switches through the existing picker to another workspace, and returns using the picker or browser back/forward
- **THEN** each destination restores its own file selection, preview, terminal context and selected conversation
- **AND** neither workspace acquires or replaces the other's conversations

#### Scenario: Late response cannot leak across workspaces
- **WHEN** a response or live event for a previously active workspace arrives after switching to another
- **THEN** the active workspace's files, preview, terminal and chat remain scoped to its own identity

#### Scenario: First start fails
- **WHEN** registration and assignments succeed but an explicitly requested start fails
- **THEN** the configured workspace remains stopped and the user can retry start without creating another checkout

#### Scenario: A child's row discloses the parent's credentials
- **WHEN** the Hub dashboard lists a linked worktree whose parent holds authentication and signing assignments
- **THEN** the child's row summarises the parent's assigned credential names and states that they are inherited, naming the parent
- **AND** a child of a parent that holds no assignments reads as having none, still naming the parent it inherits from
- **AND** a workspace that owns its own policy summarises its own assignments with no inheritance note

#### Scenario: An assignment naming a child is refused
- **WHEN** a request assigns a credential to a linked worktree, replaces that worktree's assignments, or unassigns a credential from it
- **THEN** the Hub refuses the request with a conflict that names the parent workspace holding the policy
- **AND** no assignment is recorded against the child, while the same request naming the parent is accepted
- **AND** a refused removal that asked to stop the workspace leaves the child running, with no session stopped
