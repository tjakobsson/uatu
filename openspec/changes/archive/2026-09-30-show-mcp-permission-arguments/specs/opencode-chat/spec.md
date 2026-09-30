## MODIFIED Requirements

### Requirement: Users can resolve agent interaction requests in context
An unresolved OpenCode permission request SHALL appear in the conversation that raised it with the approval and rejection choices OpenCode supports for it: approving the single occurrence, approving persistently, and rejecting. Where a permission would change a file, the request SHALL show what it would change — the pending diff — where the choice is made, so the user sees the change before allowing it. A permission with nothing to show a diff for is unaffected. A structured OpenCode question SHALL render its prompt, options, multi-selection behavior, and free-form response when supported. A resolved request SHALL become non-interactive and record its outcome. A resolved request SHALL also recede: its outcome stays legible where the request was raised, but it MUST NOT keep the footprint it held while it needed an answer, and what it named SHALL stay reachable from the receded form. Submitting a response more than once MUST NOT produce multiple provider replies.

A permission that names no specific resource, whose request carries only a wildcard as OpenCode's request to call an MCP tool does, SHALL show the arguments of the tool call it would allow, where the choice is made, so the user sees what the call does before allowing it. The arguments SHALL be those of the tool call the permission belongs to, as the conversation already shows them; the surface MUST NOT invent, summarize, or reorder them. When that call cannot be found in the conversation, the request SHALL show what OpenCode sent, unchanged. A permission for an MCP tool SHALL name the MCP server and the tool as the user registered them with OpenCode, distinguished from the built-in tools, so the user can tell which server is being granted what; the action name OpenCode sent SHALL remain what the persistent-approval confirmation names, since it is the rule OpenCode installs. When the server cannot be identified among the servers OpenCode reports, the request SHALL show the action as sent. A permission naming a specific resource, carrying a diff, or carrying a plan is unaffected. Like the diff, the arguments are shown while the request is open; the resolved request recedes to its outcome and the resources OpenCode named, as any other permission does. The arguments SHALL be shown for a request recovered from OpenCode's pending set as for one announced live.

A request raised by a subagent SHALL additionally appear in the conversation that launched that subagent, and SHALL be answerable there. The subagent's own conversation remains the single owner of the request: an answer given from the launching conversation SHALL be directed to the owning conversation, so exactly one response reaches OpenCode however many places the request was shown. Resolving it SHALL resolve it everywhere it appears.

When a subagent-owned request appears outside its owning transcript, the request SHALL identify the specific launching subagent from the best available structured attribution and SHALL offer direct navigation to the owning transcript. If the specific attribution has not arrived or cannot be resolved, the request MUST use a truthful generic subagent label rather than inventing an identity, while retaining transcript navigation whenever the agent supports subagent transcripts. The origin and transcript control SHALL remain available after resolution so the decision can be audited. A conversation's own requests MUST NOT be labeled as coming from a subagent.

Only the active unresolved request of a given conversation MAY accept a response. Where requests from more than one conversation are shown together, they SHALL each be governed by the conversation that owns them, so a request awaiting a user in one conversation does not block answering a request owned by another.

A request's state SHALL be distinguishable without reading its body — whether it awaits the user now, awaits its turn behind another request of the same conversation, or is resolved. That distinction MUST NOT rely on colour alone. A request awaiting its turn MUST NOT be presented as obsolete, superseded, or otherwise not needing an answer, because it will require one.

The surface SHALL report how many requests are outstanding across everything it is showing, and SHALL offer a way to reach an outstanding request without hunting for it. That report, and any other control the surface floats over the conversation, MUST NOT cover a request's own answer field or its submit and cancel controls; the conversation SHALL reserve room for them so an outstanding request shown at the end of the transcript stays fully operable. The report SHALL NOT be shown while a request it would lead to is already on screen; when it is shown, its count remains that of every outstanding request.

Revealing a request's free-form answer field SHALL hold the conversation's position on the request being answered, so the request does not scroll out of view as the user starts to answer it.

A choice that grants authority beyond the request being answered SHALL state the scope and lifetime of that authority where the choice is offered, so a user learns what they are granting before granting it rather than afterwards. In particular, OpenCode's persistent approval carries past the answered request into later conversations served by the same OpenCode instance and covers the request's saved pattern rather than only the resource displayed, and it is lost when that instance restarts. It MUST NOT be presented as limited to the current conversation, nor as permanent, nor as outliving the OpenCode instance that granted it.

Choosing the persistent approval SHALL NOT send a reply. It SHALL open a confirmation step on the same request that lists the future-approval patterns OpenCode supplied for that request, the patterns its persistent reply installs, verbatim and apart from the request's own resources, so the user can see where the two differ. The surface MUST NOT derive or shorten a pattern from the displayed command; a request whose patterns are unknown SHALL say so rather than present the command as the scope. The patterns SHALL be carried on the request wherever it is shown, including a request recovered from OpenCode's pending set after its live announcement was missed.

A pending request SHALL remain discoverable and answerable even when the server did not observe its live announcement — because the event stream was interrupted, restarted, or the conversation was not being tracked at the time. Loading a conversation SHALL reconcile its unresolved requests against OpenCode's own pending set, so a request that OpenCode is still waiting on is never permanently invisible.

#### Scenario: Permission is approved once
- **WHEN** OpenCode requests permission for a command and the user chooses one-time approval
- **THEN** the response is sent once to the matching pending request
- **AND** the card records that the request was approved for that occurrence

#### Scenario: An edit permission shows its diff before approval
- **WHEN** a pending permission would change a file
- **THEN** the card shows the change it would apply
- **AND** the diff is shown where the approve and reject choices are

#### Scenario: A non-edit permission shows no diff
- **WHEN** a pending permission has no file change to show
- **THEN** the card presents its choices without a diff

#### Scenario: An MCP tool permission shows the call's arguments
- **WHEN** OpenCode asks permission to call an MCP tool, naming only a wildcard resource, and the conversation holds that call with its arguments
- **THEN** the card shows those arguments where the approve and reject choices are
- **AND** the card names the MCP server and the tool, apart from the built-in tools
- **AND** no bare wildcard stands in for the arguments

#### Scenario: The persistent-approval confirmation keeps OpenCode's own action name
- **WHEN** the user chooses the persistent approval on an MCP tool permission
- **THEN** the confirmation names the action as OpenCode sent it, the rule it will install

#### Scenario: An MCP permission whose server cannot be identified keeps the action as sent
- **WHEN** a pending permission's action matches none of the MCP servers OpenCode reports
- **THEN** the card shows the action as OpenCode sent it

#### Scenario: A wildcard permission whose call is not in the conversation
- **WHEN** a pending permission names only a wildcard resource and the conversation holds no tool call it belongs to
- **THEN** the card shows the request as OpenCode sent it, with its choices

#### Scenario: A permission naming a specific resource adds no arguments
- **WHEN** a pending permission names a command, a file, or another specific resource
- **THEN** the card shows that resource as before
- **AND** it does not add the tool call's arguments beside it

#### Scenario: A resolved MCP permission recedes like any other
- **WHEN** a permission that showed a call's arguments has been answered
- **THEN** its receded form records the outcome and the resources OpenCode named, without the arguments block
- **AND** the arguments remain readable on the tool row the call ran as

#### Scenario: An answered request recedes
- **WHEN** a permission or question has been answered
- **THEN** what was asked and what was decided remain legible
- **AND** the request occupies less of the transcript than it did while it needed an answer
- **AND** the resources it named remain reachable from it

#### Scenario: A subagent's request reaches the conversation that launched it
- **WHEN** a subagent raises a permission request while its parent conversation is open
- **THEN** the request appears in the parent conversation
- **AND** it is answerable there without first opening the subagent's transcript

#### Scenario: A surfaced request identifies its subagent and opens its transcript
- **WHEN** a subagent-owned permission or question appears in its launching conversation and structured attribution is available
- **THEN** the request identifies that subagent
- **AND** offers a direct control that opens the owning transcript without changing the selected parent conversation

#### Scenario: Missing attribution uses a truthful fallback
- **WHEN** a subagent-owned request appears before its specific attribution can be resolved
- **THEN** the request states that it came from a subagent without inventing a name or description
- **AND** still offers transcript navigation when subagent transcripts are supported

#### Scenario: Request provenance remains auditable after resolution
- **WHEN** a surfaced subagent request has been answered
- **THEN** its receded form retains the subagent origin and transcript control

#### Scenario: A conversation's own request has no foreign origin
- **WHEN** a permission or question belongs to the conversation currently being shown
- **THEN** it is not labeled as a subagent request
- **AND** no redundant transcript control is added to it

#### Scenario: Answering a subagent's request from the parent replies once
- **WHEN** the user answers a subagent's request from the parent conversation
- **THEN** OpenCode receives exactly one response, for the subagent's conversation
- **AND** the request shows as resolved in both the parent and the subagent's transcript

#### Scenario: Requests owned by different conversations do not block each other
- **WHEN** a parent conversation has its own pending request and a subagent's pending request is shown alongside it
- **THEN** both are answerable
- **AND** answering one does not change whether the other can be answered

#### Scenario: A request needing an answer is distinguishable at a glance
- **WHEN** a conversation shows requests that need an answer, requests awaiting their turn, and resolved requests
- **THEN** each state is distinguishable without reading the card body
- **AND** the distinction is carried by something other than colour alone

#### Scenario: A queued request is not described as obsolete
- **WHEN** a pending request is not yet answerable because another request of the same conversation is active
- **THEN** it is presented as awaiting its turn
- **AND** it is not presented as superseded, obsolete, or resolved

#### Scenario: Outstanding requests are counted and reachable
- **WHEN** one or more requests are outstanding in what the surface is showing
- **THEN** the surface reports how many are outstanding
- **AND** offers a way to reach an outstanding request directly
- **AND** reports none once every request has been answered

#### Scenario: The outstanding-request report does not cover an answer
- **WHEN** a request at the end of the conversation shows its answer field and submit and cancel controls while the surface reports outstanding requests
- **THEN** the report does not overlap that field or those controls
- **AND** each of them can be activated directly where it appears

#### Scenario: The outstanding-request report yields to a visible request
- **WHEN** the only outstanding request's card is within the visible part of the conversation
- **THEN** the report is not shown
- **AND** it reappears once the card is scrolled out of view while the request is still outstanding

#### Scenario: Revealing a free-form answer holds the request in view
- **WHEN** the user chooses a request's free-form answer and its field is revealed and focused
- **THEN** the request being answered stays in view
- **AND** the conversation does not reposition onto a different entry

#### Scenario: User rejects a structured question
- **WHEN** OpenCode asks a structured question and the user rejects or dismisses it
- **THEN** OpenCode receives one rejection response
- **AND** the resolved card can no longer submit an answer

#### Scenario: Stale request response is refused
- **WHEN** a client attempts to answer a request that is already resolved or no longer active
- **THEN** the server rejects it without forwarding another response to OpenCode

#### Scenario: Persistent approval states the authority it grants
- **WHEN** a permission request offers the persistent approval choice
- **THEN** the surface states that choosing it reaches beyond this conversation and beyond this exact request, and that it lasts until OpenCode restarts
- **AND** it is not described as applying only to this conversation, nor as permanent

#### Scenario: The confirmation shows OpenCode's pattern, not the command
- **WHEN** OpenCode requests permission for `git status --short` and supplies `git status *` as its future-approval pattern, and the user chooses the persistent approval
- **THEN** no reply is sent
- **AND** the confirmation lists `git status *` as what will be allowed
- **AND** the request's own resource `git status --short` remains visible apart from that list

#### Scenario: Persistent approval is still sent as OpenCode's persistent reply
- **WHEN** the user confirms the persistent approval
- **THEN** OpenCode receives its persistent-approval reply once for that request
- **AND** the recorded outcome is unchanged from before this correction

#### Scenario: Patterns are announced under either naming generation
- **WHEN** OpenCode announces a request's future-approval patterns under its current or its legacy event name
- **THEN** the request carries those patterns
- **AND** a request announced under both carries them once

#### Scenario: A request missed by the event stream is recovered on load
- **WHEN** OpenCode raised a permission request while the server's event stream was interrupted, and the user then opens that conversation
- **THEN** the pending request appears and can be answered
- **AND** answering it resolves the request OpenCode is waiting on
- **AND** its persistent approval confirms with the future-approval patterns OpenCode reports for it
- **AND** a wildcard-only request shows the arguments of the call it belongs to, as the live announcement would have

#### Scenario: Recovered and live announcements do not double up
- **WHEN** a pending request is recovered on load and OpenCode also announces it over the event stream
- **THEN** the conversation shows one entry for that request

#### Scenario: Reconciliation failure preserves what is already shown
- **WHEN** the server cannot read OpenCode's pending set while loading a conversation
- **THEN** requests already known to the conversation remain visible and answerable

### Requirement: Chat serves whichever OpenCode generation the workspace has installed
UatuCode SHALL converse through an OpenCode 1.x server and through an OpenCode 2.x server with the same Chat surface, the same agent identity, and the same conversation operations. The generation is a property of the spawned server, decided by its readiness answer, and SHALL be fixed for that server's lifetime; a later start — a retry, a restart after an unexpected exit — SHALL decide again, so a binary replaced on disk is served by the matching generation without a workspace restart. Conversation identifiers, capability declarations, and the chat routes SHALL NOT change form between generations; a capability the running generation cannot back SHALL be left undeclared rather than declared and broken.

Normalization SHALL recognize each generation's event vocabulary — 1.x's cumulative and incremental announcements and 2.x's typed session events — and produce the same ordered conversation events for the same activity: text and reasoning, tool lifecycle, shell commands, permission requests and replies, structured questions and their answers, compaction, staged and committed reverts, usage, turn status, cancellation, completion, and errors. A 2.x structured form SHALL be presented as a structured question: each field becomes one question, a field with options offers those options, a field allowing custom input offers a free-form answer, and answering or rejecting it sends exactly one reply to the form OpenCode is waiting on. Loading a conversation SHALL reconcile pending requests against the running generation's own pending sets — permission requests and forms on 2.x — so a request announced while the stream was interrupted is still answerable. A 2.x permission request names the tool call it belongs to; normalization SHALL carry that reference onto the request, from the live announcement and from the pending set alike, so the surface can show the call. A 1.x request that carries no such reference SHALL be unaffected by its absence. On either generation, a request whose action is an MCP tool's registered name SHALL carry the MCP server and tool it resolves to, resolved against the servers that generation reports, from the live announcement and from the pending set alike.

Every call to a 2.x server SHALL be scoped to the workspace directory, and events for another directory served by the same server MUST NOT reach the workspace's conversations.

#### Scenario: A 2.x workspace holds a conversation
- **WHEN** the workspace's `opencode` is a 2.x binary and the user creates a conversation, sends a prompt, and the agent runs a tool and answers
- **THEN** Chat becomes ready, the conversation streams the answer with its tool activity, and history reloads the same timeline

#### Scenario: A 1.x workspace is unchanged
- **WHEN** the workspace's `opencode` is a 1.x binary
- **THEN** Chat behaves as before this change, with the same declared capabilities

#### Scenario: A replaced binary is served by its own generation
- **WHEN** a 1.x server was running, exits, and the next start finds a 2.x binary on the search path
- **THEN** the restarted service is served as 2.x without restarting the workspace
- **AND** the reported version is the 2.x version

#### Scenario: A 2.x form is answered as a structured question
- **WHEN** a 2.x agent raises a form with a single-choice field, a multiple-choice field, and a free-text field
- **THEN** the conversation shows one structured question per field with the choices OpenCode supplied
- **AND** submitting the answers replies to the form once, and the agent continues

#### Scenario: A 2.x form is rejected
- **WHEN** the user rejects a structured question raised as a 2.x form
- **THEN** OpenCode's form is cancelled once and the request records its outcome

#### Scenario: A 2.x permission is approved persistently
- **WHEN** a 2.x agent asks permission with saved patterns and the user chooses persistent approval
- **THEN** the confirmation lists the patterns OpenCode supplied for that request
- **AND** confirming sends OpenCode's persistent reply once

#### Scenario: A 2.x MCP permission is tied to its tool call
- **WHEN** a 2.x agent asks permission to call an MCP tool and names the tool call the request belongs to
- **THEN** the request carries that call's reference
- **AND** the request carries the MCP server and tool the action resolves to
- **AND** the card shows the call's arguments

#### Scenario: A 2.x request missed by the stream is recovered on load
- **WHEN** a 2.x server raised a permission request or a form while the event stream was interrupted, and the user then opens that conversation
- **THEN** the pending request appears and can be answered
- **AND** a recovered permission that names its tool call carries that reference

#### Scenario: Another directory's activity on a 2.x server stays out
- **WHEN** a 2.x server announces events for a session in a directory other than the workspace's
- **THEN** no conversation in the workspace changes

#### Scenario: A 2.x event the server does not handle is counted, not fatal
- **WHEN** a 2.x server emits an event type normalization does not handle
- **THEN** the event is skipped and counted by type, and later events are delivered
