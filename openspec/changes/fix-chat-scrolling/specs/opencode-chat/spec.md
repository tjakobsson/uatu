## MODIFIED Requirements

### Requirement: Timeline position remains stable under streaming and navigation

Chat timelines and shell viewports SHALL preserve reading anchors and independent follow intent through streaming, navigation, layout, and command lifecycle changes. Latest controls SHALL resume stable following; manual upward scrolling SHALL immediately pause it without moving unrelated views.

#### Scenario: Content streams, older history is prepended, activity expands, or a conversation opens
- **WHEN** the reader scrolls, submits a message, receives streaming content, prepends older history, expands activity, opens or navigates between conversation and task views, or reloads the client
- **THEN** The Chat timeline SHALL follow the latest content until the reader deliberately scrolls upward.
- **AND** Following SHALL resume when deliberate downward reader movement returns within 48 CSS pixels of the bottom, including the boundary, or the reader activates the accessible latest-content affordance.
- **AND** Once following is paused, streaming, message submission, tool updates, image or code layout, and activity expansion MUST NOT steal the reading position; the latest-content affordance SHALL indicate unseen updates and return to the end.
- **AND** Prepending older history SHALL preserve the same visible content and offset.
- **AND** During a client session, each conversation and task view SHALL retain its own reading anchor and follow state across navigation: paused views restore their reading position, following views catch up to latest, and first-time views open at latest.
- **AND** Existing client-local restoration across reloads remains supported where possible.

#### Scenario: The reader scrolls a shell viewport upward, returns to its bottom, or activates latest output
- **WHEN** a shell viewport first shows or receives output, the reader scrolls it upward, returns to its bottom, or activates latest output
- **THEN** Each shell viewport SHALL have a follow state independent of the outer timeline and other shell items.
- **AND** It SHALL initially follow the bottom.
- **AND** Any upward reader scroll SHALL stop following, including a movement smaller than a near-bottom threshold.
- **AND** Returning to the bottom or activating the viewport's accessible latest-output control SHALL resume following.
- **AND** Incoming output while following SHALL keep the bottom visible without resetting the horizontal offset.
- **AND** While following is paused, incoming output SHALL preserve the visible rendered content and its vertical offset, and the latest-output control SHALL indicate unseen output.

#### Scenario: Shell output or layout changes, its presentation changes, or its command completes or fails
- **WHEN** shell output or layout changes, its presentation changes, or its command completes or fails
- **THEN** Output updates, layout resize, inline height adjustment, Pop out, Maximize, Restore size, Return to chat, changes between desktop and touch presentation, and completion or failure SHALL preserve the shell item's horizontal position, vertical reading anchor, chosen inline height, and follow state.
- **AND** Position and applied size SHALL be clamped only where the available content or layout cannot accommodate them.
- **AND** A layout change that clamps position to the bottom MUST NOT itself resume paused following.
- **AND** Resizing or popping out shell output SHALL preserve the outer timeline's reading anchor, and returning inline SHALL preserve its current reading anchor, including any deliberate outer scrolling while the nonmodal window was open.
- **AND** Shell scrolling and its latest-output control MUST NOT independently move the outer timeline to its end.
- **AND** Long shell output SHALL preserve long-chat responsiveness, text selection, copying, and find over available rendered output.

#### Scenario: Parent or child timelines or shell viewports follow append-only streaming or latest-control movement
- **WHEN** parent or child timelines or shell viewports follow incoming content or latest-control movement, initially present or restore a reading position, resize, change motion preference, or receive manual upward input
- **THEN** Following SHALL be smooth and stable in both parent and child outer timelines and in each shell output viewport, whether inline or popped out.
- **AND** Brief catch-up behind incoming content is permitted; repeated updates MUST NOT restart native smooth scrolling or introduce competing position writers.
- **AND** While following during passive append-only updates, automatic movement MUST NOT alternate upward and downward when the scroll extent is not shrinking.
- **AND** In controlled regression fixtures, following SHALL settle within 300ms after the final layout update.
- **AND** The reduced-motion preference SHALL disable follow animation.
- **AND** Initial presentation and reading-position restoration SHALL place content directly rather than animate from an unrelated position.
- **AND** Activating the relevant latest-content or latest-output control during streaming SHALL settle at the current bottom and continue following without oscillation between smooth movement and snapping.
- **AND** Any upward manual scroll SHALL interrupt automatic movement immediately and pause following, even during movement initiated by a latest control.
- **AND** Resize effects and programmatic scroll echoes MUST NOT change the reader's follow intent.
- **AND** A shrinking layout or content extent MAY cause a legitimate position clamp without being treated as follow jitter or resuming paused following.

#### Scenario: Paused reading or activated controls encounter layout changes
- **WHEN** following is paused and layout changes elsewhere, or the reader explicitly activates an expanding or collapsing control
- **THEN** while following is paused, layout changes elsewhere SHALL preserve the unchanged visible reading anchor within a 2px tolerance in controlled regression fixtures, rather than merely preserving a raw scroll offset
- **AND** explicitly activated expanding or collapsing controls SHALL remain stable and visible where the available viewport permits

#### Scenario: Already loaded ordinary assistant text enters a reading viewport
- **WHEN** already loaded ordinary assistant text enters a parent or child reading viewport, the reader scrolls, or subsequent unseen output arrives
- **THEN** that text SHALL retain real layout geometry rather than skipped-body placeholder heights
- **AND** this SHALL NOT require fetching additional history, materializing closed tool bodies, or changing independent shell scrolling
- **AND** deferred activity SHALL retain its existing presentation policy
- **AND** scrolling and subsequent unseen output SHALL preserve the same visible word and paused follow intent

#### Scenario: Loaded text remains ready and anchored during history reading

- **GIVEN** a long parent or child timeline whose ordinary assistant message bodies are already loaded
- **WHEN** the reader scrolls upward and then pauses
- **THEN** those message bodies are browser-layout-ready as they occupy the viewport
- **AND** the same visible word retains its offset within 2px through settling and later unseen output
- **AND** preparation does not countersteer toward later text or resume following
- **AND** closed tools remain deferred and their shell viewports keep independent scrolling

#### Scenario: Active reader follows streaming output
- **WHEN** the user is at the end of the timeline as assistant content streams
- **THEN** new content remains visible without repeated manual scrolling

#### Scenario: Fresh loaded text keeps its initial bottom placement
- **GIVEN** a parent or child view opens without a saved reading anchor
- **WHEN** its loaded transcript is first rendered
- **THEN** initial instant placement occurs after the rendering layout boundary and remains at the bottom through subsequent layout
- **AND** a snapshot replacement before placement retains the owed instant placement using the replacement's current geometry rather than animating from an unrelated position
- **AND** upward reader input before placement cancels that automatic movement and later output preserves the chosen reading position
- **AND** hiding or leaving the view prevents stale placement work
- **AND** saved reading-anchor restoration and ordinary updates retain their existing atomic correction behavior

#### Scenario: Reading older content is not interrupted
- **WHEN** the user scrolls above the end while content continues streaming
- **THEN** their visible content remains anchored
- **AND** an affordance reports and navigates to unseen latest content

#### Scenario: Any upward scroll leaves the end
- **WHEN** the user scrolls upward by less than the near-end distance while content continues streaming
- **THEN** the timeline is no longer pinned and the next update does not return it to the end

#### Scenario: Downward arrival within 48px resumes timeline following
- **GIVEN** following is paused in a parent or child outer timeline
- **WHEN** deliberate downward reader movement reaches a bottom gap of 48 CSS pixels or less
- **THEN** following resumes, including arrival exactly at 48px
- **AND** subsequent content follows without requiring actual-bottom arrival or a Latest activation
- **AND** deliberate downward movement that leaves a gap greater than 48px keeps following paused
- **AND** upward input inside the band still pauses immediately

#### Scenario: Near-bottom restoration and layout do not impersonate arrival
- **WHEN** a paused parent or child timeline is restored, corrected or clamped into the 48px band, or a scroll event reports no actual movement
- **THEN** following remains paused until deliberate downward reader arrival or activation of Latest
- **AND** repeated programmatic echoes do not change that intent

#### Scenario: Fractional downward arrival can resume following
- **GIVEN** a paused parent or child timeline near the resumption boundary
- **WHEN** actual downward reader movement of less than one CSS pixel enters the 48px band
- **THEN** following resumes without confusing the fractional arrival with a no-movement event or a correction echo
- **AND** the restored tolerance does not cause idle rounding of native bottom settling

#### Scenario: Sending preserves a paused reader's position
- **WHEN** the user submits a message while scrolled above the end
- **THEN** the same visible content remains anchored and following remains paused
- **AND** the sent message and subsequent reply do not pull the reader to the end
- **AND** deliberate downward arrival within 48px of the bottom or activating the latest-content affordance resumes following

#### Scenario: Loading older history preserves the viewport
- **WHEN** the user requests an older history page at the top of the loaded timeline
- **THEN** the previously visible first item remains at the same visual offset after insertion

#### Scenario: Expanding activity does not cause an unrelated jump
- **WHEN** the user expands or collapses a tool entry away from the timeline end
- **THEN** the chosen entry remains anchored in the viewport

#### Scenario: Keyboard and accessibility focus remain navigable
- **WHEN** keyboard or accessibility navigation reveals a control outside the paused viewport
- **THEN** the control remains visible
- **AND** an ordinary timeline correction does not undo the requested navigation
- **AND** a focused button alone is not treated as a temporary shell handoff

#### Scenario: Collapsed activity does not steal the reading anchor
- **WHEN** a paused reader views a message after a collapsed activity group and the viewport width changes
- **THEN** unchanged visible text retains its reading position
- **AND** hidden activity descendants are excluded from reading anchors even if the browser reports placeholder layout boxes
- **AND** the collapsed group's visible summary remains available as an anchor

#### Scenario: Appending text during rewrap preserves an unchanged visible word
- **WHEN** a paragraph appends text while viewport width changes and a paused reader's visible word remains unchanged
- **THEN** the same visible word retains its offset within 2px in controlled regression fixtures
- **AND** changed text elsewhere in that paragraph does not itself discard the reading position or resume following

#### Scenario: History gestures avoid redundant anchor work
- **WHEN** a paused reader scrolls through loaded conversation history
- **THEN** each native scroll event performs at most one semantic reading-anchor measurement
- **AND** continuous upward touch movement does not repeat the same pause-intent capture without new work
- **AND** actual native movement, renewed gestures, direction changes and layout corrections still capture fresh intent where needed
- **AND** upward input interrupts a new latest-content request immediately

#### Scenario: History geometry avoids measuring every loaded row
- **WHEN** browser hit testing can resolve the viewport's reading row
- **THEN** semantic geometry measures the viewport row, retained row and explicitly activated row rather than all loaded history
- **AND** offscreen retained and explicitly activated rows remain available for anchoring
- **AND** unavailable or unusable hit testing falls back without discarding the reading anchor
- **AND** ordinary controlled row-lookup fixtures use at most four item-rectangle reads and twelve point queries per semantic measurement, with correctness fallback assessed separately

#### Scenario: Manual arrival settles at the native bottom
- **WHEN** a manual flick reaches the newest message with elastic overscroll or subpixel settling
- **THEN** idle follow frames do not clamp or round that native motion
- **AND** elastic rebound alone does not pause following
- **AND** deliberate upward input still pauses immediately
- **AND** subsequent appended content follows normally

#### Scenario: Newer input outranks pending snapshot placement
- **GIVEN** a parent or child snapshot is installed but its first render has not occurred
- **WHEN** the reader deliberately scrolls upward or activates Latest before that render
- **THEN** the newer paused reading position or explicit following choice survives first render and later updates
- **AND** the pending navigation restore or initial latest placement does not overwrite that intent

#### Scenario: Navigation retains intent beneath temporary answer positioning
- **GIVEN** a parent or child view temporarily positions a focused answer field
- **WHEN** the reader leaves and later reopens that view
- **THEN** the view restores its durable reading position and follow intent rather than persisting the temporary answer-field position
- **AND** header Back and browser Back preserve the same intent

#### Scenario: Departure before a loading transcript arrives preserves saved intent
- **GIVEN** a view has a saved reading position and its reopened transcript is still loading
- **WHEN** the surface changes layout and the reader leaves before the snapshot arrives
- **THEN** the next reopening retains the saved reading position rather than replacing it with empty or outgoing geometry
- **AND** a newer deliberate paused or following choice supersedes that saved intent

#### Scenario: Loading child restoration survives visibility and layout changes
- **GIVEN** a child transcript snapshot is still loading
- **WHEN** Chat is hidden and reopened, or the empty child surface changes size, before that snapshot arrives
- **THEN** the loading presentation does not consume the pending saved reading position or first-time latest placement
- **AND** layout-only callbacks do not impersonate newer reader input
- **AND** once content arrives, a paused child restores its saved visible anchor while a first-time child places directly at latest
- **AND** the outer timeline retains its independent reading position

#### Scenario: A question arrives while the reader follows or reads earlier content
- **WHEN** a pending question arrives through the live conversation stream in a parent or child view
- **THEN** an already-following reader continues to follow the newly rendered content
- **AND** a paused reader retains the same visible reading anchor within 2px in controlled regression fixtures
- **AND** paused following stays paused and its latest-content affordance remains available for unseen content

#### Scenario: Shell output initially follows independently
- **WHEN** a shell viewport first shows output and further output arrives
- **THEN** it shows the bottom of its scrollback
- **AND** an outer timeline scrolled away from its end retains its reading anchor

#### Scenario: Any upward shell scroll pauses following
- **WHEN** the reader scrolls a shell viewport upward even by less than a near-bottom threshold and more output arrives
- **THEN** the viewport preserves the reader's visible content and vertical offset instead of returning to the bottom
- **AND** its latest-output control indicates unseen output
- **AND** other shell viewports and the outer timeline retain their own follow state

#### Scenario: Returning to latest output resumes following
- **WHEN** the reader scrolls a paused shell viewport back to the bottom or activates its latest-output control
- **THEN** that viewport resumes following incoming output
- **AND** it preserves its horizontal offset and does not jump the outer timeline to its end

#### Scenario: Reading position survives output and layout changes
- **WHEN** the reader has paused shell following and scrolled horizontally, and the output updates, the layout resizes, the inline height changes, the viewport is popped out, maximized, restored to floating size, returned inline, changes between desktop and touch presentation, or the command completes or fails
- **THEN** the same rendered content remains at the same vertical offset and the horizontal offset is preserved wherever the content and layout permit
- **AND** the chosen inline height is retained with its applied size clamped to the available layout
- **AND** following remains paused even if clamping places the viewport at the bottom

#### Scenario: Diagonal shell reading retains horizontal progress
- **WHEN** downward and rightward native reader movement occurs together while shell output is following
- **THEN** the next follow correction and subsequent output preserve the new horizontal offset within available bounds
- **AND** the shell and outer timeline retain their independent follow intent

#### Scenario: Following survives resize and completion
- **WHEN** a shell viewport is following and is resized, popped out, maximized, restored to floating size, returned inline, changes between desktop and touch presentation, or receives completion or failure
- **THEN** it remains at the bottom with following active
- **AND** its horizontal offset and chosen inline height are retained within available bounds

#### Scenario: Long scrollback remains usable
- **WHEN** a long conversation contains shell output spanning many viewport heights and further output streams
- **THEN** scrolling, resizing, and conversation controls remain responsive
- **AND** available rendered output remains selectable, copyable, and reachable through find in inline, floating, maximized, and touch full-area views
- **AND** streaming does not clear an existing selection in unchanged output or steal the outer reading anchor

#### Scenario: Passive following does not jitter during append
- **WHEN** a parent outer timeline, child outer timeline, or shell output viewport is following during passive append-only streaming and its scroll extent is not shrinking
- **THEN** automatic scrolling keeps the latest content visible without alternating upward and downward movement
- **AND** the same behavior applies to inline, floating, maximized, and touch full-area shell output

#### Scenario: Latest settles at the bottom during streaming
- **WHEN** the reader activates the latest control in a parent outer timeline, child outer timeline, or shell output viewport while content continues appending
- **THEN** the view settles at the current bottom and follows subsequent appends
- **AND** it does not oscillate between smooth movement and snapping

#### Scenario: Manual upward scrolling interrupts automatic movement
- **WHEN** the reader scrolls upward in a parent outer timeline, child outer timeline, or shell output viewport during automatic following or movement initiated by its latest control
- **THEN** automatic movement stops immediately and following pauses, even for movement smaller than the near-bottom threshold
- **AND** subsequent appends preserve the reader's position rather than completing the interrupted movement

#### Scenario: Resize and programmatic echoes preserve follow intent
- **WHEN** resize effects or scroll events caused by automatic movement occur in a parent outer timeline, child outer timeline, or shell output viewport
- **THEN** they do not change whether the reader has chosen to follow
- **AND** a legitimate position clamp after layout or content shrink is allowed
- **AND** clamping a paused view to the bottom does not resume following

#### Scenario: Automatic correction has one frame owner
- **WHEN** streaming, resize and a control reveal request automatic vertical correction in the same frame
- **THEN** each scrollport receives at most one automatic vertical position write in that animation frame in controlled regression fixtures
- **AND** upward reader input can cancel queued and in-flight movement

### Requirement: OpenCode 2.x conversations can steer the running turn

OpenCode 2.x SHALL declare steering and support fixed steer/queue actions, safe withdrawal and uncertainty handling, paused-batch resume, and agent-owned pending reconciliation. The dock SHALL retain ordered user entries and accessible, bounded, responsive pending controls without changing unsupported-agent semantics.

#### Scenario: An agent declares whether it can deliver, withdraw, or switch input at a running turn's safe step boundary
- **WHEN** an agent declares whether it can deliver, withdraw, or switch input at a running turn's safe step boundary
- **THEN** An agent that can deliver a message into its running turn at the next safe step boundary, and can withdraw or switch a message before then, SHALL declare the `steering` capability.
- **AND** The OpenCode 2.x agent SHALL declare it.
- **AND** The OpenCode 1.x agent and the Claude Code agent SHALL NOT declare it.

#### Scenario: A steering conversation is running or has pending input and the user chooses Send, keyboard delivery, or hold-to-queue
- **WHEN** a steering conversation is running or has pending input and the user chooses Send, keyboard delivery, or hold-to-queue
- **THEN** While a conversation whose agent declares `steering` is running or has pending messages, the composer SHALL offer two deliveries through fixed actions.
- **AND** Tap Send and desktop Enter SHALL steer.
- **AND** Touch Enter SHALL insert a newline, idle or busy, including while a command candidate is shown; Ctrl/Command+Enter SHALL explicitly steer. ⌥Enter (Option/Alt+Enter) SHALL queue where the choice is offered.
- **AND** Steer SHALL be the fixed keyboard default, not a per-device setting; legacy saved delivery choices SHALL be ignored without deleting browser settings.
- **AND** There SHALL be no delivery-default Settings path, Send dropdown, replacement selector or added layout height.
- **AND** The existing Send hold SHALL arm for 500ms, count down for two seconds and queue once at 2500ms; release during the armed countdown SHALL cancel.
- **AND** Commands and attachment-bearing drafts SHALL retain mandatory queue semantics, and idle submission SHALL retain immediate delivery.
- **AND** Explicit HTTP delivery and dock delivery actions, capability gates and unsupported agents' queued follow-ups SHALL remain unchanged.

#### Scenario: A steer is admitted, remains pending with the agent, or is delivered into the timeline
- **WHEN** a steer is admitted, remains pending with the agent, or is delivered into the timeline
- **THEN** A steer SHALL be handed to the agent at once and kept pending by the agent until the agent delivers it.
- **AND** Steers SHALL be delivered before any held message.
- **AND** The expanded dock SHALL list the user's pending steers, from any client of the conversation, labelled "Steer", and SHALL NOT list the agent's own internal inbox entries.
- **AND** A steer SHALL NOT appear in the timeline until the agent reports it delivered, at which point it SHALL appear as an ordinary user message.
- **AND** Outside compact keyboard/short-landscape mode, pending steers SHALL carry the dock note that they run with the conversation's model and mode as they stand when they are delivered.

#### Scenario: The user switches, edits, or removes a pending steer or queued entry
- **WHEN** the user switches, edits, or removes a pending steer or queued entry
- **THEN** For each pending entry, the user SHALL be able to:
  - switch a queued message to steer, which hands it to the agent as a steer at once; on a dormant queue or an idle conversation this is how a held message is sent now;
  - switch a steer back to queue, which withdraws it from the agent and holds it in the workspace's queue in its submission order;
  - edit or remove a steer, which withdraws it from the agent.

#### Scenario: Withdrawal races native delivery and the agent confirms or refuses cancellation
- **WHEN** a steer withdrawal is requested and the agent confirms or refuses it, including a race with native delivery
- **THEN** Withdrawing a steer SHALL complete only when the agent confirms the withdrawal.
- **AND** If the agent delivers the steer first, the withdrawal SHALL fail, the message SHALL stay delivered, and the user SHALL be told it was already delivered.
- **AND** A message SHALL never be delivered twice.

#### Scenario: Native withdrawal is unconfirmed or the client retries withdrawal-specific uncertainty
- **WHEN** native withdrawal is unconfirmed or the client retries withdrawal-specific uncertainty
- **THEN** An unconfirmed withdrawal SHALL keep the pending entry and private draft visible.
- **AND** Absence from a passive inbox/history snapshot SHALL NOT by itself confirm cancellation.
- **AND** A client with withdrawal-specific uncertainty SHALL offer **Retry withdrawal**, which explicitly repeats only native cancellation of the same inbox ID.
- **AND** It SHALL NOT edit, convert, resubmit the original input, automatically retry any mutation, or allow concurrent actions on that entry.
- **AND** Admission/resume uncertainty SHALL NOT grant withdrawal retry.
- **AND** Resume uncertainty SHALL remain read-only; settled unknown admission MAY offer only the token-fenced local discard defined below.

#### Scenario: A skill, slash command, or /reload is pending in the queue
- **WHEN** a skill, slash command, or /reload is pending in the queue
- **THEN** Skills, slash commands, and `/reload` in the queue SHALL NOT offer the switch to steer.

#### Scenario: Turn cancellation pauses pending steers and the reader resumes the paused batch or submits a new steer
- **WHEN** turn cancellation pauses pending steers and the reader resumes the paused batch or submits a new steer
- **THEN** Cancelling the turn SHALL leave pending steers with the agent and SHALL present them as paused.
- **AND** A steer is paused when it was pending before the conversation last became idle.
- **AND** The dock SHALL offer one action labelled `Send N paused steers now`, which resumes the agent so that it delivers every pending steer.
- **AND** Submitting a new steer SHALL also resume delivery of paused steers.

#### Scenario: Worker and pending cards share constrained desktop or touch dock space
- **WHEN** worker and pending cards share constrained desktop or touch dock space
- **THEN** The pending card SHALL have an always-visible count header outside its own contained content scrollport.
- **AND** Worker and pending cards SHALL share only a height budget, never an aggregate scroller, as specified by Desktop work shares measured panel space.
- **AND** With both cards collapsed, desktop normally uses 40% of measured panel height capped at 25rem; touch normally uses 35% of visual height, 25% at tablet widths from 48rem, or 24% during hardware editing.
- **AND** With either expanded, the measured expanded-card policy in Desktop work shares measured panel space SHALL supersede these caps and the earlier 40% phone/35% tablet transcript reserves.
- **AND** The pending list SHALL show a bottom fade only while content remains below.
- **AND** Entries SHALL retain distinct Steer/Queue badges, Paused chips and existing timing labels.
- **AND** Pending actions SHALL retain the approved compact 32px touch / 36px desktop targets, independent 8px gaps, visible focus outlines and contextual accessible names.
- **AND** Successful mutations SHALL not add confirmation notices; refusals and unknown receipts SHALL retain operation-scoped feedback without duplicate red errors.

#### Scenario: Pending messages coexist with software-keyboard mode, short touch landscape, or growing dock content
- **WHEN** pending messages coexist with software-keyboard mode, short touch landscape, or growing dock content
- **THEN** software-keyboard mode or short touch landscape SHALL collapse the work dock to a pending-count summary rather than hide it when pending messages exist
- **AND** Any paused-steer batch Send action SHALL retain a 44px target, and the count-only replacement warning SHALL remain readable while typing or editing a pending entry.
- **AND** Entry details and the routine model-at-delivery note MAY be hidden in this compact state; the replacement warning SHALL NOT be hidden.
- **AND** Dock growth SHALL reserve its final bounded layout height before a visual reveal, respect reduced motion, and preserve a remote-update reading anchor and deliberate bottom pinning.
- **AND** Sending a prompt SHALL preserve the current reading position and follow intent: paused readers remain paused, while readers already following continue to follow latest content.

#### Scenario: The workspace attaches to a conversation or reconnects to the owning agent
- **WHEN** the workspace attaches to a conversation or reconnects to the owning agent
- **THEN** the workspace SHALL reconcile the pending steers with the agent's own list, so the dock shows steers raised while the stream was interrupted or by another client

#### Scenario: Hidden delivery does not erase an uncertain withdrawal
- **WHEN** a withdrawal is unconfirmed and a later inbox read is empty while V2 history hides reverted messages
- **THEN** the original pending entry and attachments remain inspectable, and no removal is published based on that absence

#### Scenario: An explicit withdrawal retry does not resend input
- **WHEN** the user activates Retry withdrawal
- **THEN** only cancellation of the original inbox ID is requested again, with no prompt or new message ID
- **AND** confirmed cancellation removes the entry, confirmed delivery removes it with an already-delivered warning, and an inconclusive result keeps it visible

#### Scenario: Short desktop budgets use the panel rather than the window
- **WHEN** six long pending messages occupy a 1280px-wide desktop window at 600px or 480px height, or the panel is shorter than its window
- **THEN** the queue is bounded by the measured panel height and Send and Stop remain inside that panel and hit-testable

#### Scenario: Keyboard retains pending safety information
- **WHEN** a replacement is staged with paused steers, or a pending message is edited into the focused touch composer
- **THEN** compact pending counts remain visible while typing
- **AND** any paused-steer batch Send action and replacement warning remain available above the composer

#### Scenario: Dock growth preserves reading intent with either motion preference
- **WHEN** remote work grows the dock while the user reads an earlier message, then the user deliberately returns to latest and submits a prompt
- **THEN** the earlier reading anchor survives the remote update and the submitted exchange remains bottom-pinned through dock growth
- **AND** reduced motion omits the reveal animation without changing these positioning rules

#### Scenario: Steering is offered only where declared
- **WHEN** a running conversation's agent declares `steering`
- **THEN** the composer offers steer and queue delivery
- **AND** on a conversation whose agent does not declare it, no steer choice appears and busy submissions queue

#### Scenario: Desktop Enter always steers ordinary text
- **WHEN** the desktop user presses Enter with an ordinary-text draft while a steering agent works, including with a legacy saved Queue default
- **THEN** the message is handed to the agent as a steer
- **AND** the dock lists it labelled "Steer", ahead of any queued messages

#### Scenario: Option+Enter explicitly queues
- **WHEN** the user presses ⌥Enter while the steering delivery choice is offered, including with a legacy saved Queue default
- **THEN** the message is held in the workspace's queue labelled "Queue"

#### Scenario: Legacy delivery defaults are ignored after reload
- **WHEN** a browser with a saved Queue default opens or reloads a steering conversation
- **THEN** desktop Enter or touch Ctrl/Command+Enter steers ordinary text and Alt/Option+Enter queues where offered
- **AND** hints describe these fixed shortcuts without changing saved browser settings or adding a configuration control

#### Scenario: Touch Enter is always a newline
- **WHEN** a touch user presses unmodified Enter while idle, busy, or viewing a command candidate
- **THEN** a newline is inserted without a prompt mutation
- **AND** Send or Ctrl/Command+Enter remains the explicit submission path

#### Scenario: The delivery menu is available on touch
- **WHEN** the user opens the separate delivery selector while the agent works
- **THEN** both Steer and Queue are offered by name
- **AND** the action rail keeps its layout

#### Scenario: Selecting delivery is not submission
- **WHEN** the user chooses Queue or Steer with an existing draft
- **THEN** the selector shows the choice, the draft remains, and focus returns to the composer
- **AND** no prompt or cancellation request is made until the corresponding explicit action is activated

#### Scenario: A steer joins the turn at the next step
- **WHEN** a steer is pending and the agent reaches its next step boundary
- **THEN** the agent delivers the steer into the running turn
- **AND** it leaves the dock and appears in the timeline as a user message

#### Scenario: A steer shown pending is not yet in the timeline
- **WHEN** a steer has been handed to the agent but not delivered
- **THEN** it appears only in the dock
- **AND** the timeline contains no user message for it

#### Scenario: Duplicate or image-only entries remain distinguishable
- **WHEN** pending entries have duplicate text or only attachments
- **THEN** their action names include distinct human-readable pending-message numbers
- **AND** a pending entry retains its number across reordering, delivery switches and sibling removal during the current client view

#### Scenario: Repeated successful mutations each announce once
- **WHEN** the user successfully removes, moves or sends two pending messages in succession
- **THEN** each success produces one polite live update even if the words are identical
- **AND** later routine paints do not replay the retained note

#### Scenario: Pending steers note the model they run with
- **WHEN** at least one steer is pending outside compact keyboard/short-landscape mode
- **THEN** the dock says that steers run with the conversation's model and mode at delivery

#### Scenario: A queued message is switched to steer
- **WHEN** the user switches a held message to steer while the agent works
- **THEN** the message leaves the workspace's queue and is handed to the agent as a steer with its attachments
- **AND** every client shows it labelled "Steer"

#### Scenario: A steer is switched back to queue
- **WHEN** the user switches a pending steer to queue and the agent confirms the withdrawal
- **THEN** the message is held in the workspace's queue in its submission order, labelled "Queue"
- **AND** the agent does not deliver it mid-turn

#### Scenario: A steer delivered before it could be withdrawn
- **WHEN** the user switches, edits, or removes a pending steer and the agent delivers it before confirming the withdrawal
- **THEN** the user is told the message was already delivered
- **AND** it appears once in the timeline and is not held, returned to the composer, or delivered again

#### Scenario: A steer is edited
- **WHEN** the user edits a pending steer and the agent confirms the withdrawal
- **THEN** the steer leaves the dock on every client
- **AND** the invoking client's composer receives its text and attachments

#### Scenario: Commands cannot be steered
- **WHEN** a skill, slash command, or `/reload` is held in the queue
- **THEN** its entry offers no switch to steer
- **AND** submitting one with the steer delivery holds it in the queue

#### Scenario: Cancel pauses pending steers
- **WHEN** the user cancels the running turn while steers are pending
- **THEN** the agent is not resumed and no steer is delivered
- **AND** the steers remain in the dock presented as paused

#### Scenario: Send now wakes paused steers together
- **WHEN** steers are paused and the user chooses the dock's Send N paused steers now action
- **THEN** the agent resumes and delivers every paused steer
- **AND** the control said beforehand that all paused steers go together

#### Scenario: A new steer resumes paused steers
- **WHEN** steers are paused and the user submits a new steer
- **THEN** the paused steers and the new one are delivered

#### Scenario: Pending steers survive a reload
- **WHEN** a client reloads while steers are pending
- **THEN** the dock lists the same pending steers, with the same paused states

#### Scenario: Steers raised while disconnected are recovered
- **WHEN** a steer was handed to the agent while the workspace's stream was interrupted
- **THEN** after reconnecting, the dock lists it as pending

#### Scenario: Internal inbox entries are not shown
- **WHEN** the agent holds a pending entry that is not a user message, such as a synthetic note, a compaction, or a move
- **THEN** the dock does not list it

### Requirement: Desktop expanded work retains a useful conversation band
Compact desktop expanded cards SHALL prefer 50% of measured remaining layout height for conversation, bounded to 200–420px, rather than the comfortable 20%/32–96px reserve above. Whole measured headers/actions MAY reduce this reserve to the existing lesser-of-16px-or-10% emergency floor. Independent panel scrolling, headers, selected-pane short-window priority and reachable composer/Stop SHALL remain intact. Comfortable/touch expanded allocation SHALL remain unchanged.

#### Scenario: Expanded desktop work shares remaining space with conversation
- **WHEN** two long work panels expand with 720px remaining after fixed chrome and fitting action minima
- **THEN** conversation retains 360px and the cards share 360px through separate scrollports
- **AND** short windows yield conversation space to measured whole headers/actions rather than clipping Stop
