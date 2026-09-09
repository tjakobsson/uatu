## MODIFIED Requirements

### Requirement: Users can resolve agent interaction requests in context
An unresolved OpenCode permission request SHALL appear in the conversation that raised it with the approval and rejection choices OpenCode supports for it: approving the single occurrence, approving persistently, and rejecting. Where a permission would change a file, the request SHALL show what it would change — the pending diff — where the choice is made, so the user sees the change before allowing it. A permission with nothing to show a diff for is unaffected. A structured OpenCode question SHALL render its prompt, options, multi-selection behavior, and free-form response when supported. A resolved request SHALL become non-interactive and record its outcome. A resolved request SHALL also recede: its outcome stays legible where the request was raised, but it MUST NOT keep the footprint it held while it needed an answer, and what it named SHALL stay reachable from the receded form. Submitting a response more than once MUST NOT produce multiple provider replies.

A request raised by a subagent SHALL additionally appear in the conversation that launched that subagent, and SHALL be answerable there. The subagent's own conversation remains the single owner of the request: an answer given from the launching conversation SHALL be directed to the owning conversation, so exactly one response reaches OpenCode however many places the request was shown. Resolving it SHALL resolve it everywhere it appears.

When a subagent-owned request appears outside its owning transcript, the request SHALL identify the specific launching subagent from the best available structured attribution and SHALL offer direct navigation to the owning transcript. If the specific attribution has not arrived or cannot be resolved, the request MUST use a truthful generic subagent label rather than inventing an identity, while retaining transcript navigation whenever the agent supports subagent transcripts. The origin and transcript control SHALL remain available after resolution so the decision can be audited. A conversation's own requests MUST NOT be labeled as coming from a subagent.

Only the active unresolved request of a given conversation MAY accept a response. Where requests from more than one conversation are shown together, they SHALL each be governed by the conversation that owns them, so a request awaiting a user in one conversation does not block answering a request owned by another.

A request's state SHALL be distinguishable without reading its body — whether it awaits the user now, awaits its turn behind another request of the same conversation, or is resolved. That distinction MUST NOT rely on colour alone. A request awaiting its turn MUST NOT be presented as obsolete, superseded, or otherwise not needing an answer, because it will require one.

The surface SHALL report how many requests are outstanding across everything it is showing, and SHALL offer a way to reach an outstanding request without hunting for it.

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

#### Scenario: Recovered and live announcements do not double up
- **WHEN** a pending request is recovered on load and OpenCode also announces it over the event stream
- **THEN** the conversation shows one entry for that request

#### Scenario: Reconciliation failure preserves what is already shown
- **WHEN** the server cannot read OpenCode's pending set while loading a conversation
- **THEN** requests already known to the conversation remain visible and answerable

### Requirement: Persistent-approval scope copy is the owning agent's
When a permission card offers an approval that outlives the request, the sentence stating what that approval covers SHALL describe the owning agent's actual persistence semantics and SHALL name only that agent. Two agents with different semantics SHALL have different sentences.

Choosing that approval SHALL open a confirmation step on the card rather than reply. The confirmation SHALL name the action being authorized, list each future-approval pattern the owning agent supplied, verbatim and in that agent's own syntax, visibly apart from the request's own resources, and state the approval's lifetime in the owning agent's terms. The list SHALL be what the agent supplied; the surface MUST NOT derive it from the displayed request. When the agent supplied a single wildcard covering the whole permission, the confirmation SHALL state that every request of that action will be allowed, naming the action. When the agent supplied no reusable pattern, the confirmation SHALL state that confirming covers only this request. The confirmation SHALL offer explicit Confirm and Cancel choices; only Confirm SHALL send the persistent reply, once. Cancel, and Escape while the confirmation has keyboard focus, SHALL return the card to its pending choices without sending any reply and without changing the request's state. When the confirmation opens, keyboard focus SHALL move into it. If the request resolves while the confirmation is open, the card SHALL recede as a resolved request does. The single-occurrence approval, rejection, and agent-provided approval intents SHALL be unaffected.

#### Scenario: Each agent's card states its own reach
- **WHEN** a permission card is shown for a conversation owned by a given agent
- **THEN** its scope sentence describes that agent's persistent-approval lifetime
- **AND** no other agent is named on the card

#### Scenario: Choosing the persistent approval asks for confirmation
- **WHEN** the user chooses the persistent approval on a pending request
- **THEN** no reply is sent
- **AND** the card shows the action, the agent-supplied patterns apart from the request's resources, the agent's lifetime sentence, and Confirm and Cancel

#### Scenario: Confirm sends the persistent reply once
- **WHEN** the user chooses Confirm on the confirmation
- **THEN** the agent receives its persistent-approval reply exactly once
- **AND** the card records the persistent approval as it did before this change

#### Scenario: Cancel returns to the pending choices
- **WHEN** the user chooses Cancel on the confirmation
- **THEN** the card shows its pending choices again
- **AND** no reply has been sent and the request is still pending

#### Scenario: Escape cancels the confirmation
- **WHEN** the confirmation has keyboard focus and the user presses Escape
- **THEN** the card shows its pending choices again
- **AND** no reply has been sent

#### Scenario: A sole wildcard names the whole action
- **WHEN** the agent's only future-approval pattern is a wildcard covering the whole permission
- **THEN** the confirmation states that every request of that action will be allowed, naming the action
- **AND** it does not present the wildcard as though it were one command

#### Scenario: No reusable pattern is said plainly
- **WHEN** the agent supplied no future-approval pattern for the request
- **THEN** the confirmation states that confirming covers only this request
- **AND** it does not present the displayed command as the pattern

#### Scenario: A request resolved elsewhere closes its confirmation
- **WHEN** the request resolves while its confirmation is open
- **THEN** the card recedes as a resolved request
- **AND** Confirm and Cancel are no longer offered

#### Scenario: The other choices are unchanged
- **WHEN** the user chooses the single-occurrence approval, rejection, or an agent-provided approval intent
- **THEN** the reply is sent on that choice without a confirmation step
