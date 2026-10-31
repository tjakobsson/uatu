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

### Requirement: Touch conversation actions share the picker row
Touch selected conversation titles SHALL truncate inside the paint-contained picker wrapper and SHALL NOT push Rename or New conversation onto another row. Both actions SHALL retain at least 44×44px touch targets and their existing accessible names. New conversation MAY use an SVG-only presentation. Native select option strings, browser-owned popup and keyboard selection, the external wrapper focus ring and desktop text-button behavior SHALL remain intact. No Options panel SHALL be added. Transcript-edge floating navigation SHALL NOT paint or receive hits over the header or sibling work controls when the reading strip becomes shorter than the floater.

#### Scenario: Long selected titles preserve same-row actions
- **WHEN** a 320px or 390px touch viewport shows a long spaced or unbroken selected title at normal or 200% root text size
- **THEN** the picker, Rename and New conversation stay on one row without horizontal painted overflow
- **AND** both actions retain full touch targets, keyboard access and the native option list's complete titles

#### Scenario: Enlarged landscape navigation cannot obstruct header actions
- **WHEN** an 844×390px touch viewport at 200% text allocates a short transcript strip while Latest is shown
- **THEN** Rename and New conversation remain hit-testable at their centers and block edges
- **AND** floating transcript navigation remains within its transcript paint/hit boundary rather than covering header or work controls

### Requirement: Desktop density follows input capability and actual pane width
Compact desktop density SHALL require selected desktop UI mode and a primary fine pointer with hover. Explicit touch/comfortable mode and touch-first hybrid devices SHALL retain existing comfortable targets. Composer actions SHALL use consistent 32px controls, one row where the actual pane fits and a deliberate two-row layout below 34rem, retaining Attach, model/mode/effort, context, Send and Stop. At actual work-pane widths of at least 40rem active worker rows SHALL align status, agent, task, model, cumulative tokens and a separate 28px Stop; narrower panes SHALL retain two lines without removing metadata. Pending actions SHALL be 32px with 4px/8px padding and independent 8px gaps, inline when they fit and wrapped otherwise. Delivery and Paused labels, edit/replacement safeguards and unknown receipts SHALL remain available. No hidden counts, success notices or replacement action menu SHALL be introduced. These desktop target exceptions supersede the comfortable 44px target rules below.

#### Scenario: Resizing the pane on a desktop does not turn it into touch UI
- **WHEN** a fine-pointer desktop chat pane narrows inside a wide viewport
- **THEN** composer controls deliberately reflow and worker metadata uses two lines while Stop remains separate and reachable
- **AND** explicit comfortable mode retains its existing targets regardless of viewport width

#### Scenario: Desktop keyboard guidance uses fixed delivery
- **WHEN** steering/queueing is offered for an ordinary desktop message-field draft
- **THEN** visible Enter and Alt+Enter hints SHALL state steer and queue respectively, ignoring legacy saved delivery choices
- **AND** idle or non-choice drafts SHALL show ordinary send/newline guidance without changing pointer hold timing

### Requirement: Desktop expanded work retains a useful conversation band
Compact desktop expanded cards SHALL prefer 35% of measured remaining layout height for conversation, bounded to 200–280px, rather than the comfortable 20%/32–96px reserve below. Whole measured headers/actions MAY reduce this reserve to the existing lesser-of-16px-or-10% emergency floor. Independent panel scrolling, headers, selected-pane short-window priority and reachable composer/Stop SHALL remain intact. Comfortable/touch expanded allocation SHALL remain unchanged.

#### Scenario: Expanded desktop work shares remaining space with conversation
- **WHEN** two long work panels expand with 720px remaining after fixed chrome and fitting action minima
- **THEN** conversation retains 252px and the cards share 468px through separate scrollports
- **AND** short windows yield conversation space to measured whole headers/actions rather than clipping Stop

### Requirement: Side answers minimise without losing their answer
Desktop side answers SHALL open a larger nonmodal native dialog without a blocker or focus trap; other app controls SHALL remain interactive. The window SHALL fit actual viewport and safe-area bounds and SHALL NOT cover the entire app or become a permanent pane. Mobile MAY retain its modal reader. Both SHALL offer Minimise, replacing the old hide-only Close action rather than duplicating it. Minimise SHALL retain the page-local answer and reading offset and make the existing conversation notice available to reopen without generation, foreground admission or history mutation. Desktop Escape SHALL minimise only from inside the reader; unrelated composing keys SHALL remain owned by the composer. Focus restoration SHALL not override unrelated current interaction. Switching conversation SHALL hide the reader, retain its reading offset, and preserve the existing conversation/file-action ownership guards. These window/minimisation rules supersede modal-only Escape wording below; sanitization and file/external-link policies remain unchanged.

#### Scenario: Reading continues while the main app remains usable
- **WHEN** a desktop side answer is open
- **THEN** the user can click and type in the composer, act on pending messages and invoke Stop without dismissing the answer
- **AND** minimising and reopening on either desktop or mobile restores the same answer/offset without another inference

#### Scenario: Live UI-mode changes minimise the current native reader
- **WHEN** the shell changes desktop to touch or touch to desktop while a side reader is open, including an explicit override on coarse-pointer hardware
- **THEN** the existing UI-mode event SHALL minimise the reader, release native modal inertness and retain its answer/reading offset without taking focus from the shell's next interaction
- **AND** deliberate reopening SHALL use native modal touch or nonmodal desktop semantics matching the newly chosen UI mode, not an ARIA-only substitution, without another generation or timeline mutation

### Requirement: Pointer Send steers and an armed two-second countdown queues
For steering-capable agents, tapping Send, desktop Enter and touch Ctrl/Command+Enter SHALL explicitly steer ordinary busy text. Alt/Option+Enter SHALL queue where already offered; touch plain Enter SHALL remain newline. Steer SHALL be the fixed keyboard default, not configurable. Legacy saved delivery choices SHALL be ignored without deleting browser settings, including after reload. No delivery-default Settings path, dropdown, replacement selector or added layout height SHALL be introduced. This supersedes earlier per-device delivery-default requirements. Busy commands and attachment-bearing composer drafts SHALL queue with truthful labels; native staged-replacement semantics, explicit HTTP/dock delivery and unsupported agents' queued/idle behavior SHALL remain unchanged.

A continuous pointer or focused-Send Space hold SHALL arm silently for 500ms, then run a two-second countdown and automatically submit Queue once at 2500ms, without waiting for release. Release before 500ms SHALL steer once; release from 500ms until 2500ms SHALL cancel without sending. Before 500ms no extension or progress countdown SHALL render. Drag outside the original fixed Send bounds, movement of the target, pointercancel, lost capture, window blur, page hiding, Escape, changed draft/attachments/configuration/selection, or active submission/cancellation locks SHALL invalidate the gesture and all stale timers. Keyboard focus leaving Send SHALL cancel its Space hold. Every timer/frame SHALL recheck current page visibility/focus and owned immutable draft identity before dispatch. At arming, the viewport-owned pointer-transparent visual envelope SHALL appear at its full fixed height, extending 104px above the original target, bounded by visible viewport space. Its bottom SHALL match Send's bottom and its width SHALL match Send. The outer bounds SHALL remain fixed throughout the countdown; only the green fill SHALL move bottom-to-top while the above-finger countdown runs from 2.0s to zero. There SHALL be no envelope growth or size transition. It SHALL escape composer/dock clipping without shifting layout or enlarging the hit area. Reduced motion SHALL retain the same fixed bounds, progress and countdown. Send SHALL expose concise aria-describedby instructions for arming/hold/cancel and fixed keyboard shortcuts; Enter on Send SHALL activate immediately. There SHALL be no visible Send/Steer/Queue dropdown or replacement menu. This supersedes earlier visible delivery-selector, saved keyboard-default and envelope-growth clauses. Idle held Queue SHALL dispatch using existing normal idle semantics, not create fake pending input. Existing authoritative personal background policy SHALL govern accepted steer actions without a second browser background request.

#### Scenario: Fixed and client viewport origins differ during a hold
- **WHEN** a valid Send hold is painted with a nonzero fixed/client origin difference, including keyboard pan or magnification
- **THEN** its visual bottom and horizontal anchor SHALL match the unchanged Send rectangle without applying the viewport displacement twice
- **AND** keyboard opening/closing, pan or toolbar changes that move Send SHALL cancel without a later queued submission

#### Scenario: Ongoing hold calibration does not alternate paint writes and layout reads
- **WHEN** the unchanged Send target is held across animation frames
- **THEN** fixed-origin geometry SHALL be read from a stable inert zero-size probe sharing the visual's fixed containing block before that frame's paint writes, without resetting the visible envelope for measurement
- **AND** origin changes SHALL be sampled during the hold rather than using a stale gesture-start origin
- **AND** the page-owned probe and visual SHALL be removed together on pagehide and restored for a retained page or subsequent gesture

#### Scenario: Quick tap and intentional hold have distinct outcomes
- **WHEN** a busy ordinary draft is released before 500ms, released during the 500ms–2499ms countdown, or continuously held for 2500ms
- **THEN** it respectively steers once, sends nothing, or queues automatically once before release
- **AND** subsequent click, release and timer events cannot duplicate that action

#### Scenario: First eligible busy draft teaches queueing once
- **WHEN** an unlearned browser has a valid ordinary-text draft while working and hold-to-queue is supported
- **THEN** compact accessible copy says “Tap to steer · hold to queue” without a menu
- **AND** only an accepted held queue submission retires it for this browser/base path; cancellation, refusal, uncertainty and tap do not
- **AND** unavailable browser storage falls back to page-local learning without an account API

#### Scenario: A stale or inactive hold never sends
- **WHEN** the tab loses visibility/focus, a pointer is cancelled or leaves the original button, Escape is pressed, or the owned conversation/draft/configuration changes
- **THEN** the hold and any delayed timer are cancelled without steering or queueing
- **AND** the draft and attachments remain available

#### Scenario: Accessible keyboard and idle holds stay truthful
- **WHEN** the user holds Space on Send for 500ms arming plus two seconds of countdown, or completes an idle pointer hold
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

### Requirement: Side answers use a compact notice and safe Markdown reader
Working, ready and failed side answers SHALL use a small transcript-edge notice outside the composer feedback block, with a 44px activation target that does not cover worker Stop controls. Completion SHALL preserve composing selection, drafts and the reading anchor. Opening the reader SHALL be deliberate and associated with the originating conversation; stale callbacks SHALL NOT expose an answer in another conversation. The reader SHALL use the normal chat Markdown renderer and sanitizer, support selectable headings, emphasis, links, inline/fenced code and tables, and reject scripts, event handlers and unsafe URL schemes. Wide tables/code SHALL scroll inside the reader without horizontally panning the surface. Reader bounds SHALL follow the visual viewport through keyboard resize/pan; Escape SHALL close only that modal and restore its surviving invoker. Switching conversations SHALL close a stale reader without moving focus to an unrelated notice. The existing one-shot/no-history/no-tool-loop/no-retry contract SHALL remain unchanged.

#### Scenario: A formatted side answer arrives during composition
- **WHEN** inference completes while the user is reading older messages and selecting text in a newer draft
- **THEN** a small ready notice appears without changing that selection, draft, reading anchor or foreground work
- **AND** its deliberate reader renders safe formatted content, containing large-table scrolling within its visual-viewport bounds

#### Scenario: A side answer references a watched workspace file
- **WHEN** a user activates a resolved workspace file reference by pointer, Enter or Space in the current conversation's side reader
- **THEN** the normal chat decorator, watched-root resolver and existing in-app preview action are used, including qualified paths and line suffixes
- **AND** the reader closes before preview navigation without app reload, lost draft/conversation/answer, duplicate inference or another prompt admission
- **AND** Hub workspace prefixes remain intact, safe external links retain normal new-tab semantics, and malformed/traversing/unrecognized references are not promoted into file actions

### Requirement: Native questions retain explicit answer ownership
Pending native tool questions SHALL remain explicit forms, not automatically answered, cancelled or treated as detachable jobs. Already detached child work and existing parent mirroring/reply routing for child questions SHALL remain unchanged. A side-generation response SHALL NOT complete an unanswered tool question or launch a new orchestrated task.

#### Scenario: A pending question does not become background work
- **WHEN** a native foreground question awaits an answer while detached children run or settle
- **THEN** the question remains available for an explicit answer and is neither answered nor cancelled automatically
- **AND** no Continue UI is offered; detached children can continue independently and existing child-question mirroring remains intact

## MODIFIED Requirements

### Requirement: Touch pending messages and workers use compact deliberate disclosures
Touch chat SHALL show at most one initially collapsed pending-message summary and one initially collapsed worker summary, omitting an empty summary. Pending text SHALL identify only nonzero steer/queued categories without repeating the total, such as `1 queued` or `2 steers · 1 queued`. Its header and inline pending actions SHALL use the approved 32px minimum density exception with independent 8px gaps including before Remove, preserving existing confirmations. Cards SHALL share compact delivery labels and message content on a line where space permits rather than forcing three rows; long messages and warnings SHALL remain readable. Worker text SHALL identify confirmed working and finished occurrences, such as `2 working · 4 finished`; finished SHALL include terminal failures/stops without implying successful completion. Uncertain workers SHALL be separately named rather than counted as confirmed working or finished. Dismissed counts SHALL NOT be visible; when no visible workers remain the whole worker card SHALL be absent. New work, replay and settlement SHALL update the summaries without automatically expanding touch details. Deliberate per-conversation expansion SHALL survive repaint, reselection and viewport changes within the page without leaking to other conversations.

Pending message leading SHALL scale with text size, preserving 14px type/20px leading at default size and 28px/40px at 200% root text. Multiline glyph rectangles SHALL remain vertically separated; enlarged multiline and image-containing cards SHALL grow naturally within the existing dock scroller without horizontal overflow or reduced mutation targets.

After replacement changes the available actions, pending footers and action groups SHALL shrink to their card's content width and long labels such as `Send now + paused steers` SHALL wrap without clipping or truncation. Cards and their shared height budget SHALL NOT acquire horizontal scrolling. Actions SHALL retain at least 32px targets and independent 8px gaps, and SHALL be fully exposable within all clipping ancestors. Paused-batch Send SHALL retain a 44px target in Pending's independent content pane, available even with entries collapsed; the count header SHALL remain visible outside that pane. Existing confirmation wording, cancellation without mutation and confirmed paused-batch delivery semantics SHALL remain unchanged.

Expanded pending details SHALL retain delivery order and existing edit/remove/convert/Send now actions. Expanded worker details SHALL retain inspection, truthful terminal outcomes, available shell output and existing parent/worker-stop safeguards. Replacement consequences, paused-batch warnings and applicable batch Send, and actionable operation failure/uncertainty SHALL remain visible outside collapsed details. The collapsed touch defaults are an explicit exception to desktop automatic expansion.

In selected desktop UI mode, Workers SHALL automatically open when a new batch of visible working or unknown occurrences first appears, and Pending SHALL automatically open for a new nonempty batch, including paused entries. Deliberate collapse SHALL hold until that card's active-worker or pending batch becomes empty; further arrivals SHALL NOT reopen it. Ending a batch SHALL leave its current open state alone and clear the collapse veto for the next batch. Finished-only history SHALL NOT invent a new active batch. Choices SHALL be retained separately per conversation and UI mode in a page-local cache bounded to 200 conversations, without inheriting another conversation's choice or treating automatic expansion, mode changes or delayed programmatic toggle echoes as user gestures. Null selection during refresh SHALL NOT end a batch. Native pointer/keyboard changes SHALL survive a live repaint before their deferred toggle event arrives. Policy SHALL follow `data-ui-mode`, not fine-pointer density; tablet desktop mode SHALL use desktop defaults. Canonical rows, independent pane offsets, focus and reading-anchor ownership SHALL remain unchanged.

Expanded worker details SHALL show one flat list: confirmed working and unknown workers first, then finished workers ordered newest first from available execution timestamps, without a separate Finished disclosure. Active occurrences with Stop SHALL use two lines within the existing 44px action height: task title first, then the actual reported agent, model and explicitly cumulative Σ usage. Missing metadata SHALL NOT be invented. Settled and inspection-only rows SHALL retain the approved single-line density exception of at most 28px at default text scale. State-specific glyphs SHALL distinguish working, unknown, finished, failed and stopped without repeated visible status labels. Stop SHALL remain a separate 44px target with an 8px gap and a semantic accessible name identifying its worker; its visible label SHALL be Stop, or Stopping… while pending. A settled glyph SHALL NOT imply live work. The compact main header SHALL use a small chevron rather than a native triangle, expose its expanded state accessibly, and contain Dismiss finished on the right in the same row, without a footer or duplicate finished count. Dismiss finished SHALL persist view-only hiding through the existing per-conversation dismissal seam without displaying hidden counts or deleting provider history. Short or empty lists SHALL NOT reserve unused height after dismissal. Restore finished SHALL be absent, with no replacement visible control. Settled results and inspection SHALL remain reachable from the timeline. Only current owned, confirmed live background workers SHALL offer enabled Stop; an unknown outcome SHALL disable Stop. Only live workers SHALL cause the parent Stop label to read Stop parent. Successful sends, dock mutations and automatic-background outcomes SHALL be silent; failed, unavailable and meaningful unknown guidance SHALL remain persistent.

#### Scenario: Loaded touch chat starts compact
- **WHEN** a touch conversation has two pending steers, one queued message, two working and four confirmed terminal worker occurrences
- **THEN** its pending and worker summaries are collapsed and show their respective counts
- **AND** no second pinned worker list duplicates the same work

#### Scenario: Desktop new work is reachable without disclosure
- **WHEN** visible working/unknown workers or pending entries first appear in desktop UI mode, including on touch-first hardware explicitly using desktop mode
- **THEN** the corresponding canonical card opens without moving focus
- **AND** finished-only worker hydration stays initially collapsed and touch still starts collapsed

#### Scenario: Desktop manual collapse belongs to its current batch
- **WHEN** the user closes a desktop card and more active workers or pending entries arrive before its batch empties
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

#### Scenario: Expanded workers retain the pending overview
- **WHEN** six or more workers and pending messages are expanded on touch or desktop, including while the touch keyboard is open
- **THEN** one bordered canonical worker card contains its header and rows, and a separate compact Pending disclosure follows the card before the composer, without duplicate desktop subagent/background summaries
- **AND** Workers and Pending keep separate bounded content scrollports in every disclosure combination, including replacement warnings and the explicit desktop work sheet; neither header nor the outer dock scrolls
- **AND** summary action identity, composing focus, reading anchors, safe areas and existing transcript budgets are preserved
- **AND** insufficient short bands yield transcript space and prioritize the pane selected by its header or content; both headers remain visible and Pending never appears between the worker header and its rows

#### Scenario: Enlarged question options remain readable beneath date history
- **WHEN** question options intersect a sticky date marker on a 390px touch viewport at 200% root text size
- **THEN** the marker does not paint over the interactive question content and keyboard answering remains available without changing scroll-anchor geometry

#### Scenario: Settled and uncertain workers remain truthful
- **WHEN** the retained worker set includes a failure, a stopped worker and one unresolved outcome
- **THEN** the confirmed terminal occurrences contribute to finished with their individual outcomes available in details
- **AND** the unresolved occurrence is named uncertain rather than declared finished or successful

#### Scenario: Dismissing finished workers preserves timeline history
- **WHEN** the user dismisses finished workers and reloads the conversation
- **THEN** those overview rows remain hidden without a Restore finished button or replacement menu
- **AND** their retained reports and existing transcript inspection remain reachable in the timeline, without provider history deletion

### Requirement: Compact touch composition preserves safe targets and conversation space
Touch chat SHALL keep inline Attach, one two-line agent/mode/model/effort and actual-context pill, Send with described Space-hold Queue access, and separate Stop. The pill SHALL directly open the existing single adaptive configuration picker and SHALL show actual occupancy plus used/limit where known, explicitly distinguishing unreported/estimated values from cumulative usage. The top Options trigger/panel and duplicate touch context circle SHALL be absent. Unique account usage SHALL remain reachable. Manual Continue and What continues UI SHALL be absent in all chat modes, including standalone, with no replacement menu; the existing background API and authenticated automatic-steer policy SHALL remain unchanged. Standalone SHALL NOT gain automatic Hub policy. Visible composer action targets SHALL be at least 44×44 CSS pixels, with at least 8px separation between adjacent mutation actions, visible focus and non-overlapping hit regions. Unsupported actions SHALL be absent. Fixed keyboard delivery SHALL follow the approved Steer default; touch Enter newline semantics SHALL remain unchanged.

When both cards are collapsed, the in-flow dock SHALL retain its normal aggregate visual-height caps: 35%, 25% from 48rem width, and 24% during hardware-keyboard editing. Loaded collapsed phone layouts SHALL leave at least 40% of the visual band for the transcript, and tested collapsed tablet layouts at least 35%, wherever measured minimum headers, whole action rows and composer physically permit it. When either card is expanded, the measured expanded-card policy below SHALL replace those caps and reading shares. In insufficient short bands the transcript SHALL yield space while both card headers and composer remain visible; touch SHALL NOT introduce a Show work fallback or hide either header. The worker disclosure SHALL remain below the transcript and above the composer through focus, repaint, keyboard show/hide, viewport resize and pan, rather than implicitly becoming a top sheet or reordering those regions. The sibling cards SHALL have independently scrolling content panes and no shared outer scroller, remaining content-sized for short lists. Opening and closing details SHALL preserve composing drafts and owned focus without forced keyboard blur. Composer Attach/picker/Send/Stop and existing pending replacement/batch safety SHALL remain reachable. Safe-area handling, measured desktop geometry, explicit bottom pinning, remote reading anchors and interaction-request answering SHALL be preserved. Larger text SHALL retain readable warnings and reachable primary controls using scrolling/reduced secondary content rather than shrunken targets.

Menus SHALL fit the visual viewport, support keyboard navigation and one-layer Escape with invoker restoration, and consume outside touch dismissal without activating underlying actions. Visible controls SHALL activate reliably on the first tap during composition without discarding drafts or attachment/configuration state. Live updates and reduced-motion presentation SHALL NOT steal focus or fabricate completion announcements.

Explicit Continue SHALL retain its existing constrained-state suppression; this layout change SHALL NOT alter delivery or Continue semantics.

#### Scenario: Keyboard and landscape keep conversation space
- **WHEN** loaded touch chat uses 390px width with a 380px or 450px visual band, or 844px landscape width with a 230px visual band and the existing safe-area fixtures
- **THEN** Attach, the real picker, Send and Stop fit inside the visual band with their minimum targets/gaps
- **AND** collapsed cards leave at least 40% wherever measured minimum chrome permits it; expanded cards use the measured small-strip policy, and insufficient short bands retain both headers and reachable pending replacement/batch safety instead

#### Scenario: Two closed cards in the insufficient landscape keyboard band
- **WHEN** a 230px visual band has a 44px app header, 46px composer and two closed cards plus spacing requiring 72px
- **THEN** 68px remains for conversation rather than the infeasible 92px normal floor
- **AND** both card headers and composer actions remain fully visible without a touch Show work fallback

#### Scenario: Hardware keyboard and tablet budgets stay bounded
- **WHEN** loaded 390×844 chat is focused without a software keyboard, or the tested 768×1024 and 1024×768 tablet layouts are used
- **THEN** collapsed cards respect their applicable height cap and expanded cards use the measured small-strip policy, retaining the bottom safe inset
- **AND** the transcript keeps the applicable collapsed share or expanded strip without outer-surface scrolling

#### Scenario: Options dismiss without executing an underlying action
- **WHEN** a touch user taps outside the configuration picker over Revert, Send or Stop
- **THEN** only the picker dismisses and no underlying mutation is sent
- **AND** Escape closes only the top layer and restores its invoker or surviving equivalent

#### Scenario: Disclosure changes preserve the reading intention
- **WHEN** pending/worker details expand, collapse or settle while the reader is remotely scrolled or explicitly bottom-pinned
- **THEN** the current reading anchor or explicit bottom-pin intention is preserved respectively
- **AND** controls remain hit-testable after final layout reservation and reduced-motion handling

### Requirement: Desktop work shares measured panel space
Worker and pending cards SHALL share a measured height budget, not a scrollport. Their headers SHALL match in height, padding, typography, custom chevron, border, radius and color. Each header SHALL remain outside its independently scrolling content pane; scrolling either pane SHALL NOT move the other pane's header or scroll offset, the transcript, or the composer. The outer dock SHALL NOT scroll. Long content SHALL share available space and short or collapsed content SHALL yield unused space. With both cards collapsed, desktop's normal budget remains 40% of actual panel height capped at 25rem, reserving the lesser of 12rem or 35% for the transcript; touch retains its normal phone/tablet reading budget and safe insets.

With either card expanded, the dock SHALL use the remaining measured panel height after all in-flow chrome, warnings, composer and safe-area padding, not a fixed viewport height. The preferred transcript reserve SHALL be 20% of that remaining region, bounded to 32–96 CSS pixels. Whole measured headers/actions MAY reduce that reserve, retaining at least the lesser of 16px or 10% of the remaining region where physically possible. The remaining capacity SHALL be available to the cards without forcing short lists to fill it. Both expanded long lists SHALL partition that capacity; a short or collapsed sibling SHALL yield its unused share. Collapsing both SHALL restore the normal reading budget without blank card height or a forced conversation jump. Expanded desktop cards SHALL NOT require Show work when their measured actions fit beside the small conversation strip.

#### Scenario: Expanded pending entries grow while the keyboard is hidden
- **WHEN** the touch composer remains focused without a software keyboard and expanded pending work grows from one to two to five entries beside busy workers
- **THEN** the expanded measured budget supersedes the collapsed hardware-editing cap, making complete entries/actions visible wherever the remaining capacity permits
- **AND** short or collapsed cards return unused height to the transcript

Physically insufficient space SHALL prioritize a whole actionable row in the explicitly focused/touched pane while retaining both headers and the unobstructed composer. The emergency transcript strip MAY yield to zero to fit those measured minima. If primary chrome, both whole headers and that action still physically exceed the visual band, native vertical outer scrolling SHALL expose the controls without shrinking enlarged type: the touch surface or the explicit desktop overlay region. This physical-minimum exception supersedes the unconditional no-outer-scroll statements above; card bodies SHALL retain independent scrollports and touch SHALL NOT add Show work. The existing explicit desktop Show work fallback MAY cover the chat header but SHALL NOT overlap the composer; its own available region SHALL include Close work and all margins/gaps in its allocation. Disclosure state, keyed controls, focus and independent reading offsets SHALL survive unrelated worker/pending updates. Replacement warnings SHALL reveal once inside the pending pane, never by scrolling the shared dock in fitting geometry.

#### Scenario: Enlarged physical minima exceed the visual band
- **WHEN** 200% text at 390px width has only a 200px visual band and measured chrome, both headers and a whole selected action cannot fit
- **THEN** native vertical surface scrolling exposes both cards and composer actions without reducing text, hiding a header or forcing a touch overlay
- **AND** each card body retains its own scrollport and native header activation selects its actionable body without programmatic focus assistance
- **AND** while this measured exception is active, viewport and foreground resync preserve native surface scrolling and keyboard focus reveal; when it ends, normal zero-offset surface behavior resumes

#### Scenario: Enlarged explicit desktop work owns its budget
- **WHEN** Show work opens with 200% text and twenty workers and pending messages at 1100×700 or 1440×480
- **THEN** its measured region above the composer budgets Close work, both headers and independently scrolling action panes, using outer overlay scrolling only if their physical minima cannot fit

#### Scenario: Independent saturated work cards
- **WHEN** twenty workers and twenty pending messages coexist in any of the four disclosure combinations, including enlarged text
- **THEN** wheel and touch scrolling within either open content pane leave the other pane and transcript offsets unchanged
- **AND** both headers remain fully visible, pending actions can be fully exposed through every clipping ancestor, and Send/Stop remain accessible

#### Scenario: Header taps expose constrained actions without focus assistance
- **WHEN** both panels are expanded in a 230px landscape keyboard band at normal or 200% text and the user activates either header
- **THEN** the selected pane receives enough independent scroll space to fully expose its action targets, without requiring programmatic action focus
- **AND** both headers and composer actions remain visible, worker Stop stays reachable by selecting Workers, and parent Stop/Cancel remains operable

#### Scenario: Pending disclosure scroll remains conversation-local
- **WHEN** a reader scrolls Pending, closes and reopens it, or returns from another conversation
- **THEN** its saved session offset is restored after allocation without replacing keyed controls or changing the sibling or transcript offsets
- **AND** another conversation does not inherit that offset

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
- **AND** the accepted steer is preserved with explanatory unavailable feedback and the existing background API remains available where permitted

#### Scenario: Nothing qualifies after acceptance
- **WHEN** an accepted steer leaves no verified running-blocker evidence, or workers are only detached/settled/uncertain
- **THEN** no automatic background call is forced and no future job-start watcher is installed

#### Scenario: Mixed eligible jobs race with native execution
- **WHEN** an accepted steer is followed by one background request while eligible subagents and shell jobs block that parent
- **THEN** native all-eligible behavior is used rather than a subagent-only operation
- **AND** a race to no eligible jobs is harmless while a new blocker present at native execution is not promised exclusion

#### Scenario: OFF, unsupported and non-steer actions do not trigger automation
- **WHEN** the preference is OFF, no Hub account context exists, either capability is absent, or the action is a queue/idle send, menu choice, job start, replacement staging or no-op conversion
- **THEN** no automatic background request occurs and existing delivery/background API behavior is preserved without a manual Continue UI

### Requirement: Automatic background outcomes never erase or resend accepted steer actions
Affected action responses SHALL distinguish the primary steer/resume outcome from any automatic-background outcome. Once primary acceptance is confirmed, a follow-up refusal, unavailable evidence, timeout or ambiguous response SHALL preserve and report the accepted primary action through the unchanged API; it SHALL NOT restore it as a failed draft, roll it back to the queue, or resend it. Background acknowledgement SHALL mean only request acceptance, not a count of affected workers, immediate steer delivery or worker completion. Successful outcomes SHALL produce no UI confirmation notice. Actionable partial/unknown outcome text SHALL remain visible outside collapsed details with read-only state recovery, without manual Continue/help UI or automatic mutation retry.

The composite operation SHALL share original admission ordering and retain primary plus follow-up results under an initiating-account-scoped receipt. While retained, a same-identifier retry SHALL return the same result without repeating primary admission/resume or backgrounding, reevaluating a changed preference or affecting later blockers. A primary-unknown or follow-up-unknown outcome SHALL be retained rather than treated as a retryable deleted failure; no follow-up SHALL start after a timed-out primary or from late evidence. The client SHALL NOT automatically replay uncertain mutations across reconnect/reload. Receipt expiry, capacity eviction, adapter recreation or restart end deduplication; the system SHALL NOT promise durable exactly-once execution across those boundaries.

Native steer/resume unknown retention SHALL remain active without automatic-policy context, including degraded Hub and standalone operations. Queue → Steer and held/paused Send now browser transport failures or server 5xx SHALL produce persistent page-local unconfirmed guidance and read-only reconciliation, without changing an unrelated composing draft or retrying the mutation. Definite refusals SHALL retain their existing handling.

#### Scenario: Background fails after steer acceptance
- **WHEN** the provider confirms the steer but definitively refuses its background follow-up
- **THEN** the action reports the accepted steer and failed/unavailable follow-up separately with explanatory text
- **AND** the accepted message is neither restored to the draft nor requeued/resubmitted

#### Scenario: Uncertain action feedback identifies its source and actual status read
- **WHEN** a primary or automatic-background outcome is unknown
- **THEN** the warning names the originating action and bounded safe plain-text excerpt or short attachment-only identifier
- **AND** checking language follows the real read-only snapshot request and changes to checked-but-unconfirmed or check-unavailable when it settles, never implying that the read confirmed the mutation
- **AND** unrelated success does not dismiss the warning; notices remain bounded and page-local, without persisted receipts, automatic resend or duplicate controls

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
