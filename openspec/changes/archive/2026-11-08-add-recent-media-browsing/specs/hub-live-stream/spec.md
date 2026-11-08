## MODIFIED Requirements

### Requirement: A hub-served page holds exactly one live connection
A hub-served page SHALL receive every pushed update, including document state, conversation inventory/events, subagent transcripts, and cross-workspace activity, over one authenticated SSE connection. Selecting a conversation, opening a transcript, opening/collapsing Chat, or switching preview MUST NOT create another pushed-update connection. Terminal WebSockets and finite, independently cancellable media GET/HEAD/range responses are outside this guarantee; media bytes MUST NOT enter SSE. A page hidden from view SHALL release its live connection while retaining subscriptions and cursors, and resume topics from them when visible. A page initially opened hidden SHALL wait until visible to connect. Streams SHALL carry only workspaces authorized for the authenticated user.

#### Scenario: A page with everything open holds one stream
- **WHEN** a page has Chat, a conversation, a child transcript, and a preview open
- **THEN** it holds one SSE connection for pushed updates

#### Scenario: Background tabs do not exhaust the browser
- **WHEN** six or more workspace tabs exist with only one visible
- **THEN** hidden tabs hold no live-update connection
- **AND** ordinary visible-tab requests do not wait for a hidden tab's live stream to close

#### Scenario: A background tab resumes where it was left
- **WHEN** a hidden workspace tab becomes visible
- **THEN** its one replacement stream resumes retained topic cursors without losing its preview, draft, or timeline

#### Scenario: A tab opened in the background waits to connect
- **WHEN** a workspace tab is opened hidden
- **THEN** its live stream waits until the page is shown

#### Scenario: Terminals do not count
- **WHEN** several terminal panes are attached
- **THEN** the page still has one pushed-update SSE connection independently of terminal WebSockets

#### Scenario: Seeking does not add another update stream
- **WHEN** a video plays or seeks through media range requests
- **THEN** the page retains one pushed-update stream and media bytes travel only in the independent HTTP responses
- **AND** cancelling a media request does not close the live stream
