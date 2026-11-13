## MODIFIED Requirements

### Requirement: Background work is a distinct conversation state

Desktop and touch worker rows SHALL show latest execution-reported child model and
reasoning effort, cumulative tokens and cumulative child-session cost in SDK USD.
Parent/configured selections and model names SHALL NOT imply actual effort. The
latest model/effort pair SHALL clear stale effort on an unreported newer execution.
Execution reports SHALL NOT claim independent downstream-provider confirmation.
Cost SHALL use authoritative native session snapshots including compaction/reverted
spend, never partial message sums, excluding parent/descendants and never summing repeated session snapshots
on canonical aliases or reused-child occurrences into receipts. Unreported/incomplete
values SHALL use an accessibly labeled dash; explicit zero SHALL remain zero and
sub-cent nonzero costs SHALL retain useful precision. Shell rows SHALL NOT invent
subagent metadata. History recovery and existing inspection reads SHALL refresh
metadata without per-render polling. Wide desktop rows SHALL align on one line;
touch SHALL retain 44px Stop targets with minimal narrow-screen metadata wrapping.

#### Scenario: Latest effort and cumulative session cost remain truthful
- **WHEN** a child runs high then medium and produces multiple priced assistant calls
- **THEN** medium is shown with the latest model and cost uses the authoritative cumulative session snapshot
- **AND** a later model lacking effort clears medium rather than inheriting it
- **AND** missing cost shows not reported while explicit reported zero shows zero
- **AND** history recovery/inspection retains the same model/effort and cost semantics

#### Scenario: Latest execution changes effort or model
- **WHEN** a child runs high then medium, followed by another model with no reported effort
- **THEN** its row shows medium after the second execution and not-reported effort with the new model after the third
- **AND** the parent's configured effort never substitutes for missing child effort

#### Scenario: Session cost is not a partial message sum or duplicated task cost
- **WHEN** native cumulative session totals arrive, including compaction and reverted spend
- **THEN** each snapshot replaces the prior total rather than adding to it
- **AND** launcher aliases/repeated child occurrences do not add another cost to receipts
- **AND** a provider without an authoritative aggregate remains not reported even when message prices are available, while explicit reported zero remains zero

Where an agent declares that it can run work in the background, Chat SHALL present live background tasks as a state of the conversation distinct from working and idle: the composer status SHALL name how many tasks run, a list SHALL name each task with its description and progress where reported, each confirmed running and controllable task SHALL offer a stop action, and a settled task SHALL appear in the timeline as a row with its outcome and summary. The state SHALL be populated when an existing conversation with live background work is opened, and SHALL clear when the agent authoritatively reports no live tasks. An agent that does not declare the capability SHALL show none of it.

Background tasks SHALL remain visible while the parent also has a foreground turn, subject to the compact touch visibility rules in "Background inspection and controls remain accessible and workspace-confined". When only background work remains, the parent composer SHALL remain usable without requiring those workers to finish. If recovery cannot establish current task state, Chat SHALL distinguish last-known state from current evidence, show that status is unavailable, and withhold controls whose target cannot be verified. Missing or failed reads alone MUST NOT be reported as successful completion or cancellation. A later successful reconciliation SHALL clear the uncertainty.

#### Scenario: Background tasks are listed while they run
- **WHEN** a conversation's agent reports one or more live background tasks
- **THEN** the composer status names the count
- **AND** each confirmed running and controllable task is listed with a stop action

#### Scenario: A settled task lands in the timeline
- **WHEN** a background task completes, fails, or is stopped
- **THEN** a timeline row records the outcome and the agent's summary
- **AND** the task leaves the live list

#### Scenario: A reopened conversation shows its live work
- **WHEN** the user opens a conversation whose agent still reports live background tasks
- **THEN** the background-work state is shown from that report

#### Scenario: Foreground and background coexist
- **WHEN** the parent is generating a response while two detached workers run
- **THEN** the parent reads as working and both workers remain listed
- **AND** when the parent ends, its background-work summary still names two live workers and its composer accepts new input

#### Scenario: Recovery cannot establish liveness
- **WHEN** a previously running task cannot be reconciled because provider reads fail or evidence is incomplete
- **THEN** Chat labels its state as unavailable rather than asserting a terminal outcome
- **AND** it preserves inspectable known content and offers recovery feedback without an unverified stop action

## ADDED Requirements

### Requirement: OpenCode V2 background workers have a lifecycle independent of their launchers
For native V2 background subagents, Uatu SHALL track the worker independently of the launching tool call. A successful launcher that reports a running worker SHALL NOT make the subagent appear finished. Confirmed worker completion, error, and cancellation SHALL appear as completed, failed, and stopped respectively, consistently across the launch card, subagent track, background list, and open child view. The worker SHALL remain associated with its parent, chosen agent, and child identity without altering configured agent/model defaults or requiring project instructions.

The subagent track SHALL retain one row per task as specified by its existing counting contract. Multiple representations or overlapping calls known to share one live worker SHALL NOT inflate the count of independently running workers. A later task in a reused child session SHALL have a distinct occurrence from its earlier completed task; stale progress or terminal evidence for one occurrence MUST NOT reopen or settle another.

#### Scenario: Completed launcher still has a running child
- **WHEN** OpenCode returns a completed background launcher with child metadata reporting running
- **THEN** the launch is recorded as accepted and the worker remains visibly running
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
- **WHEN** the chosen agent launches a subagent without requesting background execution and the user takes no explicit background action
- **THEN** the call retains its native foreground behavior
- **AND** Uatu does not inject instructions, change policy, or convert it on an ordinary send

### Requirement: OpenCode V2 worker notifications become correlated inspectable results
Uatu SHALL recognize provider-authored synthetic worker completion records using their structured source, identity, and state, including records still pending in the parent's inbox. It SHALL present one readable settled task/result per confirmed occurrence with a link to the associated launch and available child transcript. The report body SHALL have a single canonical presentation; other worker surfaces SHALL expose its outcome and a link rather than duplicate the report. Raw provider envelopes and background-launch instruction text MUST NOT stand in for the report. Error and cancellation SHALL retain their explanation and SHALL NOT be presented as successful worker completion.

Notification enqueue, delivery, history, and replay SHALL converge without duplicate results or synthetic user prompts. Worker notifications MUST NOT enter the editable user steer/queue dock. Uatu MUST NOT inject another completion into OpenCode or independently resume the parent. Child completion and historical recovery SHALL continue to be excluded from successful top-level-turn push notifications; a real subsequent parent turn follows existing notification rules.

#### Scenario: Notification arrives before delivery to the parent
- **WHEN** a worker completion is in the provider's pending synthetic inbox but has not entered parent history
- **THEN** Uatu shows the worker's outcome and report without waiting for a user prompt
- **AND** later delivery and history reads update the same logical result rather than add another

#### Scenario: Worker start predates the launcher row
- **WHEN** a settled worker retains a start timestamp earlier than its correlated launcher row
- **THEN** the timeline presents its result after its launcher, without changing canonical report identity or duplicating its body

#### Scenario: A synthetic result wakes the parent
- **WHEN** OpenCode resumes an idle parent to consume a worker notification
- **THEN** Uatu shows the correlated result and the actual resumed parent activity
- **AND** it sends neither a duplicate notification nor an extra resume operation

#### Scenario: Untrusted lookalike content
- **WHEN** a human message or ordinary tool text contains a subagent-looking envelope without matching provider-authored metadata
- **THEN** it remains inert content and changes no worker state
- **AND** markup and unsafe links in genuine reports remain inert under the existing rendering rules

#### Scenario: Correlation is ambiguous
- **WHEN** a notification names a reused child but the available evidence cannot distinguish which task occurrence it completes
- **THEN** the report remains readable and linked to the verified child without speculatively settling a different occurrence
- **AND** affected state is visibly uncertain until authoritative evidence resolves it

#### Scenario: Worker completion is not a top-level push completion
- **WHEN** a child finishes or an old result is recovered on reconnect
- **THEN** no successful top-level-turn push notification is emitted for that event

### Requirement: OpenCode V2 worker state recovers without relying on provider event replay
Opening or returning to a conversation, reconnecting after missed provider events, or replacing an expired Uatu stream cursor SHALL reconcile its known background work against provider-owned history, pending notifications, and available current execution evidence. The final snapshot and subsequent stream SHALL agree without duplicate workers or state regression. Recovery SHALL include launches and results outside the initially visible history page and work launched from another client. Parent idleness, an absent child from an active-only listing, or a failed read SHALL NOT alone establish a worker's terminal state.

Recovery SHALL be read-only with respect to execution: it MUST NOT prompt, interrupt, relaunch, or background work. After a service/workspace restart, completed provider history SHALL remain inspectable and unresolved work SHALL be revalidated; Uatu MUST NOT promise continued execution solely because a pre-restart launch exists.

#### Scenario: Completion is missed while disconnected
- **WHEN** a worker completes while the V2 event connection is absent and the provider offers no replay
- **THEN** reconnect recovers its terminal result from history or pending notification state
- **AND** the worker does not remain running indefinitely or become falsely cancelled from list absence

#### Scenario: Completion races a stale snapshot
- **WHEN** a worker terminal event arrives while recovery is reading an older running launch
- **THEN** applying recovery and the event stream leaves one terminal worker with its report

#### Scenario: Navigation and pagination preserve the worker
- **WHEN** the user switches sessions or workspaces, then returns to a parent whose launch is on an older page
- **THEN** current worker state and its child inspection link are available without manually loading every older page
- **AND** loading older pages does not duplicate the worker

#### Scenario: Another client launches work
- **WHEN** native background work is launched in a confined parent by another OpenCode client while Uatu is disconnected
- **THEN** Uatu discovers that work when it next reconciles the parent or workspace activity

#### Scenario: Restart has inconclusive execution evidence
- **WHEN** persisted history contains a background launch but current provider evidence cannot establish whether it survived a restart
- **THEN** Uatu reports uncertainty and retains available history without claiming durable execution or fabricating a final result

### Requirement: Users explicitly continue the parent while all eligible blocking jobs run
For OpenCode V2 that declares backgrounding support, Chat SHALL offer a distinct action labelled `Continue while workers run` only while an active parent has running blocking tool/command or confirmed foreground-task evidence. Pending tools, a merely generating parent, and launchers already correlated to detached, settled or uncertain workers SHALL NOT expose it. A tooltip and collapsed explanation SHALL state that it backgrounds all eligible blocking jobs in that parent, including shell commands, without stopping them. It SHALL use the provider's native parent-wide background operation and MUST NOT imply selected-child scope or an exact eligible count the provider does not report. If nothing remains eligible when the request reaches the provider, the action SHALL be a harmless accepted no-op. Accepted feedback SHALL clear once the parent and workers settle and no background request is in flight.

The mutation SHALL be authenticated, workspace-confined, origin-protected under cookie authentication, and agent-qualified. It SHALL deduplicate a client request identifier while its in-memory receipt is retained. Its acceptance SHALL NOT be represented as proof that a specific worker is running. If the provider may have applied a dispatched mutation but its response is lost, Uatu SHALL retain an explicit unknown outcome within the same bounded receipt lifetime rather than discard it as an ordinary retryable error. A retained unknown outcome SHALL produce explanatory uncertainty, not a false acceptance, and retries against that retained receipt SHALL not dispatch again. Concurrent duplicate actions SHALL be suppressed within that retention scope.

Receipt retention SHALL be bounded: the default settled lifetime is up to 15 minutes, capacity eviction can end it sooner, and adapter recreation or process restart ends it entirely. No persistent receipt storage is required. The contract SHALL NOT promise deduplication after any of those boundaries; an old identifier with no retained receipt can be treated as a new request. The client SHALL NOT automatically replay an uncertain mutation on reconnect or reload, including with the same identifier. It SHALL recover state read-only and require a fresh explicit action before making another attempt.

The action MUST NOT cancel a parent or worker, send or clear a draft, change model/mode/delivery preferences, flush a held queue, or manufacture steers. Sending or selecting a delivery mode SHALL NOT implicitly background work. Unsupported agents SHALL have no such action.

#### Scenario: Mixed blocking jobs become background work
- **WHEN** the parent is blocked by two eligible subagents and a native shell job and the user activates Continue while workers run
- **THEN** one parent-wide background operation is requested for all eligible jobs, not only one selected child
- **AND** provider-confirmed background jobs remain visible and inspectable while the parent can continue
- **AND** no interrupt or prompt is sent by the action

#### Scenario: No eligible blocker remains
- **WHEN** all blockers finish just before the background request reaches OpenCode
- **THEN** the accepted no-op neither invents running workers nor raises a task failure

#### Scenario: A busy parent has no running blocker
- **WHEN** the parent is generating, has only pending tools, or has already detached its workers
- **THEN** Continue is absent rather than suggesting another background operation

#### Scenario: Retrying a lost response does not affect newer jobs
- **WHEN** Uatu has recorded the outcome, the browser response is lost, and the same client request identifier is retried while that receipt is still retained after another blocker appears
- **THEN** Uatu returns the recorded outcome without issuing the operation again or affecting the newer blocker

#### Scenario: Upstream response is lost after application
- **WHEN** OpenCode applies the background request but the response to Uatu is lost and the provider call fails ambiguously
- **THEN** Uatu retains an unknown outcome instead of deleting the receipt as a retryable failure
- **AND** a same-identifier retry while that receipt is retained returns uncertainty without a second native operation, even if newer blockers have appeared

#### Scenario: Receipt retention ends
- **WHEN** an operation's receipt expires, is evicted for capacity, or is lost with adapter recreation or process restart
- **THEN** Uatu does not claim that resubmitting the old identifier is deduplicated
- **AND** the client does not automatically replay an uncertain request, but refreshes state and requires a new explicit action before another attempt

#### Scenario: Draft and steering state are preserved
- **WHEN** Continue while workers run is activated with a staged draft, attachments, a pending steer, and held queued messages
- **THEN** those values remain intact and no pending user input is edited, removed, or sent by that action
- **AND** subsequent provider lifecycle transitions follow the existing steering and queue rules

#### Scenario: Unsupported or foreign request
- **WHEN** an unsupported agent, unauthorized client, cross-origin cookie request, or foreign-workspace parent is targeted
- **THEN** Uatu rejects the mutation without contacting a worker or revealing foreign session content

### Requirement: Parent stop and worker stop have explicit separate effects
For V2 background work, Chat SHALL distinguish parent interruption from stopping one verified worker. Parent Stop SHALL interrupt the current parent execution without explicitly waking pending input, leave held queue/steer behavior governed by the existing cancellation contract, and not stop detached workers. The UI SHALL explain that still-blocking foreground work can be cancelled by parent interruption and that future provider-owned worker notifications can wake the parent again. With no parent execution, parent Stop SHALL remain disabled rather than become a stop-all-workers action.

On touch, activating Stop parent with worker records SHALL first open an in-app scope explanation and confirmation. Cancelling SHALL make no cancellation request; confirmation SHALL recheck that the same parent still has live work before acting. Desktop parent-stop behavior and native cancellation scope remain unchanged.

Worker Stop SHALL resolve the selected task under its verified parent/workspace and target only that worker's native execution. A known stale, settled, uncertain, foreign, or unrelated task target SHALL be refused without redirecting the request to a newer child occurrence. Worker-stop receipts SHALL use the same bounded retention, preservation of transport-ambiguous outcomes, and no-automatic-replay behavior specified for backgrounding; deduplication SHALL NOT be promised after expiry, eviction, adapter recreation, or process restart. An accepted interruption SHALL show pending stopping feedback until authoritative settlement; it SHALL NOT overwrite a confirmed completed result with stopped. Native effects on a worker's own blocking descendants remain provider semantics, not a new stop-all operation.

Native shell Stop removes the provider's shell record and output. The UI SHALL explain before activation that output can become unavailable and the provider may report a failed result rather than cancellation. Removal acknowledgement or a missing output record SHALL NOT alone establish a cancelled job. Uatu SHALL preserve a confirmed completed result if capture and completion already won the race; if removal prevents the final capture and the provider reports error, it SHALL present failed with output-unavailable context rather than force completed or stopped.

Shell Stop SHALL use an in-app confirmation with Cancel initially focused. Escape SHALL cancel that confirmation without closing the child/output view, restore the invoking control or surviving equivalent, and send no mutation. Confirmation SHALL revalidate current task state before dispatch.

#### Scenario: Touch parent-stop confirmation explains detached work
- **WHEN** a touch user activates Stop parent with worker records present
- **THEN** the confirmation explains still-blocking work, continuing detached workers and possible later provider wakeup
- **AND** Cancel leaves work untouched while confirmation cancels only the same still-live parent execution

#### Scenario: Stop parent with mixed workers
- **WHEN** the parent has both still-blocking foreground children and detached background children and the user selects Stop parent
- **THEN** the parent is interrupted and foreground dependencies follow native cancellation semantics
- **AND** detached workers continue, stay inspectable, and held user input is not resumed by that stop

#### Scenario: Stop one detached child
- **WHEN** the user stops one verified running background child
- **THEN** only that child's execution is targeted and sibling detached workers are not interrupted
- **AND** the parent is not explicitly interrupted or resumed by Uatu

#### Scenario: Completion wins a stop race
- **WHEN** a completed worker result is confirmed before the requested interruption settles
- **THEN** its confirmed completed result remains completed rather than being overwritten with an optimistic stopped outcome

#### Scenario: Worker-stop response is lost upstream
- **WHEN** OpenCode may have applied a child interruption or shell removal but Uatu loses its response
- **THEN** Uatu retains an unknown receipt outcome within the bounded retention scope and reconciles state without an automatic mutation retry
- **AND** same-identifier retries while retained do not issue another interruption or removal

#### Scenario: Removal prevents a shell's final capture
- **WHEN** shell removal deletes its record/output before the plugin completes its result capture, including after the process has exited, and the provider reports error
- **THEN** the task shows failed with stop-request and output-unavailable context, not invented cancellation or success
- **AND** record deletion or a removal acknowledgement is not itself treated as a terminal job notification

#### Scenario: Shell result capture wins the removal race
- **WHEN** the provider has captured and confirmed a completed shell result before removal makes further output reads unavailable
- **THEN** the completed result is retained without an optimistic stopped outcome
- **AND** unavailable additional output is disclosed independently of the completed result

#### Scenario: Stop acknowledgement precedes settlement
- **WHEN** the provider acknowledges interruption before its cleanup and terminal notification finish
- **THEN** the task shows Stopping feedback and suppresses duplicate stop requests
- **AND** its final outcome follows confirmed provider evidence

#### Scenario: Old stop target has been superseded
- **WHEN** a stop references an old task and reconciliation already identifies a newer execution in that same child session
- **THEN** the stop is refused without interrupting the newer execution

#### Scenario: Late completion notification resumes a stopped parent
- **WHEN** OpenCode subsequently wakes the parent for a detached worker's notification after the user stopped an earlier parent turn
- **THEN** Chat shows that actual new parent activity without claiming that Stop permanently disabled future wakeups

### Requirement: Background inspection and controls remain accessible and workspace-confined
V2 background children SHALL open through the existing parent drill-down while running and after settlement, by their verified child identity rather than top-level picker membership. The parent selection, draft, attachments, reading state, and return path SHALL be preserved. A failed child read SHALL retain the parent and provide actionable Retry feedback rather than navigate to a different conversation or leave a dead control. Child permissions/questions SHALL remain reachable through existing interaction handling. No direct child messaging control is introduced.

Native shell work affected by backgrounding SHALL retain inspectable already-received output and outcome through the task inspection surface within their existing retained view/history lifetime; reads and stops SHALL verify its workspace and parent ownership and SHALL NOT accept arbitrary output paths. When provider removal deletes output, the surface SHALL explain that further output is unavailable, preserve what is still locally available, and not promise that lost bytes can be recovered after reload. No persistent output archive is required. Both task inspection and result rendering SHALL preserve existing output safety and distinguish upstream truncation from output removal.

Desktop pointer, keyboard, and touch users SHALL be able to inspect workers, return to the parent, request backgrounding, and stop a verified worker using labelled controls with visible focus, at least 44 CSS pixel targets and 8 CSS pixel gaps between adjacent mutation actions. State and failure SHALL be conveyed in words, not colour or animation alone. Reduced-motion preferences SHALL be respected. Dynamic updates SHALL NOT steal focus, discard reading position, or replace the existing separate Send, delivery selector, and Stop actions. Opening a child SHALL move focus into its view; return SHALL restore the invoking control or a logical surviving equivalent. Layered output Escape SHALL NOT also dismiss its owning child view.

The live worker list SHALL remain reachable through the bounded scrollable work dock while composing without a software keyboard, except in short touch landscape. With the software keyboard open, or in a visual band at most 390px high and at least 600px wide, worker/subagent tracks and Continue SHALL be hidden to preserve conversation and composer space; dismissing the keyboard or leaving short landscape SHALL restore access. Compact pending counts, any paused-batch Send action and replacement warnings follow the steering dock's safety rules and SHALL remain available while typing. The secondary subagent presentation SHOULD stay collapsed by default when the open background list already exposes the same workers. Worker Stop and parent Stop SHALL be distinctly labelled; routine worker appearance SHALL preserve the reserved composer control geometry. Expanded touch work tracks SHALL keep the prompt rail from covering worker actions.

The shared touch work dock SHALL observe the visual-height budgets and final-height reservation specified by the steering composer/dock contract, rather than separately budgeting each track. This includes the 24% cap during hardware-keyboard editing when both cards are collapsed, the measured small-strip policy when either is expanded, and reduced-motion handling. These compact-layout rules do not change worker execution, ownership, stop targets or the existing interaction-request answering flow.

#### Scenario: A child excluded from the picker opens reliably
- **WHEN** a user opens a verified background child from its running task or historical result on desktop or touch
- **THEN** its exact transcript opens with the parent still selected and a first-class way back
- **AND** settlement while it is open updates the task outcome without closing the transcript

#### Scenario: A temporary child read failure is recoverable
- **WHEN** opening a child fails transiently
- **THEN** the parent and draft remain intact and Retry can open the same child after recovery

#### Scenario: Keyboard and touch control separation
- **WHEN** a narrow desktop or touch user navigates visible task controls by keyboard or taps adjacent action targets and gaps
- **THEN** inspection, Continue, worker Stop, Send, and parent Stop remain distinguishable and reachable without overlapping hit regions
- **AND** focus restoration and status announcements do not submit a draft or trigger another action

#### Scenario: Continue is first-touch usable while composing
- **WHEN** the touch composer is focused in a layout where Continue is visible and the user taps Continue while workers run
- **THEN** that first tap submits exactly one background request without losing the composing draft or its focus

#### Scenario: Keyboard and short landscape defer worker controls, not pending safety
- **WHEN** a touch parent composer enters software-keyboard mode or short landscape with live workers and pending messages
- **THEN** worker tracks and Continue are hidden while the compact pending counts, paused-batch Send and replacement warning remain available as applicable
- **AND** leaving that compact state restores worker access without stopping work or losing the draft

#### Scenario: Foreground work becomes a duplicate background presentation
- **WHEN** foreground work is detached on touch and its subagent track was expanded automatically
- **THEN** the duplicate subagent track collapses while the background controls remain open
- **AND** a track deliberately reopened by the user remains open

#### Scenario: Automatic expansion survives a conversation switch
- **WHEN** conversation A automatically opens its foreground track, the user selects B without touching the disclosure, and B's foreground work is detached
- **THEN** the retained open state remains classified as automatic and the duplicate track collapses in B
- **AND** provenance for a deliberately opened retained track stays deliberate

#### Scenario: Shell settles while confirmation is open
- **WHEN** settlement removes the invoking shell Stop control before the user dismisses its confirmation
- **THEN** Escape keeps the inspection open, sends no removal and restores its surviving result action or logical inspection equivalent before the composer

#### Scenario: Shell output and stop remain owned by the task
- **WHEN** a native shell job is backgrounded alongside subagents
- **THEN** its available output and terminal outcome remain inspectable, and stopping it targets only its verified shell execution
- **AND** another session's shell identity or arbitrary filesystem output path is refused

### Requirement: V2 background work participates in workspace activity without false completion
Confirmed live V2 background work SHALL keep the existing workspace activity summary working even while its parent is idle, unselected, or viewed from another workspace. Requests needing user input SHALL retain existing needs-answer priority. Once all confirmed work settles and no parent turn remains, normal finished/unviewed behavior SHALL apply once. A failed or incomplete reconciliation SHALL NOT create a finished transition merely by dropping unknown tasks. Activity messages SHALL retain their existing bounded, content-free contract and authenticated workspace scope.

#### Scenario: Unselected parent still has work
- **WHEN** the parent finishes its response but a detached child continues while the user views another workspace
- **THEN** the owning workspace remains working in the activity summary
- **AND** returning to it exposes the same live child without another launch

#### Scenario: Worker needs input while the parent is idle
- **WHEN** a detached worker raises a permission request or question
- **THEN** the owning workspace reports needs-answer and the request remains reachable from the parent

#### Scenario: Last worker settles or recovery fails
- **WHEN** the last confirmed worker settles with no parent turn active
- **THEN** normal workspace-finished behavior occurs once
- **AND** a later replay, duplicate notice, or failed refresh does not create another completion
