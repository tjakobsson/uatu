## MODIFIED Requirements

### Requirement: Chat adapts to the desktop split, touch, and software-keyboard viewports
In desktop mode Preview and Chat SHALL be co-visible primary surfaces sharing
the main work area alongside the existing sidebar and independently dockable
terminal; there SHALL NOT be a mode that replaces Preview with Chat.
Collapsing, expanding, or resizing the Chat panel MUST NOT remount either
surface or lose its state. In touch mode Chat SHALL occupy its own
full-screen tab surface. The composer SHALL remain reachable above the visual
viewport and safe-area inset while the software keyboard is present, and
keyboard opening, resizing, or dismissal MUST NOT hide the input or cause the
current reading position to jump.

The touch surface's geometry SHALL follow the viewport that is actually
visible. It SHALL be re-derived whenever the page returns to the foreground
and not only when the platform announces a viewport change, so a keyboard
dismissed while the app was backgrounded leaves no keyboard-sized surface
behind and the user does not have to open and dismiss the keyboard to recover
the full height. Detection of the software keyboard SHALL hold on platforms
that pan the page under the keyboard rather than only shrinking it.

While the keyboard is present the pinned progress tracks SHALL yield so the
composer stays inside the visible viewport, and every pinned track that can
grow SHALL be bounded, so no combination of populated and expanded tracks can
push the composer out of view. Moving the text caret inside a chat text
control MUST NOT move the conversation's reading position, even when the
platform pans the viewport to follow the caret. A reading-position correction
withheld while the page is hidden SHALL be applied once the page is visible
again rather than dropped.

While a text control that belongs to a request has focus on a touch device,
the surface SHALL give the transcript the visible band: chrome that cannot be
used while the keyboard is open SHALL sit beneath the keyboard rather than
above it, so the band above the keyboard belongs to the transcript and the
request; it SHALL reappear as the keyboard dismisses; the transcript SHALL keep enough scroll room below its last entry that a request at the end of the conversation can still be lifted above the keyboard. The focused control
SHALL be kept inside the visible viewport once the keyboard geometry has
settled. Focusing that control MUST NOT change the page's scale. When focus
leaves the request, the surface SHALL return to its normal arrangement.

#### Scenario: Preview updates while the conversation stays visible
- **WHEN** a desktop user prompts the agent and it modifies the currently
  previewed document
- **THEN** the live preview updates while the conversation, its streaming
  output, and the composer remain visible

#### Scenario: Desktop collapse and reopen preserves both surfaces
- **WHEN** a desktop user collapses the Chat panel and reopens it
- **THEN** the same conversation, draft, loaded history, and reading position
  are retained
- **AND** the Preview document and scroll position are unchanged
- **AND** terminal attachment and visibility are unchanged

#### Scenario: iPhone keyboard keeps composer visible
- **WHEN** a touch user focuses the Chat composer and the software keyboard
  reduces the visual viewport
- **THEN** the composer remains fully visible above the keyboard and bottom
  safe area
- **AND** the timeline resizes without placing the active content behind the
  composer

#### Scenario: Returning from the background restores the surface
- **WHEN** a touch user focuses the composer, backgrounds the app with the
  keyboard open, and returns to it with the keyboard dismissed and no
  viewport-change notification from the platform
- **THEN** the Chat surface again fills the visible viewport with no
  keyboard-sized strip below it
- **AND** the composer is reachable without opening and dismissing the
  keyboard again
- **AND** the conversation shows the reading position it held

#### Scenario: A panned keyboard is still a keyboard
- **WHEN** the software keyboard opens on a device that pans the page upward,
  so the strip occluded below the visible viewport is smaller than the
  keyboard itself
- **THEN** Chat treats the keyboard as present
- **AND** the pinned progress tracks give up their rows as they do when the
  keyboard shrinks the viewport without panning

#### Scenario: Pinch zoom is not a software keyboard
- **WHEN** the browser magnifies the page and reduces the visual viewport at a
  non-default scale
- **THEN** Chat retains its last normal-scale layout and keyboard state without
  treating the zoom as a keyboard or correcting the browser's zoom pan
- **AND** normal viewport measurement resumes when the scale returns to normal

#### Scenario: Expanded progress tracks cannot displace the composer
- **WHEN** the task list, the subagent list, and the background-task list are
  all populated and expanded while the keyboard is open
- **THEN** the composer and its send control remain inside the visible
  viewport
- **AND** the transcript absorbs the reduction instead of the composer

#### Scenario: Moving the caret does not move the conversation
- **WHEN** a touch user moves the text caret inside the composer or a
  request's answer field and the platform pans the visible viewport to follow
  it
- **THEN** the conversation's reading position is unchanged
- **AND** repeated pans during one caret movement do not each reposition the
  transcript

#### Scenario: The transcript holds still while an answer is typed
- **WHEN** a touch user has a request's answer field focused and the platform
  autoscrolls the transcript while the caret is dragged
- **THEN** the transcript returns to the position that keeps the field in view
- **AND** it scrolls freely again once the field loses focus

#### Scenario: Resolving a focused answer removes the answering state
- **WHEN** answering, rejecting, or a remote update removes a focused request
  field, including on a browser that emits no focusout for a removed node
- **THEN** the editing and answering state is cleared and the detached field no
  longer holds the transcript
- **AND** the normal tabs and chrome return and the transcript can scroll freely

#### Scenario: Answering temporarily preserves the reader's follow choice
- **WHEN** a reader following the newest content answers a request and its
  temporary positioning hold ends
- **THEN** following resumes for the agent's next message
- **AND** a reader who was already reading older content is not forced to follow
- **AND** an explicit transcript gesture or Latest action ends the answer hold

#### Scenario: A live refresh preserves an actual answer hold
- **WHEN** an authoritative snapshot refresh cancels pending scroll work while a
  focused request field is held in its parent or drill-down timeline
- **THEN** the retained field is held again after the refresh
- **AND** a hold already ended by explicit reader action is not resurrected

#### Scenario: Dragging a question choice scrolls the conversation
- **WHEN** an upward transcript drag starts on a radio or checkbox choice
- **THEN** following pauses as it does for the same drag starting on its label
- **AND** caret gestures inside text-editing controls do not pause following

#### Scenario: A keyboard resize and pan together keep the answer visible
- **WHEN** a touch user is answering a request and the visual viewport's height
  and offset change together while the chat surface retains its layout height
- **THEN** the focused field and its submit and cancel controls are repositioned
  inside the new visible band without waiting for another viewport notification
- **AND** a subsequent pan with no height change does not reposition the transcript

#### Scenario: A direct focus transfer holds the new answer field
- **WHEN** focus moves directly between two independently answerable request
  fields without leaving the answering state
- **THEN** subsequent platform autoscroll is corrected for the newly focused
  field rather than the previous field
- **AND** the previous field's timeline hold is released

#### Scenario: Returning with retained answer focus restores the hold
- **WHEN** the app returns from the background with a request's answer field
  still focused and without a new focus event
- **THEN** the field's timeline hold is restored in its parent or drill-down
  transcript
- **AND** later caret autoscroll is corrected after foreground recovery settles

#### Scenario: Answering a request on touch puts the chrome under the keyboard
- **WHEN** a touch user focuses a request's free-form answer field and the
  software keyboard opens while the task, subagent and background-task tracks
  are populated and the conversation has a composer
- **THEN** the composer and the pinned tracks lie beneath the keyboard's edge
  rather than above it
- **AND** the chat header remains visible
- **AND** the answer field and the request's submit and cancel controls are
  inside the visible viewport
- **AND** the field and its submit and cancel controls sit directly above the
  keyboard's edge, with the conversation filling the band above them
- **AND** the composer and the pinned tracks are back above the keyboard's
  former edge once it dismisses

#### Scenario: A parent request pill cannot override child answer clearance
- **WHEN** a parent request is outstanding while a child request is answered in
  the pushed drill-down with the keyboard open
- **THEN** the answering keyboard inset takes precedence over the pill's normal
  reservation even if the pill's hidden attribute is unset
- **AND** the child's field and action row remain above the keyboard

#### Scenario: Focusing the answer field does not zoom the page
- **WHEN** a touch user focuses a request's free-form answer field
- **THEN** the page's scale is unchanged
- **AND** the field's text renders at the same size as the composer's

### Requirement: Users can resolve agent interaction requests in context
An unresolved OpenCode permission request SHALL appear in the conversation that raised it with the approval and rejection choices OpenCode supports for it: approving the single occurrence, approving persistently, and rejecting. Where a permission would change a file, the request SHALL show what it would change — the pending diff — where the choice is made, so the user sees the change before allowing it. A permission with nothing to show a diff for is unaffected. A structured OpenCode question SHALL render its prompt, options, multi-selection behavior, and free-form response when supported. A resolved request SHALL become non-interactive and record its outcome. A resolved request SHALL also recede: its outcome stays legible where the request was raised, but it MUST NOT keep the footprint it held while it needed an answer, and what it named SHALL stay reachable from the receded form. Submitting a response more than once MUST NOT produce multiple provider replies.

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

#### Scenario: Recovered and live announcements do not double up
- **WHEN** a pending request is recovered on load and OpenCode also announces it over the event stream
- **THEN** the conversation shows one entry for that request

#### Scenario: Reconciliation failure preserves what is already shown
- **WHEN** the server cannot read OpenCode's pending set while loading a conversation
- **THEN** requests already known to the conversation remain visible and answerable
