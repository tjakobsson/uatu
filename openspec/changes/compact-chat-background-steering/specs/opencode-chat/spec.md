## MODIFIED Requirements

### Requirement: The composer's subagent list counts subagents and tasks distinctly
On desktop the composer's subagent list SHALL keep one row per task, and its summary line SHALL NOT count a subagent once per task it was given. Where every task went to its own subagent the summary SHALL count subagents as it does today. Where a subagent was given more than one task, the summary SHALL state the number of distinct subagents and the number of tasks.

On touch, the compact worker disclosure SHALL replace duplicate pinned subagent/background lists with one canonical row projection and renderer. The summary and rows SHALL count the same worker execution occurrences rather than launcher aliases. Ordinary foreground shell commands SHALL remain in the timeline and SHALL NOT count as workers; actual background shell tasks SHALL count. Historical timeline launch/result records, distinct task references and their model/cost attribution SHALL remain available through inspection and the timeline; consolidation SHALL NOT create a second lifecycle or combine separate worker executions into one.

#### Scenario: One task per subagent reads as before
- **WHEN** a desktop conversation launched four subagents with one task each and all have finished
- **THEN** the summary reads "4 subagents finished"

#### Scenario: A subagent given two tasks is one subagent
- **WHEN** a desktop conversation launched three subagents, gave one of them a second task, and all have finished
- **THEN** the list shows four rows
- **AND** the summary reads "3 subagents · 4 tasks finished"

#### Scenario: Touch worker summary avoids launcher duplicates
- **WHEN** two launching task references refer to the same confirmed live worker occurrence
- **THEN** the touch summary counts one working occurrence
- **AND** expanding it shows one inspection row, with both launch references and their attribution retained in the timeline rather than duplicate worker rows

## ADDED Requirements

### Requirement: Pointer Send steers and an intentional two-second hold queues
For steering-capable agents, tapping Send SHALL explicitly steer ordinary busy text independently of the saved keyboard delivery preference. This supersedes the earlier selected-delivery rule for the visible Send button only. Desktop Enter, touch Ctrl/Command+Enter, Alt/Option+Enter, and touch plain-Enter newline semantics SHALL retain their existing preference behavior. Busy commands and attachment-bearing composer drafts SHALL queue with truthful labels; native staged-replacement semantics SHALL remain unchanged. Unsupported agents SHALL retain ordinary queued/idle behavior.

A continuous two-second pointer or focused-Send Space hold SHALL automatically submit Queue once, without waiting for release. Release before 250ms SHALL steer once; release from 250ms until two seconds SHALL cancel without sending. Drag outside the original fixed Send bounds, movement of the target, pointercancel, lost capture, window blur, page hiding, Escape, changed draft/attachments/configuration/selection, or active submission/cancellation locks SHALL invalidate the gesture and all stale timers. Keyboard focus leaving Send SHALL cancel its Space hold. Every timer/frame SHALL recheck current page visibility/focus and owned immutable draft identity before dispatch. The viewport-owned pointer-transparent visual envelope SHALL grow from 56px to 104px above the original target during the hold, bounded by visible viewport space, fill bottom-to-top and place the countdown above the finger without shifting layout or enlarging the hit area. It SHALL escape composer/dock clipping and remain unobstructed above the finger; a fixed-height envelope with internal fill alone SHALL NOT satisfy upward growth. Reduced motion SHALL retain the full extension, progress and countdown without envelope growth. Send SHALL expose concise aria-describedby instructions for hold/cancel and existing keyboard shortcuts; Enter on Send SHALL activate immediately. There SHALL be no visible Send/Steer/Queue dropdown or replacement menu. This supersedes earlier visible delivery-selector clauses, while preserving saved message-field keyboard preferences. Idle held Queue SHALL dispatch using existing normal idle semantics, not create fake pending input. Existing authoritative personal background policy SHALL govern accepted steer actions without a second browser background request.

#### Scenario: Quick tap and intentional hold have distinct outcomes
- **WHEN** a busy ordinary draft is tapped, intentionally held then released early, or continuously held for two seconds
- **THEN** it respectively steers once, sends nothing, or queues automatically once before release
- **AND** subsequent click, release and timer events cannot duplicate that action

#### Scenario: A stale or inactive hold never sends
- **WHEN** the tab loses visibility/focus, a pointer is cancelled or leaves the original button, Escape is pressed, or the owned conversation/draft/configuration changes
- **THEN** the hold and any delayed timer are cancelled without steering or queueing
- **AND** the draft and attachments remain available

#### Scenario: Accessible keyboard and idle holds stay truthful
- **WHEN** the user holds Space on Send for two seconds, or completes an idle pointer hold
- **THEN** the existing adapter decides held versus normal idle dispatch without inventing pending messages
- **AND** Escape cancels without a later native Space click and Enter on Send remains immediate

### Requirement: Native side answers stay outside foreground conversation admission
Only an agent with verified native one-shot context generation SHALL declare `side-generation` and offer `/btw <question>`. OpenCode V2 SHALL use `session.generate`, with the native TUI's concise-answer/no-tools/no-actions instruction, without prompt admission, history mutation, foreground interrupt/resume/background, or an agent tool execution loop. The implementation SHALL NOT substitute a foreground prompt or a new child agent. Native generation may advertise tool definitions but SHALL NOT execute a returned tool call; empty text SHALL be explained honestly. User-installed native plugin hooks remain outside this tool-loop guarantee.

The internal aside action SHALL retain existing authentication, origin, base-path, qualified-agent and workspace-ownership gates, accept a closed `{requestId, question}` body with nonempty question bounded to 16,384 UTF-8 bytes, and return closed `{text}` with no-store. Unsupported providers SHALL refuse honestly; V1/Claude SHALL not offer the command, and a typed `/btw` SHALL not fall through into ordinary prompt admission. Pending attachments SHALL be refused and retained. The initiating page SHALL prevent concurrent duplicate side requests, preserve newer composing drafts on failure and never automatically replay inference. Responses SHALL remain page-local and not be cached in shared workspace action receipts. Completion SHALL expose a deliberate answer-opening action without stealing composing focus; no provider-history persistence or durable exactly-once inference is promised.

#### Scenario: A side question does not interrupt foreground work
- **WHEN** a V2 conversation is running and the user submits `/btw` with a question
- **THEN** one native generate request answers from current context without prompt/interrupt/background calls
- **AND** provider history, pending inputs and foreground running state remain unchanged

#### Scenario: Unsupported side generation never becomes a prompt
- **WHEN** V1/Claude receives a typed `/btw`, or a side question has pending attachments
- **THEN** the surface refuses and keeps the draft/attachments without any foreground admission or fallback agent call

#### Scenario: Side answers are personal page state
- **WHEN** side inference completes while the user is composing another draft or has switched conversations
- **THEN** the answer remains associated with its initiating conversation without focus theft or draft loss
- **AND** no shared receipt exposes one user's side response to another user reusing an identifier

## MODIFIED Requirements

### Requirement: Touch pending messages and workers use compact deliberate disclosures
Touch chat SHALL show at most one initially collapsed pending-message summary and one initially collapsed worker summary, omitting an empty summary. Pending text SHALL identify only nonzero steer/queued categories without repeating the total, such as `1 queued` or `2 steers · 1 queued`. Its header and inline pending actions SHALL use the approved 32px minimum density exception with independent 8px gaps including before Remove, preserving existing confirmations. Cards SHALL share compact delivery labels and message content on a line where space permits rather than forcing three rows; long messages and warnings SHALL remain readable. Worker text SHALL identify confirmed working and finished occurrences, such as `2 working · 4 finished`; finished SHALL include terminal failures/stops without implying successful completion. Uncertain workers SHALL be separately named rather than counted as confirmed working or finished. Dismissed counts SHALL NOT be visible; when no visible workers remain the whole worker card SHALL be absent. New work, replay and settlement SHALL update the summaries without automatically expanding touch details. Deliberate per-conversation expansion SHALL survive repaint, reselection and viewport changes within the page without leaking to other conversations.

Pending message leading SHALL scale with text size, preserving 14px type/20px leading at default size and 28px/40px at 200% root text. Multiline glyph rectangles SHALL remain vertically separated; enlarged multiline and image-containing cards SHALL grow naturally within the existing dock scroller without horizontal overflow or reduced mutation targets.

After replacement changes the available actions, pending footers and action groups SHALL shrink to their card's content width and long labels such as `Send now + paused steers` SHALL wrap without clipping or truncation. Cards and their shared dock SHALL NOT acquire horizontal scrolling. Actions SHALL retain at least 32px targets and independent 8px gaps, and SHALL be fully exposable within all clipping ancestors. In text-relative narrow containers up to 12rem, a paused-batch header SHALL scroll with the dock rather than obstruct a whole wrapped action; standard-size sticky counts SHALL remain unchanged. Existing confirmation wording, cancellation without mutation and confirmed paused-batch delivery semantics SHALL remain unchanged.

Expanded pending details SHALL retain delivery order and existing edit/remove/convert/Send now actions. Expanded worker details SHALL retain inspection, truthful terminal outcomes, available shell output and existing parent/worker-stop safeguards. Replacement consequences, paused-batch warnings and applicable batch Send, and actionable operation failure/uncertainty SHALL remain visible outside collapsed details. Desktop disclosure defaults SHALL remain unchanged. The collapsed touch defaults are an explicit exception to earlier automatic-running-track expansion behavior.

Expanded worker details SHALL show one flat list: confirmed working and unknown workers first, then finished workers ordered newest first from available execution timestamps, without a separate Finished disclosure. Each occurrence SHALL have one single-line inspection target containing a state glyph, 14px name, real model and explicitly cumulative Σ usage where reported (11px metadata). State-specific glyphs SHALL distinguish working, unknown, finished, failed and stopped without repeated visible status labels. Inspection targets and settled rows SHALL use the approved density exception of at most 28px at default text scale; only rows containing Stop SHALL grow to its separate 44px target with an 8px gap. A settled glyph SHALL NOT imply live work. The compact main header SHALL use a small chevron rather than a native triangle, expose its expanded state accessibly, and contain Dismiss finished on the right in the same row, without a footer or duplicate finished count. Dismiss finished SHALL persist view-only hiding through the existing per-conversation dismissal seam without displaying hidden counts or deleting provider history. Short or empty lists SHALL NOT reserve unused height after dismissal. Restore finished SHALL be absent, with no replacement visible control. Settled results and inspection SHALL remain reachable from the timeline. Only current owned, confirmed live background workers SHALL offer enabled Stop worker; an unknown outcome SHALL disable Stop. Only live workers SHALL cause the parent Stop label to read Stop parent. Known successful automatic-background acknowledgements MAY clear on status change or complete settlement; failed, unavailable and unknown outcomes SHALL remain persistent.

#### Scenario: Loaded touch chat starts compact
- **WHEN** a touch conversation has two pending steers, one queued message, two working and four confirmed terminal worker occurrences
- **THEN** its pending and worker summaries are collapsed and show their respective counts
- **AND** no second pinned worker list duplicates the same work

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
- **THEN** the confirmed terminal occurrences contribute to finished with their individual outcomes available in details
- **AND** the unresolved occurrence is named uncertain rather than declared finished or successful

#### Scenario: Dismissing finished workers preserves timeline history
- **WHEN** the user dismisses finished workers and reloads the conversation
- **THEN** those overview rows remain hidden without a Restore finished button or replacement menu
- **AND** their retained reports and existing transcript inspection remain reachable in the timeline, without provider history deletion

### Requirement: Compact touch composition preserves safe targets and conversation space
Touch chat SHALL keep inline Attach, one two-line agent/mode/model/effort and actual-context pill, Send with described Space-hold Queue access, and separate Stop. The pill SHALL directly open the existing single adaptive configuration picker and SHALL show actual occupancy plus used/limit where known, explicitly distinguishing unreported/estimated values from cumulative usage. The top Options trigger/panel and duplicate touch context circle SHALL be absent. Unique account usage and explicit Continue/help SHALL remain reachable outside that removed panel; standalone Continue SHALL be preserved. Visible composer action targets SHALL be at least 44×44 CSS pixels, with at least 8px separation between adjacent mutation actions, visible focus and non-overlapping hit regions. Unsupported actions SHALL be absent. Existing keyboard delivery preferences and touch Enter newline semantics SHALL remain unchanged.

The in-flow dock SHALL retain the existing aggregate visual-height caps: 35%, 25% from 48rem width, and 24% during hardware-keyboard editing. Standard-size loaded phone layouts SHALL leave at least 40% of the visual band for the transcript; the tested tablet layouts SHALL leave at least 35%. Software-keyboard and short-landscape states SHALL retain the compact worker summary; deliberate expansion MAY overlay the transcript above the composer when inline details cannot meet those budgets, sized to content rather than forcing short lists to fill the sheet. The dock SHALL have one scroller rather than nested worker lists. Opening and closing the overlay SHALL preserve composing drafts and owned focus without forced keyboard blur. Composer Attach/picker/Send/Stop and existing pending replacement/batch safety SHALL remain reachable. Safe-area handling, measured desktop geometry, explicit bottom pinning, remote reading anchors and interaction-request answering SHALL be preserved. Larger text SHALL retain readable warnings and reachable primary controls using scrolling/reduced secondary content rather than shrunken targets.

Menus SHALL fit the visual viewport, support keyboard navigation and one-layer Escape with invoker restoration, and consume outside touch dismissal without activating underlying actions. Visible controls SHALL activate reliably on the first tap during composition without discarding drafts or attachment/configuration state. Live updates and reduced-motion presentation SHALL NOT steal focus or fabricate completion announcements.

#### Scenario: Keyboard and landscape keep conversation space
- **WHEN** loaded touch chat uses 390px width with a 380px or 450px visual band, or 844px landscape width with a 230px visual band and the existing safe-area fixtures
- **THEN** Attach, the real picker, Send and Stop fit inside the visual band with their minimum targets/gaps
- **AND** at least 40% remains for the transcript while pending replacement/batch safety remains reachable

#### Scenario: Hardware keyboard and tablet budgets stay bounded
- **WHEN** loaded 390×844 chat is focused without a software keyboard, or the tested 768×1024 and 1024×768 tablet layouts are used
- **THEN** the aggregate dock respects its applicable height cap and bottom safe inset
- **AND** the transcript keeps the phone/tablet minimum share without outer-surface scrolling

#### Scenario: Options dismiss without executing an underlying action
- **WHEN** a touch user taps outside the configuration picker over Revert, Send or Stop
- **THEN** only the picker dismisses and no underlying mutation is sent
- **AND** Escape closes only the top layer and restores its invoker or surviving equivalent

#### Scenario: Disclosure changes preserve the reading intention
- **WHEN** pending/worker details expand, collapse or settle while the reader is remotely scrolled or explicitly bottom-pinned
- **THEN** the current reading anchor or explicit bottom-pin intention is preserved respectively
- **AND** controls remain hit-testable after final layout reservation and reduced-motion handling

### Requirement: Desktop work shares measured panel space
Desktop worker tracks and pending messages SHALL share an aggregate scroller capped at 40% of the actual measured chat panel height and 25rem. The aggregate SHALL yield further to reserve the lesser of 12rem or 35% of that panel for the transcript while keeping the composer fully visible. Existing desktop disclosure defaults, per-track rem caps, drafts, focus and reading intent SHALL remain intact. A newly staged replacement warning SHALL be revealed once after composer layout settles; subsequent updates SHALL respect deliberate dock scrolling.

#### Scenario: Detached worker and pending steer coexist in a short split
- **WHEN** default-split desktop chat has a running turn, one pending steer and one detached worker at 1280×600 or 1280×480
- **THEN** Send and Stop are fully inside the measured panel and center-hit-testable without collapsing tracks
- **AND** the transcript retains its reserved space, the draft/focus survives resizing, and a subsequent Revert reveals its replacement consequence

#### Scenario: Long history cannot compress actionable work into a sliver
- **WHEN** long history, a live worker and pending input coexist in a short desktop panel
- **THEN** non-empty work reserves at least max(52px, 3.25rem) when feasible, yielding transcript space down to its reserved floor first
- **AND** keyboard navigation can expose the full 44px worker action and its visible focus outline within every clipping ancestor
- **AND** if the measured remaining space cannot fit that minimum, an accessible 44px Show work entry opens a scrollable sheet above the composer, with Close work/Escape restoring the entry while retaining drafts and warnings

### Requirement: Accepted Hub steer actions can automatically background eligible work
For an initiating Hub account whose authoritative personal preference is ON, chat SHALL consider one automatic native background-all follow-up after a confirmed steer action on an agent supporting both steering and background-blocking-work. This includes new composer steers, Queue → Steer, Send now of held input or paused steers, and submitted Undo/revert replacement steers. A paused batch resume SHALL result in at most one follow-up per accepted user action, not per resumed message. The initiating user's policy SHALL apply even in a workspace shared with users having different preferences, without changing those users' settings.

Automatic follow-up SHALL additionally require verified Hub policy authority bound to the current child instance, independent of the workspace/terminal credential. Missing bootstrap trust SHALL produce explanatory automatic-background-unavailable state rather than infer ON or trust unsigned principal metadata. This SHALL NOT undo an otherwise accepted steer or weaken existing primary-action access checks; a valid workspace credential alone SHALL NOT grant Hub principal authority.

The primary admission/resume SHALL be confirmed first; an optimistic message, timeout or staged replacement SHALL NOT count as acceptance. The automatic follow-up SHALL use current verified parent-scoped running-blocker evidence. Merely generating, pending, already detached, settled or uncertain work SHALL NOT force a background request; absent evidence SHALL NOT schedule a later job-start follow-up. Native eligibility racing to empty SHALL be an accepted no-op, not failure. The native operation affects all jobs still eligible when executed, including shell commands; it SHALL NOT be described as targeting one selected child or a fixed snapshot of workers.

This is the scoped exception to the earlier rule forbidding implicit backgrounding on sending: outside confirmed Hub steer actions with ON policy and both capabilities, that rule remains in force. Ordinary queued/idle sends, job starts, preference/menu selection, Undo/revert staging alone, repeated no-op conversion, standalone and unsupported agents SHALL retain existing behavior. Automatic backgrounding SHALL NOT create a steer, launch a new agent, flush the Uatu queue or change staged configuration/delivery preferences. Native steer next-step delivery, paused batch behavior and resume/interruption semantics remain authoritative; the UI SHALL NOT promise immediate delivery, atomic admit-and-background, or preservation of every foreground worker across native resume.

#### Scenario: Each accepted steer action qualifies once
- **WHEN** an ON Hub account confirms a new composer steer, Queue → Steer, held-message Send now or submitted replacement steer while verified eligible blocking evidence remains
- **THEN** its primary admission and pending transition complete before at most one native background-all attempt for the same parent
- **AND** the accepted message and attachments remain intact independently of the follow-up outcome

#### Scenario: Send now resumes a paused batch
- **WHEN** an ON Hub account successfully sends one paused steer now and native resume wakes all paused steers
- **THEN** the existing batch behavior is preserved without admitting duplicate prompts
- **AND** the action makes at most one post-resume eligible background attempt, with no promise that resume preserved still-blocking foreground work

#### Scenario: Admission has not been confirmed
- **WHEN** a steer is refused, pending admission exceeds its bound, or a resume outcome is ambiguous
- **THEN** no automatic background mutation follows that action
- **AND** uncertainty is reconciled without automatically resending or later backgrounding on a job event

#### Scenario: Private policy trust is unavailable after child replacement
- **WHEN** an ON account's steer is otherwise accepted but the replacement child has not established verified current-instance Hub policy trust
- **THEN** no automatic follow-up is authorized using a workspace credential, old-instance signature or unsigned principal metadata
- **AND** the accepted steer is preserved with explanatory unavailable feedback and existing explicit Continue behavior where permitted

#### Scenario: Nothing qualifies after acceptance
- **WHEN** an accepted steer leaves no verified running-blocker evidence, or workers are only detached/settled/uncertain
- **THEN** no automatic background call is forced and no future job-start watcher is installed

#### Scenario: Mixed eligible jobs race with native execution
- **WHEN** an accepted steer is followed by one background request while eligible subagents and shell jobs block that parent
- **THEN** native all-eligible behavior is used rather than a subagent-only operation
- **AND** a race to no eligible jobs is harmless while a new blocker present at native execution is not promised exclusion

#### Scenario: OFF, unsupported and non-steer actions do not trigger automation
- **WHEN** the preference is OFF, no Hub account context exists, either capability is absent, or the action is a queue/idle send, menu choice, job start, replacement staging or no-op conversion
- **THEN** no automatic background request occurs and existing delivery/Continue behavior is preserved

### Requirement: Automatic background outcomes never erase or resend accepted steer actions
Affected action responses SHALL distinguish the primary steer/resume outcome from any automatic-background outcome. Once primary acceptance is confirmed, a follow-up refusal, unavailable evidence, timeout or ambiguous response SHALL preserve and report the accepted primary action; it SHALL NOT restore it as a failed draft, roll it back to the queue, or resend it. Background acknowledgement SHALL mean only request acceptance, not a count of affected workers, immediate steer delivery or worker completion. Actionable partial/unknown outcome text SHALL remain visible outside collapsed details with read-only state recovery and capability-gated explicit Continue available when eligible; no automatic mutation retry is introduced.

The composite operation SHALL share original admission ordering and retain primary plus follow-up results under an initiating-account-scoped receipt. While retained, a same-identifier retry SHALL return the same result without repeating primary admission/resume or backgrounding, reevaluating a changed preference or affecting later blockers. A primary-unknown or follow-up-unknown outcome SHALL be retained rather than treated as a retryable deleted failure; no follow-up SHALL start after a timed-out primary or from late evidence. The client SHALL NOT automatically replay uncertain mutations across reconnect/reload. Receipt expiry, capacity eviction, adapter recreation or restart end deduplication; the system SHALL NOT promise durable exactly-once execution across those boundaries.

Native steer/resume unknown retention SHALL remain active without automatic-policy context, including degraded Hub and standalone operations. Queue → Steer and held/paused Send now browser transport failures or server 5xx SHALL produce persistent page-local unconfirmed guidance and read-only reconciliation, without changing an unrelated composing draft or retrying the mutation. Definite refusals SHALL retain their existing handling.

#### Scenario: Background fails after steer acceptance
- **WHEN** the provider confirms the steer but definitively refuses its background follow-up
- **THEN** the action reports the accepted steer and failed/unavailable follow-up separately with explanatory text
- **AND** the accepted message is neither restored to the draft nor requeued/resubmitted

#### Scenario: Upstream background response is lost after application
- **WHEN** native backgrounding may have applied but Uatu cannot confirm its response
- **THEN** the accepted primary result retains an unknown follow-up receipt and neutral uncertainty feedback
- **AND** retrying the same identifier while retained issues neither a second steer/resume nor another background request

#### Scenario: Browser loses a known composite result
- **WHEN** Uatu retained the accepted composite result but the browser lost its response, another blocker appeared and the account changed its preference
- **THEN** the same-account same-identifier retry returns the original result/policy without repeating either native mutation

#### Scenario: Primary admission response is unknown
- **WHEN** the provider may have accepted a steer/resume but its acknowledgement is lost
- **THEN** the primary-unknown receipt is retained, no background request is made and the action's message/attachments remain available as unconfirmed rather than automatically resubmittable failed input
- **AND** same-identifier retries while retained do not duplicate the primary action

#### Scenario: Late response and ended receipt lifetime
- **WHEN** a timed-out native operation later settles, or its receipt expires, is evicted or is lost on adapter/process recreation
- **THEN** read-side evidence can update visible state without initiating a delayed follow-up or automatic mutation replay
- **AND** old request identifiers are not claimed to remain deduplicated after receipt loss

#### Scenario: Shared-workspace users reuse an identifier
- **WHEN** A and B issue actions in the same conversation using the same client request identifier but opposite personal preferences
- **THEN** neither receives the other's personal action receipt or policy metadata
- **AND** each action uses its own authenticated initiating-account scope while conversation/worker state remains shared

#### Scenario: Unrelated mutations preserve unresolved operation feedback

- **WHEN** Remove, a delivery change or a later successful steer follows an unknown, failed or unavailable automatic-background outcome
- **THEN** the unresolved feedback remains tied to its source operation and is not cleared by the unrelated result or ordinary status settlement
- **AND** constrained touch layouts retain visible, scrollable feedback without consuming the usable draft field or hiding the inline picker

#### Scenario: Settings browser cannot read saved policy

- **WHEN** the Settings browser fails to read personal preferences
- **THEN** it reports that it cannot confirm the saved setting, without promising automation is disabled
- **AND** saved server policy continues to govern independently admitted steers in other tabs or devices

#### Scenario: Unknown retention survives unavailable bootstrap
- **WHEN** native steer admission or resume applies but its acknowledgement is lost while private Hub policy trust is unavailable
- **THEN** an immediate same-account same-identifier retry retains unknown with only one native primary mutation
- **AND** no automatic background request or unsigned policy context is introduced

#### Scenario: Queue action loses its browser acknowledgement
- **WHEN** a Queue → Steer, held Send now or paused-batch Send now result is lost to browser transport failure or a server 5xx
- **THEN** unconfirmed guidance remains visible through read-only reconciliation and later paints
- **AND** the unrelated composing draft stays unchanged and reconnect/reload sends no automatic mutation retry
