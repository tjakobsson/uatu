## MODIFIED Requirements

### Requirement: Chat presents turns as readable conversation with inspectable activity
The web Chat surface SHALL render user prompts and streamed assistant Markdown as the primary conversation, with safe code rendering consistent with UatuCode's existing rendering posture. Reasoning, tool calls, command execution, file changes, and tool results SHALL be represented as subordinate, inspectable activity with running, completed, failed, and cancelled states rather than flattened into assistant prose. While a tool or command runs, its output SHALL be shown as it streams rather than only on completion, so long-running activity shows progress. A finished tool or command's output SHALL be bounded - presented as a summary and a bounded preview with a way to see the rest - rather than shown whole or hidden whole. A command that completes before the surface renders a running update MUST still retain inspectable output and its provider-reported completion or failure state. Untrusted Markdown, tool output, filenames, and errors MUST NOT create active markup or script execution.

#### Scenario: Assistant answer remains visually primary
- **WHEN** a turn contains assistant text interleaved with multiple tool calls
- **THEN** the answer reads as a coherent conversation
- **AND** tool activity can be expanded for detail without being mistaken for assistant prose

#### Scenario: Streaming tool lifecycle updates in place
- **WHEN** a tool moves from running to completed or failed
- **THEN** its existing activity entry updates state instead of adding a duplicate entry

#### Scenario: A running tool shows its output as it streams
- **WHEN** a tool is running and the agent streams its output
- **THEN** the surface shows that output as it arrives
- **AND** it updates the tool's existing entry in place

#### Scenario: A running shell command shows its output as it streams
- **WHEN** the agent reports rolling output for a running shell command
- **THEN** the command entry shows the latest output without waiting for completion
- **AND** later output updates the same command entry

#### Scenario: A fast command retains its completed output
- **WHEN** a shell command completes before the client observes a running update
- **THEN** its completed output remains inspectable from the command entry
- **AND** the entry reports the provider's completed or failed outcome

#### Scenario: A finished tool's output is bounded with a way to see the rest
- **WHEN** a completed tool produced more output than the bounded preview shows
- **THEN** the entry shows a summary and a bounded preview
- **AND** offers a way to see the full output
- **AND** does not render the whole output by default

#### Scenario: A finished command's output is bounded with a way to see the rest
- **WHEN** a completed shell command produced more output than the bounded preview shows
- **THEN** the command entry shows a bounded preview
- **AND** offers a way to see the full output

#### Scenario: Hostile content remains inert
- **WHEN** assistant Markdown or tool output contains script-capable markup or a JavaScript URL
- **THEN** the rendered conversation does not execute it or expose an active unsafe link

### Requirement: Users can resolve agent interaction requests in context
An unresolved OpenCode permission request SHALL appear in the conversation that raised it with the approval and rejection choices OpenCode supports for it: approving the single occurrence, approving persistently, and rejecting. Where a permission would change a file, the request SHALL show what it would change - the pending diff - where the choice is made, so the user sees the change before allowing it. A permission with nothing to show a diff for is unaffected. A structured OpenCode question SHALL render its prompt, options, multi-selection behavior, and free-form response when supported. A resolved request SHALL become non-interactive and record its outcome. A resolved request SHALL also recede: its outcome stays legible where the request was raised, but it MUST NOT keep the footprint it held while it needed an answer, and what it named SHALL stay reachable from the receded form. Submitting a response more than once MUST NOT produce multiple provider replies.

A request raised by a subagent SHALL additionally appear in the conversation that launched that subagent, and SHALL be answerable there. The subagent's own conversation remains the single owner of the request: an answer given from the launching conversation SHALL be directed to the owning conversation, so exactly one response reaches OpenCode however many places the request was shown. Resolving it SHALL resolve it everywhere it appears.

When a subagent-owned request appears outside its owning transcript, the request SHALL identify the specific launching subagent from the best available structured attribution and SHALL offer direct navigation to the owning transcript. If the specific attribution has not arrived or cannot be resolved, the request MUST use a truthful generic subagent label rather than inventing an identity, while retaining transcript navigation whenever the agent supports subagent transcripts. The origin and transcript control SHALL remain available after resolution so the decision can be audited. A conversation's own requests MUST NOT be labeled as coming from a subagent.

Only the active unresolved request of a given conversation MAY accept a response. Where requests from more than one conversation are shown together, they SHALL each be governed by the conversation that owns them, so a request awaiting a user in one conversation does not block answering a request owned by another.

A request's state SHALL be distinguishable without reading its body - whether it awaits the user now, awaits its turn behind another request of the same conversation, or is resolved. That distinction MUST NOT rely on colour alone. A request awaiting its turn MUST NOT be presented as obsolete, superseded, or otherwise not needing an answer, because it will require one.

The surface SHALL report how many requests are outstanding across everything it is showing, and SHALL offer a way to reach an outstanding request without hunting for it.

A choice that grants authority beyond the request being answered SHALL state the scope and lifetime of that authority where the choice is offered, so a user learns what they are granting before granting it rather than afterwards. In particular, OpenCode's persistent approval carries past the answered request into later conversations served by the same OpenCode instance and covers the request's saved pattern rather than only the resource displayed, and it is lost when that instance restarts. It MUST NOT be presented as limited to the current conversation, nor as outliving the OpenCode instance that granted it.

A pending request SHALL remain discoverable and answerable even when the server did not observe its live announcement - because the event stream was interrupted, restarted, or the conversation was not being tracked at the time. Loading a conversation SHALL reconcile its unresolved requests against OpenCode's own pending set, so a request that OpenCode is still waiting on is never permanently invisible.

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

#### Scenario: Persistent approval is still sent as OpenCode's persistent reply
- **WHEN** the user chooses persistent approval
- **THEN** OpenCode receives its persistent-approval reply once for that request
- **AND** the recorded outcome is unchanged from before this correction

#### Scenario: A request missed by the event stream is recovered on load
- **WHEN** OpenCode raised a permission request while the server's event stream was interrupted, and the user then opens that conversation
- **THEN** the pending request appears and can be answered
- **AND** answering it resolves the request OpenCode is waiting on

#### Scenario: Recovered and live announcements do not double up
- **WHEN** a pending request is recovered on load and OpenCode also announces it over the event stream
- **THEN** the conversation shows one entry for that request

#### Scenario: Reconciliation failure preserves what is already shown
- **WHEN** the server cannot read OpenCode's pending set while loading a conversation
- **THEN** requests already known to the conversation remain visible and answerable

## ADDED Requirements

### Requirement: Chat supports reversible conversation undo and redo
When the connected agent declares reversible-history support, Chat SHALL offer local `/undo` and `/redo` commands that operate on the selected conversation and MUST NOT send those command strings as ordinary prompts or provider-defined slash commands. Undo SHALL stage the previous visible user turn as the conversation's revert boundary, hide that turn and all later work from the current transcript, and restore the affected workspace files through the agent's revert operation. The invoking client SHALL receive the reverted non-synthetic prompt text and any still-available attachments as an editable composer draft; other clients' private drafts MUST NOT be overwritten.

If work is running, Undo SHALL interrupt it before changing the boundary. Messages queued behind that work MUST NOT be admitted between interruption and the completed revert. Existing queued messages SHALL remain visible and removable but paused while a revert is staged; they SHALL resume only after Redo clears the revert or after the user submits a replacement prompt, with that replacement admitted before the older queue resumes.

Repeated Undo SHALL move the boundary backward one visible user turn at a time. Redo SHALL move it forward one hidden user turn at a time, restoring that turn to the invoking client's composer, and SHALL clear the staged revert when it advances past the newest hidden turn. Submitting a replacement prompt while a revert is staged SHALL commit the reverted history before starting the replacement turn, after which the hidden turns can no longer be restored by Redo.

Every successful boundary change SHALL reconcile the authoritative conversation so all connected clients agree on visible history and workspace state. Mutation retries MUST be idempotent. If interruption or the requested boundary change fails, Chat SHALL report the failure and MUST NOT claim that history or files changed.

#### Scenario: Undo and redo are offered only when supported
- **WHEN** the connected agent declares reversible-history support
- **THEN** Chat offers `/undo` and `/redo` as local commands
- **AND** invoking them does not send their text as an ordinary prompt or provider-defined command

#### Scenario: Unsupported agents do not expose reversible history
- **WHEN** the connected agent does not declare reversible-history support
- **THEN** Chat does not offer Undo or Redo controls
- **AND** a direct request to mutate the revert boundary is refused without changing the conversation

#### Scenario: Undo restores the latest user turn for editing
- **WHEN** the user invokes Undo with no revert currently staged
- **THEN** the latest visible user turn and all later work disappear from the visible transcript
- **AND** affected workspace files return to their state before that turn
- **AND** the invoking client's composer receives the turn's non-synthetic text and available attachments

#### Scenario: Undo interrupts active work before reverting
- **WHEN** the user invokes Undo while the selected conversation is running
- **THEN** the active turn is interrupted before the revert boundary changes
- **AND** no queued message is admitted during that transition

#### Scenario: Queued messages pause behind a staged revert
- **WHEN** Undo succeeds while messages are queued
- **THEN** the queued messages remain visible and removable
- **AND** none is delivered while the revert remains staged

#### Scenario: Repeated Undo walks backward by user turn
- **WHEN** a revert is staged and the user invokes Undo again
- **THEN** the boundary moves to the preceding visible user turn
- **AND** the invoking client's composer receives that earlier turn for editing

#### Scenario: Redo walks forward through hidden turns
- **WHEN** more than one user turn is hidden behind a staged revert and the user invokes Redo
- **THEN** the boundary advances to the next hidden user turn
- **AND** that turn becomes the invoking client's editable composer draft

#### Scenario: Redo clears the newest boundary
- **WHEN** the boundary is at the newest hidden user turn and the user invokes Redo
- **THEN** the staged revert is cleared
- **AND** the original transcript and workspace state become current again
- **AND** paused queued messages may resume

#### Scenario: A replacement prompt commits the reverted branch
- **WHEN** the user edits the restored draft and submits it while a revert is staged
- **THEN** the hidden history is committed as reverted before the replacement turn starts
- **AND** the replacement is admitted before previously queued messages resume
- **AND** Redo no longer restores the discarded branch

#### Scenario: Other clients reconcile without losing private drafts
- **WHEN** one client successfully changes the revert boundary
- **THEN** every connected client reconciles to the same visible conversation and workspace state
- **AND** only the invoking client's composer draft is replaced

#### Scenario: Retried undo does not move twice
- **WHEN** a client retries the same Undo mutation after losing its response
- **THEN** the conversation boundary changes at most once for that request

#### Scenario: Failed undo preserves current state
- **WHEN** interruption or the agent's revert operation fails
- **THEN** Chat reports the failure
- **AND** does not claim that the transcript, composer, queue, or workspace files were reverted

#### Scenario: Undo at the oldest boundary is harmless
- **WHEN** no earlier visible user turn exists and the user invokes Undo
- **THEN** Chat reports that there is nothing more to undo
- **AND** the current revert boundary and workspace state do not change

#### Scenario: Redo without a staged revert is harmless
- **WHEN** no revert is staged and the user invokes Redo
- **THEN** Chat reports that there is nothing to redo
- **AND** the conversation and workspace state do not change
