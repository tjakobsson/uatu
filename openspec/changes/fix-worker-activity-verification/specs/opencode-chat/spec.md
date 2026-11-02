# Spec Delta

## MODIFIED Requirements

### Requirement: OpenCode V2 background workers have a lifecycle independent of their launchers
For native V2 background subagents, Uatu SHALL track the worker independently of the launching tool call. A successful launcher that reports a running worker SHALL NOT make the subagent appear finished. Confirmed worker completion, error, and cancellation SHALL appear as completed, failed, and stopped respectively, consistently across the launch card, subagent track, background list, and open child view. The worker SHALL remain associated with its parent, chosen agent, and child identity without altering configured agent/model defaults or requiring project instructions.

The subagent track SHALL retain one row per task as specified by its existing counting contract, with the compact touch summary exception below. Multiple representations or overlapping calls known to share one live worker SHALL NOT inflate the count of independently running workers. A later task in a reused child session SHALL have a distinct occurrence from its earlier completed task; stale progress or terminal evidence for one occurrence MUST NOT reopen or settle another. Launcher running metadata alone SHALL NOT establish current activity.

#### Scenario: Completed launcher still has a running child
- **WHEN** OpenCode returns a completed background launcher with child metadata reporting running and current evidence confirms that task's activity
- **THEN** the launch is recorded as accepted and the worker remains visibly Working
- **AND** launch instruction text is not presented as the child's finished report

#### Scenario: Terminal outcomes override launcher success
- **WHEN** the same worker subsequently reports completed, error, or cancelled
- **THEN** every presentation of that occurrence shows the corresponding completed, failed, or stopped worker outcome in words
- **AND** its tool launch is not incorrectly reclassified as a failed launch

#### Scenario: Reused child and duplicate frames
- **WHEN** a child completes a task, later starts another task, and old completion or progress frames are replayed
- **THEN** the earlier task remains terminal and the new task remains in its independently established state
- **AND** duplicate representations do not create additional live workers or report rows

#### Scenario: Foreground default remains unchanged
- **WHEN** the chosen agent launches a subagent without requesting background execution and no qualifying accepted Hub steer or explicit background action occurs
- **THEN** the call retains its native foreground behavior
- **AND** Uatu does not inject instructions, change launch policy, or convert it on an ordinary send

### Requirement: Touch pending messages and workers use compact deliberate disclosures
Touch chat SHALL show at most one initially collapsed pending-message summary and one initially collapsed worker summary, omitting an empty summary. Pending text SHALL identify only nonzero steer/queued categories without repeating the total, such as `1 queued` or `2 steers · 1 queued`. Its header and inline pending actions SHALL use the approved 32px minimum density exception with independent 8px gaps including before Remove, preserving existing confirmations. Cards SHALL share compact delivery labels and message content on a line where space permits rather than forcing three rows; long messages and warnings SHALL remain readable. Worker text SHALL identify Working, Unresolved and Finished occurrences, omitting zero-count groups; Finished SHALL include confirmed terminal failures/stops without implying successful completion. Checking status and unverified task activity SHALL count under Unresolved, not Working or Finished. A request positively linked to the current task SHALL show Needs your answer and count under Working. Dismissed counts SHALL NOT be visible; when no visible workers remain the whole worker card SHALL be absent. New work, replay and settlement SHALL update the summaries without automatically expanding touch details. Deliberate per-conversation expansion SHALL survive repaint, reselection and viewport changes within the page without leaking to other conversations.

Pending message leading SHALL scale with text size, preserving 14px type/20px leading at default size and 28px/40px at 200% root text. Multiline glyph rectangles SHALL remain vertically separated; enlarged multiline and image-containing cards SHALL grow naturally within the existing dock scroller without horizontal overflow or reduced mutation targets.

After replacement changes the available actions, pending footers and action groups SHALL shrink to their card's content width and long labels such as `Send now + paused steers` SHALL wrap without clipping or truncation. Cards and their shared height budget SHALL NOT acquire horizontal scrolling. Actions SHALL retain at least 32px targets and independent 8px gaps, and SHALL be fully exposable within all clipping ancestors. Paused-batch Send SHALL retain a 44px target in Pending's independent content pane, available even with entries collapsed; the count header SHALL remain visible outside that pane. Existing confirmation wording, cancellation without mutation and confirmed paused-batch delivery semantics SHALL remain unchanged.

Expanded pending details SHALL retain delivery order and existing edit/remove/convert/Send now actions. Expanded worker details SHALL retain inspection, truthful terminal outcomes, available shell output and existing parent/worker-stop safeguards. Replacement consequences, paused-batch warnings and applicable batch Send, and actionable operation failure/uncertainty SHALL remain visible outside collapsed details. The collapsed touch defaults are an explicit exception to desktop automatic expansion.

In selected desktop UI mode, Workers SHALL automatically open when a new batch of visible Working or Unresolved occurrences first appears, and Pending SHALL automatically open for a new nonempty batch, including paused entries. Deliberate collapse SHALL hold until that card's visible Working/Unresolved or pending batch becomes empty; further arrivals SHALL NOT reopen it. Ending a batch SHALL leave its current open state alone and clear the collapse veto for the next batch. Finished-only history SHALL NOT invent a new active batch. Choices SHALL be retained separately per conversation and UI mode in a page-local cache bounded to 200 conversations, without inheriting another conversation's choice or treating automatic expansion, mode changes or delayed programmatic toggle echoes as user gestures. Null selection during refresh SHALL NOT end a batch. Native pointer/keyboard changes SHALL survive a live repaint before their deferred toggle event arrives. Policy SHALL follow `data-ui-mode`, not fine-pointer density; tablet desktop mode SHALL use desktop defaults. Canonical rows, independent pane offsets, focus and reading-anchor ownership SHALL remain unchanged.

Expanded worker details SHALL show one flat list: Working and Unresolved workers first, then Finished history ordered newest first from available execution timestamps, without a separate Finished disclosure. Each occurrence SHALL have one whole-row inspection target. Names SHALL remain readable at at least 14px and metadata at at least 13px, subject to the documented compact-density exceptions. Occurrences offering Stop SHALL use two lines within the existing 44px action height: task title first, then the actual reported agent, model and explicitly cumulative Σ usage. Missing metadata SHALL NOT be invented. Settled and inspection-only rows SHALL retain the approved single-line density exception of at most 28px at default text scale. State-specific glyphs SHALL distinguish working, unresolved, finished, failed and stopped; required activity/evidence wording SHALL remain readable without redundant repeated terminal labels. Unresolved and settled glyphs SHALL NOT imply live execution. Stop SHALL remain a separate 44px target with an 8px gap and a semantic accessible name identifying its worker; its visible label SHALL be Stop, or Stopping… while pending. Existing compact desktop target exceptions SHALL remain unchanged.

The compact main header SHALL use a small chevron rather than a native triangle, expose its expanded state accessibly, and contain Dismiss finished on the right in the same row, without a footer or duplicate finished count. Dismiss finished SHALL persist view-only hiding through the personal per-conversation dismissal seam without displaying hidden counts or deleting provider history. Short or empty lists SHALL NOT reserve unused height after dismissal. Restore finished SHALL be absent, with no replacement visible control. Settled results and inspection SHALL remain reachable from the timeline. Enabled Stop worker SHALL require current ownership, retained exact-occurrence authorization and fresh native validation. Only confirmed live background workers or verified unsettled native shell jobs after process exit SHALL offer this action. Unverified control SHALL disable Stop independently of activity wording. Only verified live workers SHALL cause the parent Stop label to read Stop parent. Successful sends, dock mutations and automatic-background outcomes SHALL be silent; failed, unavailable and meaningful unknown guidance SHALL remain persistent. Desktop and touch SHALL use the same worker state groups and visible-row counts.

#### Scenario: Loaded touch chat starts compact
- **WHEN** a touch conversation has two pending steers, one queued message, two working and four confirmed terminal worker occurrences
- **THEN** its pending and worker summaries are collapsed and show their respective counts
- **AND** no second pinned worker list duplicates the same work

#### Scenario: Desktop new work is reachable without disclosure
- **WHEN** visible Working/Unresolved workers or pending entries first appear in desktop UI mode, including on touch-first hardware explicitly using desktop mode
- **THEN** the corresponding canonical card opens without moving focus
- **AND** finished-only worker hydration stays initially collapsed and touch still starts collapsed

#### Scenario: Desktop manual collapse belongs to its current batch
- **WHEN** the user closes a desktop card and more Working/Unresolved workers or pending entries arrive before its batch empties
- **THEN** the card remains closed, including when repaint precedes the native toggle event
- **AND** settlement leaves its current state alone, while the next batch after empty opens again

#### Scenario: Mode changes and refresh do not create disclosure choices
- **WHEN** a user switches UI modes or conversations, returns, or refresh temporarily clears selection while a batch remains active
- **THEN** each conversation and mode retains its own page-local choice without automatic or delayed-toggle choice leakage
- **AND** temporary null selection does not end the current desktop collapse veto

#### Scenario: Work changes without opening details
- **WHEN** a worker appears or settles, or the conversation rehydrates while its touch details are collapsed
- **THEN** summary counts and outcome/uncertainty wording update without opening the details or moving focus

#### Scenario: Expanded details preserve actions and deliberate state
- **WHEN** the user expands details, changes conversations, returns and receives live updates
- **THEN** the original conversation retains its deliberate disclosure state and existing pending/worker actions
- **AND** another conversation does not inherit that deliberate state

#### Scenario: Replacement and batch risks remain readable while collapsed
- **WHEN** Undo/revert has staged a replacement and paused steers would resume together with the replacement or batch Send
- **THEN** pending counts, the applicable batch action and the full replacement/batch consequence remain readable without expanding details, including while typing
- **AND** no hidden warning is treated as user confirmation

#### Scenario: Settled and uncertain workers remain truthful
- **WHEN** the retained worker set includes a failure, a stopped worker and one unresolved outcome
- **THEN** the confirmed terminal occurrences contribute to Finished with their individual outcomes available in details
- **AND** the unresolved occurrence contributes only to Unresolved, not Finished or successful

#### Scenario: Expanded workers retain the pending overview
- **WHEN** six or more workers and pending messages are expanded on touch or desktop, including while the touch keyboard is open
- **THEN** one bordered canonical worker card contains its header and rows, and a separate compact Pending disclosure follows the card before the composer, without duplicate desktop subagent/background summaries
- **AND** Workers and Pending keep separate bounded content scrollports in every disclosure combination, including replacement warnings and the explicit desktop work sheet; neither header nor the outer dock scrolls
- **AND** summary action identity, composing focus, reading anchors, safe areas and existing transcript budgets are preserved
- **AND** insufficient short bands yield transcript space and prioritize the pane selected by its header or content; both headers remain visible and Pending never appears between the worker header and its rows

#### Scenario: Enlarged question options remain readable beneath date history
- **WHEN** question options intersect a sticky date marker on a 390px touch viewport at 200% root text size
- **THEN** the marker does not paint over the interactive question content and keyboard answering remains available without changing scroll-anchor geometry

#### Scenario: Dismissing finished workers preserves timeline history
- **WHEN** the user dismisses finished workers and reloads the conversation
- **THEN** those overview rows remain hidden without a Restore finished button or replacement menu
- **AND** their retained reports and existing transcript inspection remain reachable in the timeline, without provider history deletion

### Requirement: Worker Stop availability requires retained occurrence proof
Worker Stop SHALL target a retained, verified native occurrence. Display-record cleanup and reconnect SHALL NOT erase known revocations. Missing, revoked or overflowed control proof SHALL withhold Stop and expose control uncertainty independently of activity verification; fresh history alone SHALL NOT restore control trust. Healthy targets whose proof remains retained SHALL remain controllable without reconnect after projection saturation. A Working label SHALL NOT itself authorize Stop.

#### Scenario: New post-gap occurrences do not inherit global permanent refusal
- **WHEN** a new live subscription positively observes native birth and matching invocation evidence for a genuinely new worker after an observation gap
- **THEN** fresh ownership/current-state validation can admit that occurrence within the existing control budget without clearing pre-gap revocations
- **AND** an observed ephemeral shell creation can anchor shell birth under the native live-only, non-replaying stream contract; a later content snapshot, unseen identifier or timestamp alone cannot
- **AND** old identities, unresolved gaps and actual capacity closure remain protected, and in-flight authorizations are invalidated

#### Scenario: Shell birth contradictions fence both retained and first-seen targets
- **WHEN** a native shell birth contradicts a retained occurrence or a first-seen launcher claiming the same shell identifier
- **THEN** the old or mismatched target remains control-unverified and Stop sends no native removal, even if fresh shell inventory confirms ownership
- **AND** an exact retained consumed birth replay is distinguished from a new or conflicting native proof
- **AND** compatible tool creation and shell start clocks need not be equal; identity arrival or timestamps alone do not resolve a command contradiction

#### Scenario: User-shell notes do not consume worker-control admission
- **WHEN** typed user-command shell transcript events identify shell completion notes that are not background-worker reports
- **THEN** command rendering is preserved without retaining each note in worker control observations or unpublished worker-report storage
- **AND** unresolved prelaunch presentation payload has count/byte bounds while genuine worker notification-before-launch correlation and control contradictions remain safe

#### Scenario: Retained controls remain usable after projection saturation
- **WHEN** display/correlation records saturate but a worker's compatible control evidence remains retained and fresh validation succeeds
- **THEN** that worker remains controllable after read-only recovery without reconnecting or clearing the projection recovery-only latch
- **AND** Stop targets only that verified occurrence, never another run using the same child

#### Scenario: Unverifiable control is shown consistently
- **WHEN** control evidence is missing, revoked or overflowed
- **THEN** live updates, history and reconciliation consistently withhold Stop and explain the unavailable control in task details
- **AND** separately verified current task activity can show Working without restoring missing Stop proof
- **AND** workers continue running and message delivery remains available

#### Scenario: Verified shell job remains removable after process exit
- **WHEN** a native shell process has exited but its job remains unsettled and current ownership and retained exact-occurrence authorization remain valid
- **THEN** the row keeps Ended · result unavailable under Unresolved without live animation or a growing execution timer
- **AND** the existing Stop/removal flow remains available subject to fresh native validation of that exact job
- **AND** task details and explicit confirmation explain that removal can delete its job record/output and prevent final result capture
- **AND** a settled job or missing, revoked, gap-invalidated or overflowed proof withholds the action without retargeting another occurrence

#### Scenario: Normal owned launches retain Stop through compatible readback
- **WHEN** retained live native birth and invocation evidence authorize the exact owned worker occurrence and current native validation confirms that target
- **THEN** compatible stored readback supplying missing launcher fields preserves normal Stop availability
- **AND** history alone does not create missing authority, overwrite contradictory facts, clear revocation or retarget a reused occurrence

#### Scenario: Metadata repaint preserves only the surviving owned inspection action
- **WHEN** task-inspection metadata repaints while its result or Stop action has focus and the same occurrence/action target survives
- **THEN** the equivalent enabled visible action retains focus without deferred retries or a new fallback selection
- **AND** changed occurrence, execution, launch reference, child conversation or output targets do not inherit that focus
- **AND** composer, other-worker and modal focus are not taken over, while unchanged legacy targets retain their existing behavior

#### Scenario: Current shell inventory contradicts the retained command before replacement birth arrives
- **WHEN** fresh authoritative inventory returns the retained shell ID and parent but a different known command before the replacement's live birth event is observed
- **THEN** Stop for the old occurrence is revoked and any in-flight validation refuses the mutation without removing the replacement job or output
- **AND** a retained end for the old execution does not override that contradiction or authorize removal of the replacement
- **AND** missing or failed inventory is not treated as positive command contradiction, while unrelated healthy workers remain controllable

#### Scenario: Same-command replacement contradicts retained native shell-birth identity
- **WHEN** a fresh native read returns the same shell ID, parent and command but positively contradicts retained immutable native birth fields such as its native start or output identity before a replacement birth event arrives
- **THEN** old Stop authority and in-flight validation are refused without removing the replacement job or output, including when the old execution has already ended
- **AND** native birth fields are compared within their own native domain rather than equated with launcher or envelope clocks
- **AND** a current or historical lookup alone cannot manufacture missing retained birth proof, while missing/incomplete reads do not invent permanent contradictions

#### Scenario: Control proof has a bounded share of the live evidence budget
- **WHEN** the provider retains control evidence alongside live display/correlation records
- **THEN** control evidence uses at most 1 MiB and 2,048 entries within the existing aggregate 4 MiB and 8,192 live-entry budget
- **AND** complete retained payload, aliases, witnesses, observations, indexes and stubs are accounted as serialized logical payload, not a claim about JavaScript heap size

#### Scenario: Overflow does not silently readmit an old identity
- **WHEN** a target's control evidence cannot be retained or grows beyond its budget
- **THEN** its Stop remains unavailable or its control record compacts to a reserved unavailable/revoked stub without disabling healthy retained targets
- **AND** age, eviction, progress, alias folding or lagging history cannot erase the contradiction and readmit that identity
- **AND** unretained targets may remain uncontrollable for the provider lifetime; no automatic restart, cancellation or data deletion occurs

#### Scenario: Revocation survives recovery and stream replacement
- **WHEN** a known occurrence is superseded or revoked before Stop or during its validation, followed by progress, history recovery or reconnect
- **THEN** the old target is refused without redirecting to a newer execution
- **AND** stream replacement invalidates in-flight authorization but does not erase retained revocation; disposal ends the in-memory provider ownership lifetime

#### Scenario: Proven replay differs from ambiguous old-looking evidence
- **WHEN** a previously consumed invocation is identified by matching native identity, stamp, semantic fingerprint and its established occurrence link
- **THEN** that proven replay does not invalidate an otherwise verified target
- **AND** a first-seen ambiguous report or new/contradictory invocation is not treated as historical merely because its timestamp looks old

## ADDED Requirements

### Requirement: Fresh worker activity survives normal first-launch ordering
Uatu SHALL associate a uniquely owned new child and its first native execution with the accepted launcher when positive evidence establishes that relationship, including child creation during launch and first execution after launcher completion. It SHALL NOT reject such activity solely for these orderings. Ambiguous or contradictory associations SHALL remain unresolved without weakening Stop safeguards.

#### Scenario: Child is born during the accepted launch
- **WHEN** one accepted launcher creates its new, correctly parented child during execution and current native evidence verifies that task is active
- **THEN** the task shows Working through live updates and fresh reconciliation
- **AND** a launcher creation time before child birth is not itself a revocation

#### Scenario: Initial execution starts after launch returns
- **WHEN** the unique newborn child's first execution starts after its accepted launcher completes, with no competing invocation or intervening execution
- **THEN** positive first-execution association and current activity produce Working rather than permanently unverified status
- **AND** a duplicate start or launcher restatement creates no extra worker

#### Scenario: Reuse or ownership contradicts first-launch attribution
- **WHEN** another invocation, execution boundary, foreign parent or workspace makes the association ambiguous or contradictory
- **THEN** Uatu does not assign current activity or terminal results to the old task based only on a shared child ID
- **AND** a stop of that old target never redirects to the newer execution

### Requirement: Worker activity confidence is independent of control authorization
Worker presentation SHALL distinguish verified task activity from active-session-only evidence and unavailable task status. Current evidence of a task's activity SHALL allow Working independently of Stop authorization. Historical running metadata or an active reused session alone SHALL NOT prove task activity. Unavailable Stop reasons SHALL be readable in task details with keyboard and touch, not only a hover tooltip.

#### Scenario: Active task has no retained control proof
- **WHEN** current native evidence independently verifies the owned task's activity but retained Stop proof is unavailable
- **THEN** the row shows Working and contributes once to Working
- **AND** Stop remains disabled with its reason accessible in task details on desktop and mobile

#### Scenario: Partial live references do not override current native shell activity
- **WHEN** a fresh native read verifies that the current shell launch belongs to the conversation and is running, without conflicting ownership, command or execution evidence
- **THEN** a partial live reference alone does not downgrade that task from Working to Unresolved
- **AND** activity and session/output inspection do not require complete Stop authorization
- **AND** real reuse, contradictory evidence and observation gaps remain protected without enabling Stop

#### Scenario: Sparse success enriches a fresh owned agent observation
- **WHEN** a fresh owned child execution is positively associated with its launcher and a live tool-success record omits timing anchors later supplied compatibly by stored history
- **THEN** current native activity remains Working instead of becoming session-active/task-unverified solely because those anchors were initially absent
- **AND** conflicting immutable anchors or a different child execution remain unverified for that task

#### Scenario: Unresolved workers do not fabricate workspace completion
- **WHEN** a previously verified background worker becomes unavailable, session-active without task attribution, checking, or ended without a result after its parent settles
- **THEN** it contributes to Unresolved rather than verified workspace Working
- **AND** child-to-Hub activity preserves a bounded content-free unresolved fact so loss of verification does not create a workspace-finished badge or successful completion notification
- **AND** canonical pending requests retain their attention priority

#### Scenario: Genuine settlement follows an unresolved interval
- **WHEN** a workspace observed Working later becomes unresolved without awaiting attention and eventually settles with no verified work, pending request or unresolved worker
- **THEN** the Hub can record its genuine finish without requiring an intervening return to Working
- **AND** observing only unresolved or quiet state after startup does not invent a prior observed-work epoch
- **AND** the existing Awaiting policy remains unchanged: attention cancels prior completion eligibility, and merely clearing a request does not create a finish without later positive Working
- **AND** the public workspace-summary shape remains unchanged

#### Scenario: Reused session is active but task attribution is ambiguous
- **WHEN** a child session is currently active but evidence cannot establish which old task owns that execution
- **THEN** affected unverified rows show Session active · task unverified and count only under Unresolved
- **AND** no old row gains a running animation, growing execution timer, successful outcome or enabled Stop from that fact

### Requirement: Worker status checks are bounded and recover automatically
Worker recovery SHALL be read-only and automatic, preserving existing probe budgets and backoff. Checking status… SHALL count under Unresolved and end within a finite deadline even when reads fail or hang. An unobservable task SHALL show Status unavailable with a truthful last-seen time when known, no live execution animation and no growing execution timer. No worker Check again control SHALL be introduced.

#### Scenario: Verification fails or exhausts its cycle
- **WHEN** current verification fails, exceeds its deadline or finishes inconclusively within the bounded recovery cycle
- **THEN** Checking status… ends and the row shows Status unavailable · last seen followed by the last verified observation time, or explicitly states that last-seen time is unavailable
- **AND** neither elapsed waiting time nor a stale launch timestamp is presented as ongoing execution

#### Scenario: Authoritative evidence later returns
- **WHEN** new worker evidence or normal reconnect/navigation recovery verifies current activity after status became unavailable
- **THEN** the row and count recover automatically without a manual status action, restart or native mutation
- **AND** unrelated events do not create unbounded probing or permanent Checking status…

### Requirement: Worker rows link blocking requests without duplicating interaction flows
A blocking permission or question positively associated with the current worker execution SHALL label its row Needs your answer and count under Working. The existing main-session request SHALL retain its identity, attention notification and answering flow. Linking SHALL NOT create another request or reply path. Session-only attribution to a reused child SHALL NOT attach a request to an old task.

#### Scenario: Worker is waiting for a permission or question
- **WHEN** an existing pending request is positively linked to the current owned task
- **THEN** its worker row shows Needs your answer and reveals the same canonical request for answering
- **AND** the main session still shows that request with the same identifier and existing notification behavior
- **AND** answering from the canonical flow sends one provider reply and updates both presentations

#### Scenario: Request cannot be attributed to an occurrence
- **WHEN** a pending child request belongs to a reused session but cannot be tied to the displayed old task
- **THEN** the main-session request and existing attention flow remain available
- **AND** the old worker row does not acquire Needs your answer or Working from session identity alone

### Requirement: Ended executions without results remain unresolved
When occurrence-specific evidence proves execution ended but no correlated terminal outcome is available, Uatu SHALL show Ended · result unavailable under Unresolved without live animation or a growing execution timer. It SHALL infer neither success, failure nor cancellation. Parent idleness, active-list absence, a failed read and aggregate child-session outcomes SHALL NOT alone establish that task's end or result.

#### Scenario: Execution end is known and report is missing
- **WHEN** an authoritative execution boundary is positively linked to the task and no correlated outcome is available
- **THEN** the row shows Ended · result unavailable, remains inspectable and offers presentation-only dismissal
- **AND** it does not contribute to Finished or emit a successful-completion notification

#### Scenario: Correlated result arrives later
- **WHEN** a genuine terminal result becomes attributable to the ended execution
- **THEN** the retained task acquires its actual outcome without duplicating its canonical report or settling another occurrence

### Requirement: Worker dismissal changes only summary visibility
Users SHALL be able to dismiss unavailable and ended-without-result rows individually, as well as finished history, without stopping work, deleting provider history or marking an unresolved task finished. Summaries SHALL count only visible rows. Verified task activity and positively linked blocking requests SHALL be visible despite prior dismissal. New executions SHALL NOT inherit old dismissals. There SHALL be no Restore interface.

#### Scenario: Unavailable entry is dismissed
- **WHEN** the user dismisses an unavailable or ended-without-result task
- **THEN** only its summary row/count disappear and retained timeline/inspection data remains available
- **AND** no provider prompt, stop, deletion, request reply or terminal-state transition occurs

#### Scenario: Dismissed work is active again
- **WHEN** current task activity or its positively linked pending request is verified after dismissal
- **THEN** the row automatically resurfaces on every connected client for that account
- **AND** an older dismissal cannot hide this evidence or a different execution of the same child

#### Scenario: All summary entries are dismissed
- **WHEN** no visible worker rows remain
- **THEN** the worker card disappears without a dismissed count or Restore action
- **AND** pending interaction cards and operation-uncertainty guidance remain governed by their own visibility rules
