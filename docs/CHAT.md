# Chat

Chat is a workspace-scoped web client for coding agents you have already
installed and authenticated yourself. It bundles no agent, configures no
model provider, and holds no provider credentials. Two agents are offered
today — **OpenCode** and **Claude Code** — and every conversation belongs
to exactly one of them, chosen when the conversation is created and fixed
for its life. One agent being missing or broken never blocks the other.

## Personal Hub chat preferences

The workspace Hub menu links to **Settings → Personal chat preferences**.
The compact **Keep workers running when I steer** switch
defaults ON only for an absent account record. It belongs to your account on
that Hub across devices and workspaces, not other users, machine agent logins,
workspace defaults or standalone chat. Saved OFF survives Hub restart.
Settings refreshes on entry/focus/reconnect; stale saves show a conflict rather
than overwriting another device. Unreadable persisted state reports unavailable
instead of resetting OFF. The API is authenticated, no-store and versioned,
with server-selected identity and compare-revision writes. Changes take effect
only after **Save**. The one-line helper names the account scope; **Learn more**
keeps the all-jobs, shared-workspace and native-resume caveats available.
The switch shows ON/OFF. Changing it shows **Unsaved changes — Save to apply**;
returning to the confirmed saved value restores **Saved**. Refreshes preserve an
unsaved choice without silently applying it or rebasing it onto a competing
revision. A conflict keeps the choice and reports the saved setting for review
before another explicit Save. Unavailable settings and unconfirmed saves retain
their distinct explanatory messages; no background refresh replays a save.

With verified private Hub-to-child trust, ON considers one background request
after an accepted composer steer, Queue → Steer, held Send now, paused-batch
Send now, or submitted Undo/revert replacement. It never runs on job starts,
ordinary idle/queued sends, preference selection or replacement staging alone.
The request affects all native eligible blocking work, including shells.
Admission/resume and backgrounding are separate, non-atomic operations: native
resume may cancel blockers first, and neither acceptance nor backgrounding
promises immediate steer delivery or worker completion. Other users can see
the shared-work effects without having their personal preference changed.

Missing child trust or unreadable preferences makes automation explicitly
unavailable, not ON or OFF; an otherwise accepted steer stays accepted.
Refused, unavailable and unknown follow-ups are reported separately and never
restore an accepted input as a failed draft. An uncertain primary admission is
retained as unconfirmed text/attachments and reconciled read-only, not resent.
Once an unknown admission has settled, an eligible pending entry offers
**Discard local record**. Confirmation explains that this removes only Uatu's
copy: it does not cancel or resend the original, which may still arrive. The
original unknown receipt and native evidence remain intact. Other messages stay
queued until explicit Send now, a newly accepted message submission, or a later
normal idle transition; discard itself
does not send anything. This also covers a Queue entry whose attempted Send now
or switch to Steer became unknown. Resume and withdrawal uncertainty do not gain
this action. A timed-out request whose underlying transport never settles remains
protected and has no discard action; retiring that still-pending ownership is
outside the current scope.
Late evidence never schedules a delayed background request. Same-account,
same-request retries retain the first policy/outcome only while the bounded
in-memory receipt survives (15 minutes after settlement by default, or less
under count/byte pressure). Expiry, eviction and adapter/process restart end
that protection; reload/reconnect never automatically replays the mutation.
After refreshing evidence, an explicit background API request is a fresh action,
not a resend; chat no longer offers a manual Continue control.

Unknown steer/resume retention does not depend on automation being available.
When private child trust is unavailable, the Hub still keeps accounts' operation
identifiers separate without sending unsigned account identity or automation
permission. The first degraded feedback snapshot is also memory-bounded (up to
15 minutes from the proxy decision, or less under capacity pressure); losing
either that snapshot or the child receipt ends composite replay protection.
Queue → Steer and Send now response loss or server errors show persistent
unconfirmed guidance for the current page and refresh state read-only, leaving
an unrelated composing draft untouched. Reconnect/reload does not replay them.
Warnings name the originating action and a short plain-text message excerpt
(a short operation identifier for attachment-only inputs). “Checking conversation
status” lasts only for the read; its completion says either “Status checked;
acceptance still unconfirmed” or that the status check was unavailable. A status
read alone is not an acceptance receipt. Unrelated successes do not clear these
warnings. Notice excerpts are page-local and bounded to 20 operations in each of
100 conversations; neither receipts nor excerpts are persisted.
Multiple warnings share the existing focusable, bounded scrolling feedback
region rather than displacing the message field or primary actions.

## Prerequisites

### OpenCode

1. Install a compatible `opencode` executable by following the
   [OpenCode installation guide](https://opencode.ai/docs/).
2. Run `opencode` as the same operating-system user that runs `uatu`.
3. In OpenCode, use `/connect` to authenticate a provider and `/models` to
   choose a model. Confirm a normal OpenCode prompt works before using Chat.
4. Ensure `opencode --version` succeeds in the environment that starts the
   uatu hub or direct server. A service manager may have a different
   `PATH`, `HOME`, or provider environment from an interactive shell.

### Claude Code

1. Install the `claude` CLI by following the
   [Claude Code installation guide](https://code.claude.com/docs/).
2. Run `claude` once as the same operating-system user that runs `uatu`
   and sign in, so the install is authenticated.
3. Ensure `claude --version` succeeds in the environment that starts the
   uatu hub or direct server.

Each agent owns its configuration, authentication, and durable session
history. uatu never asks for, copies, transmits, or stores provider API
keys. UatuCode Desktop's Keychain contains only hub login credentials and
hub session identifiers, not agent or model-provider secrets.

## Lifecycle And Workspace

The two agents run differently. Opening Chat reports availability and
lists every agent's existing conversations merged into one chooser — for
OpenCode that enumeration needs its service, which is started then; for
Claude Code it is a read of native session storage that starts nothing.
Beyond what enumeration itself needs, no agent runs until a conversation
actually needs it.

**OpenCode** runs as one password-protected server bound to an ephemeral
`127.0.0.1` port inside the uatu workspace process, started when an
OpenCode conversation is first needed. The private endpoint and password
are never sent to a browser or exposed by the hub.

**Claude Code** has no long-lived service. Availability is a bounded
`claude --version` probe; each conversation with an active turn, live
background work, or a pending scheduled wakeup runs as its own Claude
Agent SDK session against your installed `claude`, and an idle
conversation holds no process. Conversations resume from Claude Code's
own session storage (`~/.claude/projects/...`), which uatu reads but
never writes.

### Sending, steering and queued messages

Opening or restoring a conversation first loads its snapshot. Until it loads,
Send and Rename stay disabled; any saved draft remains intact. The message
field is disabled during initial loading. If the read fails, you can edit the draft,
including while **Retry read** is pending, or choose another conversation.
A send shortcut during draft-only recovery reports that nothing was sent and
keeps the draft. Loading never submits input automatically. Once loaded, you can
keep drafting while an earlier submission or cancellation is in flight.

**Send** taps steer ordinary text while OpenCode V2 is busy; the separate
**Stop** cancels the current response. Hold Send continuously for **2.5 seconds**
to queue automatically, exactly once without releasing: a silent **500ms arming
delay** precedes the **2-second countdown**. Release before 500ms steers once.
Releasing during the countdown (500ms–2499ms), dragging outside the original button, Escape, lost capture,
pointer cancellation, leaving the tab, moving the target or changing the
draft/conversation/configuration cancels without sending.
No extension or progress appears during arming, so an ordinary tap never flashes
the indicator. At 500ms the full pointer-transparent envelope appears 104px above
the fixed Send target, limited by visible viewport space. Its outer bounds stay
fixed while only the green fill moves bottom-to-top and the countdown runs from
2.0s to zero. Reduced motion retains the same information and fixed bounds.
The visual is viewport-owned, outside composer/dock clipping.
Its fixed origin is sampled from a stable, inert zero-size probe in Send's
client-coordinate space before the frame's paint writes, avoiding repeated
write/read layout flushes and a second keyboard-pan translation in embedded
browsers. A layout change that
moves Send still cancels the gesture; moving the feedback does not move its target.
The Send target never moves. Idle held
sends dispatch normally, rather than inventing a pending queue entry.
There is no Send dropdown. Keyboard users can hold Space on Send for the same
2.5-second Queue action; Enter activates Send immediately. Escape cancels the
hold and preserves focus. Send's accessible description explains these keys.
A compact “Tap to steer · hold to queue” hint appears only with an eligible
ordinary-text draft while work is running. An accepted held queue submission
retires it for this browser/base path, not the account. Cancellation, refusal,
an uncertain outcome and an ordinary tap do not retire it. If browser storage
is unavailable, successful use is remembered only for the current page.
Desktop Enter in the message field steers; on touch devices Enter always adds
a newline and Ctrl/Command+Enter steers. Alt/Option+Enter queues where the
delivery choice is available. These shortcuts are fixed: legacy saved delivery
choices are ignored, not deleted, and there is no delivery-default setting.
Send's accessible description names the shortcuts. Idle messages send immediately. Claude Code
and OpenCode V1 queue busy follow-ups without offering steering. Pending images
and native commands queue rather than being labelled as a text steer; replacement
submission retains the native staged-revert semantics.

While native steering is available, the configuration pill identifies **Next
turn** choices. Changed model, mode and reasoning settings apply to queued or
new turns; steers retain the active turn's settings. Differing staged choices
show this distinction before submission and describe it to assistive technology.
The pill does not invent the active turn's configuration from later queue
admissions, and the extra explanation is absent for idle or unchanged settings.

Touch keeps Attach and a two-line **agent · mode · model · effort** pill inline.
Only declared/selected values appear; long names truncate with the full identity
available to assistive technology and the familiar model chooser on activation.
The second line shows actual context occupancy and known used/limit, or states
what is unreported; it never substitutes cumulative worker/session usage.

### Side questions with /btw

OpenCode V2 offers `/btw <question>` as a native one-shot answer from existing
session context, independently of foreground work. It admits no user message,
does not interrupt/resume/background the parent, and executes no agent tool loop.
Answers stay page-local, outside provider history: **Side answer ready** opens
the response from a small transcript-edge notice, without a composer block or
completion-time focus/scroll change. The reader uses the same sanitized Markdown
as normal chat, with selectable text and locally scrolling tables/code. It opens
at the answer's beginning with Close in its header; Escape closes only the reader,
retaining an expanded worker list, and returns focus to the notice. Empty native text is
reported honestly (the model may have attempted a tool call). Pending attachments
are refused and retained; V1/Claude do not offer this command, and typing it there
is refused rather than sent as an ordinary prompt. No automatic replay/retry is
performed. Like native inference it may consume model usage; these tests use only
the scripted fake, not a paid/live model. User-installed native plugins retain
their existing hooks; this is not a new sandbox against arbitrary plugin code.
If inference fails while you compose a newer draft, that draft stays unchanged;
**Side question failed** retains the original question and failure for inspection.

Workspace file references in side answers use the same watched-file resolution
and pointer/Enter/Space actions as normal chat, including qualified paths and
line numbers. Opening one closes the reader and brings the file into the existing
Preview surface without reloading the app; the draft, conversation and page-local
answer remain available. Hub workspace URL prefixes are preserved. Safe external
links retain normal new-tab behavior; malformed, traversing or unrecognized
references are not promoted into workspace file actions.

### Pending messages

The pending dock counts steers and queued messages. Each entry has its delivery
badge, a separate **Paused** chip when applicable, and message-specific actions.
For duplicate text and image-only entries, accessible action names also identify
a stable pending-message number while that entry remains in the dock. Each
successful action updates the dock silently; errors and uncertain outcomes remain visible.
An ordinary action refusal is not delivery evidence: the dock rereads the queue
and keeps messages the server still holds. If that check fails or omits the
queue, the current entry stays visible with an error. Nothing is automatically
resent; an unconfirmed withdrawal still permits only an explicit withdrawal retry.
Paused messages wait for your next message or an explicit send action.
**Send N paused steers now** wakes them together. Sending a queued message as a
steer also wakes paused steers; its label and confirmation explain that effect.
Other dormant queued messages remain held. Undo's count-only warning explains
which batch will accompany the replacement, without repeating message text.

Desktop and touch use the same compact worker card: one subtle border contains
its disclosure header and rows. Active workers show agent, model with latest-used
reasoning effort, cumulative tokens and cumulative child-session cost (USD).
Wide desktop rows align on one line with separate 28px Stop targets; touch keeps
44px targets and normally two lines. Very narrow phones use a third metadata
line rather than hiding the agent/model. Finished workers use dense rows.
An explicit dash means **not reported**, with an accessible label and tooltip;
shell tasks have no reasoning/session cost. Reported zero is `$0.00`, sub-cent
costs retain four decimal places, and smaller nonzero costs show `<$0.0001`.
Effort comes only from the child's own execution metadata: OpenCode 2.x reports
`model.variant` on step-start/history assistant records. It is the agent's
execution report, not an independent downstream provider echo. Current OpenCode
1.x and Claude message history do not report applied effort; their configured
selection, the parent's selection, and model-name guesses are never substituted.
Cost comes only from an authoritative cumulative session aggregate: OpenCode 2.x
`SessionInfo.cost` on the existing history metadata read and live
`session.usage.updated.cost` snapshots. They replace rather than add to each other.
The native total includes compaction usage and retains spend hidden by revert;
visible assistant-message sums cannot establish that total and are never a fallback.
Current Claude and OpenCode 1.x integrations do not provide this authoritative
aggregate, so their worker session cost is not reported even when task/message
prices are available. Missing aggregate data remains unknown, not a partial sum.
OpenCode can itself report zero for unpriced models: this is a reported zero,
not a promise of free billing. Reused-child occurrences repeat one session snapshot
without adding it to task/parent receipts or including descendant costs. Recovery
uses existing child-history accounting; inspection reuses its own bounded read,
and parent refreshes revalidate cached child history at most every 30 seconds,
not on every paint. Ordered live removals protect model/effort/token accounting
from older refresh and inspection reads; a later live upsert may recreate the
message. Removal fences are bounded: retiring one invalidates older reads first,
and parent-cache eviction clears its fences. Native lifetime cost remains separate
and is not reduced by message removal. Legacy subagent/background summaries
are not repeated above this card. Inspection, history and saved dismissal remain
available.

The historical accounting-authority check used the `@opencode/client` 2.0.28 contract and
[OpenCode v2.0.28 projector](https://github.com/anomalyco/opencode/blob/026b106bc5d41b679ffc413264229c340871e4d3/packages/core/src/session/projector.ts#L58-L72):
usage updates only the named session; step completion and compaction's
[`UsageRecorded`](https://github.com/anomalyco/opencode/blob/026b106bc5d41b679ffc413264229c340871e4d3/packages/core/src/session/compaction.ts#L616-L622)
add to that session, revert does not subtract spend, and `UsageUpdated` publishes
the resulting aggregate. It is the agent's USD accounting, not a billing invoice.
Pending is a separate compact disclosure **below** the worker card, before the
composer—not a heading between the worker header and rows. Both cards use the
same header, chevron and surface styling. Each open content pane scrolls on its
own, without moving either header, the other pane or the transcript; there is
no shared outer scroller. Long lists divide the measured budget, while short
or collapsed lists yield unused space. Reverted history, TODOs and scheduled
wakeups also remeasure when opened; their bounded panes include the header,
borders, content gap and outer margins so actions remain scroll-reachable.
With both cards collapsed, normal transcript/safe-area budgets remain wherever
the measured minimum headers, whole actions and composer leave that space. With
either expanded, cards can use most of the region left after measured header,
composer, notices and safe-area padding. Touch and comfortable-density layouts
keep 20% of that region for conversation, bounded to 32–96px; whole actions can
reduce it, down to the lesser of 16px or 10% of the remaining region in an
insufficient band. Short lists do not fill
that capacity: they return unused height to conversation. This expanded policy
also applies while the composer stays focused with the software keyboard hidden;
the collapsed hardware-editing percentage cap cannot override it. Adding a second
or fifth pending entry grows the card naturally until the measured budget is full.
Collapsing both cards
restores the normal budget without changing the reading intention. For example, a 230px
landscape keyboard band has a 44px app header, 46px composer and 72px for two
closed cards plus spacing: only 68px remains, not the normal 92px (40%). Both
cards stay visible; touch does not switch to Show work or hide their headers.
If the screen cannot physically fit whole actions, the transcript
yields first; the pane you focus or touch then receives priority while both
headers and the composer remain available. Desktop's explicit constrained
Show work sheet may cover the chat header, never the composer; work never
moves to a touch top sheet. Routine model
timing notes stay inside expanded Pending, while replacement/batch consequences
remain available in its content pane when collapsed. Batch actions live below
the count header so they cannot change its disclosure styling or scroll away
the worker header.

The [PR-hosted screenshot gallery](https://github.com/tjakobsson/uatu/pull/519) covers the
composer, workers, pending entries, hold countdown, inspection, questions, side
reader, personal automation preference and uncertain/replacement feedback using
synthetic fixtures only. The [capture guide](screenshots/opencode-chat/README.md)
records the capture source and limitations.
Selecting a card header also grants its body action space; allocation happens
after the native click so moving the header cannot swallow a touch. In enlarged
short landscape, physical 44px chrome/action minima replace rem-scaled empty
space, and inter-card spacing can yield to retain both headers and a whole
selected action. Pending restores its content offset after disclosure changes,
scoped to the conversation for the current session; other conversations start
with their own offset. Neither restoration nor pane selection moves the sibling
scroll position or the transcript.
Short keyboard/landscape layouts use compact input controls and counts;
uncertain feedback has its own scrollable band (a bounded column in landscape),
so it cannot consume the draft field. The inline model/context pill opens the
real configuration picker directly, without a second Options panel or context
circle. Paused-batch Send and replacement warnings remain available while typing.
Outside picker taps dismiss it without activating controls below it.
The touch picker reflows when Chat's visible area changes, including after a
short viewport expands again. Short layouts reduce spacing around the model
list while retaining complete model rows and touch targets. Browser regressions
cover resizing, scrolling to the last model and selecting it; physical-iPhone
acceptance remains user-owned.

Edit returns an entry to the composer only after withdrawal succeeds. If
delivery wins first, **Too late — already delivered** is informational: your
private draft stays intact and the delivered message appears only once.

If withdrawal cannot be confirmed, the pending entry and private draft stay
visible. Chat checks status read-only; an empty inbox or filtered/reverted
history does not silently remove the uncertain input. **Retry withdrawal**
explicitly retries cancellation of the same native inbox ID, never resubmits
the message. Edit and Steer → Queue remain unavailable until confirmation;
duplicate clicks cannot start concurrent actions on the entry. Cancellation
confirmation removes it; delivery confirmation says **Too late — already
delivered** and the message stays delivered once. An inconclusive retry leaves
the entry visible. Resume uncertainty remains read-only; settled unknown
admissions can offer the separate token-guarded local discard described above.
The retry
classification is page-local: after reload, a generic unconfirmed entry alone
does not establish that withdrawal retry is safe.

Read-only worker recovery separates failed reads from successful but inconclusive
checks. Failures retain backoff. After three unchanged successful checks in an
external recovery cycle, Chat waits for new source evidence, explicit refresh or
reconnect instead of polling indefinitely. Verified new execution progress can
continue discovery. Missing history or an exhausted check budget never means that
work completed or input was not delivered. Ongoing updates are coalesced without
discarding safe independent recovery results.

An exhausted cycle retains bounded scheduling state. Unrelated source activity
can restart it no sooner than 30 seconds after exhaustion; quiet sessions do not
poll automatically. Genuine new worker evidence, explicit refresh and reconnect
can restart recovery immediately. Held entries blocked by an unconfirmed held
admission are shown as paused, rather than promising ordinary delivery.

### Background workers (OpenCode V2)

OpenCode V2 exposes native background-worker inspection and controls. Automated
acceptance uses source-shaped OpenCode 2.0.29 records with client 2.0.28.
Isolated real-provider acceptance also passed native launch/completion, mixed
worker/shell conversion, stop scopes and disconnect recovery on those versions.

A background subagent's successful launch is not its finished result. Chat
tracks its running, completed, failed, or stopped outcome separately, links the
launcher to one result, and keeps its child transcript inspectable after it
settles. Children need not appear in the conversation picker. Worker results
are not editable steers and do not produce a successful-parent-turn push alert.
The settled inspection strip links back to that result instead of repeating
the report. Pending worker permissions/questions remain visible in workspace
attention even before you open their parent conversation.

Chat has no manual **Continue while workers run** or **What continues?** control.
The existing background API remains unchanged: it requests all eligible blocking
jobs, including shells, without stopping them; acceptance can be a no-op.
Only the verified personal Hub steer policy automatically backgrounds work.
Standalone has neither that account policy nor a manual chat background control;
native agent facilities and the existing API remain available.

A native question is not backgroundable work: OpenCode 2.0.29 awaits its form
answer before that tool completes. Detached children can keep working while the
parent waits, and child questions remain mirrored into the parent for answering.
Uatu neither answers nor cancels questions automatically. `/btw` asks a separate
one-shot question about existing context while work continues; it does not bypass
an unanswered foreground tool question or execute a new agent task.

Account usage stays beneath the inline actions when reported. The model
pill opens the single picker directly. The worker summary remains reachable
with hardware or software keyboards and in short landscape. Its compact header
uses a small chevron; expansion stays in the bottom dock through keyboard resize
and viewport pan, without flipping above the conversation or forcing keyboard
blur. Pending counts, paused-batch Send and replacement warnings
remain available while typing.
Touch has one initially collapsed pending summary and one worker summary.
Pending counts distinguish steers from queued input without repeating the total
or zero categories (for example, **1 queued** or **2 steers · 1 queued**).
Its header matches Workers' 28px minimum; compact cards share the delivery label and message
line where they fit, followed by inline actions. Pending actions use the explicitly
approved 32px density tradeoff with independent 8px gaps, including before Remove;
existing confirmation safeguards remain unchanged. Composer Send/Stop and
paused-batch Send stay 44px.
Pending message leading scales with text enlargement (14px type/20px leading at
default size, 28px/40px at 200%); multiline cards grow naturally inside Pending's
independent pane instead of overlapping lines or imposing a fixed card height.
Queued image rows and thumbnails stay within the card width when text is enlarged.
Pending footers and action groups can shrink to the card width; long labels such
as **Send now + paused steers** wrap without truncation. Paused-batch actions
scroll inside Pending's content pane, never in its count header. Counts stay
visible; confirmation wording and paused-batch delivery semantics stay intact.
As before, enlarged replacement warnings may take extra space from the transcript
to keep their full text and controls reachable. When the warning plus primary
chrome cannot fit, the touch surface scrolls vertically; Pending keeps its own
content pane and a whole warning, and the composer remains scroll-reachable.
The warning's reading allocation includes the actual bottom fade height, so
the scroll signal does not paint over its last line.
The native conversation picker ellipsizes long selected titles within its own
control; its option list retains the full titles and normal keyboard navigation.
A shrinkable, paint-contained wrapper isolates native selected-value painting
from the surrounding layout instead of relying on native control overflow rules.
On touch, Rename and New conversation stay beside the picker on the same row,
with 44px targets even at enlarged text. New conversation uses a plus SVG with
the same accessible name; desktop keeps its text label. Long selected titles
yield width instead of pushing actions onto another row. Header actions stay
outside the paint boundary; no header-level overflow clipping is added.
Touch transcript-edge navigation is contained within the transcript, so a
Latest button taller than an enlarged short-landscape reading strip cannot
paint or receive taps over the header or adjacent work controls.
The wrapper draws the focus outline outside its paint boundary. The labeled
native select, complete option names, and browser-owned popup remain unchanged.
The 40% phone/short-landscape
reading budget applies to collapsed cards whenever whole actions and headers
physically fit; expanded cards use the small conversation strip above. A smaller
band prioritizes the pane being used without overlapping the composer.
Worker counts distinguish
**Working**, **Unresolved**, and **Finished** (including confirmed failed/stopped)
occurrences. A request positively linked to the current execution reads
**Needs your answer** and counts under Working. It reveals the existing main-session
permission/question card, with the same request ID, notification and answer flow;
it does not create a second request. A request that cannot be attributed to a
particular task remains available in the main session without being assigned to
an old task merely because they share a child session.

**Checking status…** counts under Unresolved and lasts at most ten seconds per
recovery cycle; repaints, unrelated updates and retries do not extend it.
**Session active · task unverified** means the child session is
active but its current execution cannot be assigned to that task. Unobservable
work reads **Status unavailable · last seen …**, using the last positive task
observation, or explicitly unknown time when none exists. A positively identified
execution end without a correlated outcome reads **Ended · result unavailable**;
it remains Unresolved, not successful, failed or cancelled. Unobservable,
ambiguous and ended work has no running animation or growing execution timer.
Recovery is automatic; there is no worker **Check again** control.

Counts and rows use the same deduplicated executions: actual background shell
tasks count, ordinary foreground commands do not. Zero-count categories are
omitted. Dismissed counts are not shown; when no visible workers remain the whole
worker card disappears. Expansion shows one flat
list: active work first, then finished work ordered newest first from available
execution timestamps, without a second disclosure. Native V2 terminal reports
retain their provider clock and show **Reported** rather than an exact finish
time: live events time inbox admission, stored messages time delivery, so recovery
can change this clock and the finished order. A missing report clock falls back
to reported execution duration, then launch (**Started**), never local receipt
time or a launcher's completion. These clocks add no worker-state or accounting
authority. A result awaiting launcher correlation has no known start; without a
provider report clock it shows no time. Rows open inspection or retained results;
launch references and their costs remain in the transcript/timeline. Names use
14px type and compact model/effort, Σ cumulative-token and session-USD columns
(11px at default scale), with distinct working, unknown, finished, failed and
stopped glyphs. Wide desktop rows align agent, title and metadata on one line,
with separate 28px Stop/Inspect targets. Visible wide timing captions retain the
full clock and provenance label; long agent/kind prefixes may ellipsize, with the
complete metadata also available in its tooltip. Settled timing metadata stays
hidden on narrow layouts. Narrow desktop/touch rows put the title
first and metadata below; very narrow phones wrap one additional line. Missing
agent/model/usage/effort/cost is not invented. Touch **Stop** remains a separate
44px target with an 8px gap; unknown execution state disables it. Settled rows
retain the approved compact inspection density and narrow-width fallback.
**Dismiss finished**
stays on the right of the same compact header, not in a footer. Unavailable and
ended-without-result rows also offer an individual **Dismiss**. In a Hub these
are personal account state, synchronized across that account's devices and
scoped to the stable workspace, conversation and exact execution. Proven launch
aliases preserve identity across history/replay; a reused child session alone
does not. New executions never inherit an old dismissal. Dismissal changes only
summary visibility, never provider history, work, requests or a task's outcome.
Finished rows use immutable native task, launcher or result anchors even when
they have no current-activity observation. If exact identity is unavailable, the
row stays visible with dismissal guidance; **Dismiss finished** still processes
other supported rows and reports skipped entries.
Verified activity and positively linked pending requests automatically resurface.
Save/read failures are reported rather than silently claimed as synchronized
success. Chat remains available if retirement of an old mark cannot be saved;
an old dismissal can then reapply to an unavailable row after restart, but never
hide currently verified activity or pending requests. Non-Hub source/test
presentation remains device-local; its old marks are not migrated into Hub state.
There is no Restore finished control. Results and their inspection remain in
the timeline; summaries count only visible rows.
Σ usage is cumulative, not context occupancy.
Touch's deliberate worker expansion is kept per conversation within this page's
bounded presentation cache; new work and settlement do not open touch details.
Replacement/batch warnings, applicable batch Send and actionable operation
feedback stay outside the collapse. Successful sends, queue actions and
automatic-background outcomes produce no confirmation notices; failed,
unavailable and unknown guidance remains tied to its source operation; unrelated
Remove, delivery changes or later successful steers cannot clear it. A Settings
read failure means that page cannot confirm the saved preference, not that the
server has disabled a saved ON policy in another tab or device. In desktop UI
mode, Workers opens when visible Working or Unresolved work first appears; Pending
opens when entries first appear, including paused entries. A deliberate collapse
holds throughout that nonempty active-work or pending batch, including further
arrivals. Once that batch is empty, the next batch opens again. Settlement alone
never closes an open card, and finished-only history does not open Workers.
Touch starts collapsed and opens only deliberately. Choices are page-local,
bounded to 200 conversations and isolated by conversation and selected UI mode;
switching modes is not a gesture, and temporary selection clearing during refresh
does not end a batch. Tablet desktop mode follows desktop disclosure policy even
when its touch-first controls retain comfortable density.
Desktop cards share only a measured capacity, never an outer scroller. When both
are collapsed the cap is 40% of the measured chat panel (and 25rem), with the
lesser of 12rem or 35% reserved for conversation. Expanded fine-pointer/hover
desktop cards prefer a 35% reading reserve, bounded to 200–280px; physical action
minimums can reduce it. Touch and comfortable-density layouts use the smaller
reserve described above. Expanded cards do not require Show work when normal
in-flow actions fit. A new replacement warning is revealed once within Pending after the restored
draft has laid out; later updates respect deliberate independent pane scrolling.
Non-empty desktop work reserves at least 52px (3.25rem when larger) so a full
44px action and visible focus ring can be exposed. The transcript yields to
its reserved floor first. If the measured remaining space cannot fit that
minimum, **Show work** opens a scrollable sheet above the composer rather than
clipping actions; **Close work** or Escape restores the entry. Drafts and
persistent feedback stay intact. Keyboard focus reveals the complete action
and ring within the work scrollers, without panning the outer surface.

**Stop parent** affects the current parent execution and its still-blocking
dependencies, not detached workers. **Stop worker** targets that verified
worker only. An accepted request stays **Stopping…** until the provider reports
its outcome. A later provider-owned completion notification can wake the
parent again; Stop is not a permanent ban on future turns.
Confirmed working workers, including foreground agents, label the action **Stop parent**.
On touch devices, it opens an in-app explanation and confirmation before cancelling;
unknown workers and settled history alone neither relabel Stop nor trigger that
confirmation. Cancel leaves all work untouched.

Undo/Revert hides reverted transcript history, not independently verified live
detached workers. Those workers remain inspectable and offer Stop when their
exact current target is verified. Completed reverted history stays hidden;
neither recovery nor a worker's later completion restores the reverted turn.

Stopping a shell removes its provider record and output. If removal prevents
final capture, OpenCode can report **failed**, even after the process exited.
An already confirmed completed report stays completed. Output already received
can remain in the open view, but missing provider output cannot be recovered
after reload; there is no persistent output archive.
An in-app confirmation explains this destructive effect. Cancel or Escape
closes only that confirmation, restores focus and makes no stop request.
If the shell settles while confirmation is open, focus returns to the surviving
inspection action rather than the parent composer.

Reconnect reads history, pending results and current execution evidence.
Complete history is reused only within a connected event generation, invalidated
by session events, and reread after disconnection; execution/inbox evidence stays fresh.
Missing evidence means **Status unavailable**, not finished or cancelled.
Activity and Stop authorization are independent: an owned task with positively
verified current activity can show **Working** while Stop is unavailable. Task
details explain the unavailable control in ordinary text, including on mobile;
a Working label is never permission to interrupt an unverified native target.
This is not a promise of execution survival
across service restarts. Reused child sessions can have ambiguous results, and
the native interruption API cannot atomically lock a particular execution
generation against an external continuation.

Stop also depends on bounded safety records identifying the particular worker
run. Cleaning up display records does not disable targets whose verification
evidence remains retained. If that evidence is missing, revoked or cannot fit,
the target's control stays unverified with Stop unavailable—even if a status read
succeeds. Separately established task activity can still show Working.
History alone does not recreate lost control proof. Unretained targets can remain
unavailable for the provider runtime's lifetime; reconnect does not erase known
revocations. These internal limits do not prevent workers running or messages
being sent. Chat does not automatically restart, cancel work or delete data to
clear them.

Reconnect does not permanently disable controls for every future worker. A new
occurrence needs positively observed native birth and matching invocation proof,
plus fresh ownership and state checks. A content snapshot arriving after reconnect
is not sufficient. If a native hook rewrites a shell command so its birth cannot
be matched to the launcher, that target stays uncertain with Stop unavailable.
User-command shell transcript notes are kept separate from
background-worker report retention; ordinary shell use does not spend that
worker-control budget.

A first child may be born while its launcher is executing, and its first native
execution may start after that launcher returns. These orderings alone do not
revoke the task: association requires positive parent/workspace, compatible
accepted invocation and first-execution evidence. Competing invocations,
intervening execution boundaries and contradictory identity remain vetoes; a
fresh active-session lookup does not clear old revocations. Native event-envelope
clocks are distinct from stored session timestamps and tool-part clocks. Tests
exercise these timing shapes through the public provider seam, not a claim that
an exclusive cause was captured for every historical screenshot.

If a response is lost, Chat reports **Outcome unknown** and refreshes without
replaying the mutation. Same-request retries are deduplicated only while the
in-memory receipt exists: by default up to 15 minutes after settlement, possibly
less under capacity pressure, and never across adapter/process restart.

**Optional workflow tip:** Prefer background subagents for independent work
when useful, non-overlapping work can continue. Keep dependent work foreground;
avoid overlapping writes or use isolated worktrees. Rely on completion
notifications rather than polling. This is advice, not an always-background
policy: Chat does not install instructions or change agent/model defaults.

### Scheduled wakeups (Claude Code)

Claude Code can schedule a future turn for itself with `ScheduleWakeup`,
`CronCreate`, or `/loop`. uatu learns about these wakeups from the SDK's
`Stop` hook, whose `session_crons` field lists what the session holds when
a turn ends. While at least one wakeup is pending and nothing else runs,
uatu keeps the session alive and the conversation is in the scheduled
state. The composer names it, as in "1 wakeup scheduled · next about
20:03", and lists each wakeup with its prompt, whether it repeats, and
roughly when it next fires. The time is uatu's reading of the cron
expression. Claude Code fires on its own clock. You can still prompt in
this state. Each wakeup also gets a timeline row that moves from
scheduled to fired, cancelled, or lost. A fired row links to the turn it
started.

When a wakeup fires, Claude Code starts a turn by itself. The turn opens
with a Wakeup header that carries the wakeup's prompt, so it never looks
like a message you typed. uatu spots the turn through the
`UserPromptSubmit` hook. It uses the hook's `source` field when the CLI
sends one. The CLIs tested so far don't, so uatu falls back to matching
the prompt against a pending wakeup while none of your prompts is
outstanding. A reopened conversation replays fired wakeup turns with the
same header when the transcript records their origin. Claude Code 2.1.281
and later write that down. For older transcripts, uatu matches the prompt
against the scheduling call earlier in the same file.

Each wakeup in the list has a **Cancel**. **Release session** cancels every
wakeup, then ends the session, and the conversation goes idle. uatu refuses
a release while a turn runs, or while background work would die with the
process.

Ending the process is not enough to stop a cron. When a session resumes,
Claude Code rebuilds its `CronCreate` crons from the transcript, and a
recurring one fires again within a minute, without a prompt. So uatu
enforces a cancel itself. It remembers the cancelled wakeups for the
conversation, and when one of them fires in a later session, it blocks
the prompt through the `UserPromptSubmit` hook. The blocked fire makes no
model call and starts no turn, and uatu never keeps a session alive for a
cancelled wakeup. The agent's own `CronList` still shows the cron, because
Claude Code has no way for a host to delete one.

What happens when a session ends with wakeups pending depends on the
tool that made them:

- A `ScheduleWakeup` lives only as long as its process. Its row reads as
  lost, with a notice that the agent's schedule did not survive its
  session.
- A `CronCreate` cron reads as paused. It fires again once the
  conversation runs, which means once you prompt it. Claude Code drops
  a one-shot cron whose time passes before then.

A conversation opened without a live session lists its paused crons next
to the composer, read from its transcript, each with a Cancel. uatu never
starts a session on its own to keep a schedule running. The paused list
is uatu's reading of the transcript: the first turn after a resume
reports what Claude Code actually rebuilt, and any row it did not restore
reads as lost.

`CronCreate` accepts `durable: true`, but Claude Code downgrades it to
session-only when the session runs through the SDK. Chat never sees a
durable cron.

The canonical first watched root is the immutable working directory for
both agents. For a direct multi-root command, later roots remain available
to Preview but Chat uses only the first root. Browser requests cannot
select another working directory, and conversations belonging to another
canonical directory are not listed or accepted.

Stopping the uatu workspace stops its OpenCode child and any live Claude
Code sessions, ending their active turns and any scheduled wakeups they
held. Completed history remains in
each agent's own storage and is available when the workspace starts
again. Closing a browser, PWA, or UatuCode Desktop window does not stop a
hub workspace.

## Access And Authority

Users authenticate to the hub. Behind it, each workspace child requires
its short-lived workspace credential for Chat reads and mutations, and a
same-origin request for mutations. The hub brokers that credential, so it
never reaches a browser. Chat HTTP is proxied under `/s/<workspace-id>/`;
conversation and inventory updates reach the page over its one live stream
(`/api/hub/live`). The hub does not expose any loopback agent service.
Hub users share the authority of the operating-system account running the
hub.

An agent can read files, execute commands, and modify anything that the
daemon's OS user can access. uatu workspace membership and an agent's
permission prompts are not an OS sandbox. Claude Code's
`bypassPermissions` mode is not offered unless the workspace operator
explicitly enables it. Do not give mutually untrusted users access to one
hub account or daemon user. See [Self-hosting](./SELF-HOSTING.md) for the
complete trust model and network guidance.

## Troubleshooting

- **An agent is not installed:** its executable was not found on the
  server process's `PATH`. Verify it from the service account and restart
  the workspace after correcting `PATH`. The other agent keeps working.
- **OpenCode could not start:** run `opencode serve --hostname 127.0.0.1
  --port 0` as the daemon user and inspect its diagnostic. Check
  executable permissions, configuration syntax, and service-manager
  environment.
- **Claude Code could not start:** run `claude --version` as the daemon
  user; the Chat diagnostics panel carries the probe's captured output.
- **Installed version is not compatible:** upgrade the agent, then use
  Retry on its unavailable panel — a retry restarts only that agent.
- **A prompt fails or no model is available:** run the agent directly and
  verify its provider authentication (`/connect` and `/models` in
  OpenCode; sign in again in Claude Code). Provider failures do not
  disable Preview, Files, Search, Terminal, or the other agent.
- **A conversation is missing:** sessions are filtered to the canonical
  first root. Confirm the agent created the session in exactly that
  workspace directory.
- **Chat reconnects or requests resync:** a brief disconnect replays
  retained events. A workspace restart or a long retention gap requires a
  fresh history snapshot automatically; completed agent history is not
  deleted. OpenCode 2.x has no native event replay: recovery reads history
  after subscribing, reconciles exact native revert-boundary exclusions,
  and requests a fresh view when that boundary changes. Missing rows in a
  history page alone never authorize removal. Recovery does not replay a
  prompt or resume paused work.
- **A scheduled wakeup never fired:** a row that reads as lost means the
  workspace stopped or the process exited before it fired, so ask the
  agent to schedule it again. A row that reads as paused fires again once
  you prompt the conversation. A row that reads as cancelled was removed
  by the agent, or by you through Cancel or Release; uatu blocks it even
  if the agent's `CronList` still shows it.
- **Hub Chat is unauthorized:** sign in again and verify the workspace is
  running. Do not proxy a child session directly or rewrite its base path.

## Vocabulary

Three words, three meanings. They are used this way in the UI, in the
specs, and in the route table.

- **agent** — a program Chat talks to: OpenCode or Claude Code. Every
  conversation names its owning agent, and conversation ids are
  agent-qualified on the wire.
- **mode** — how an agent is asked to work: OpenCode's Build and Plan,
  Claude Code's permission modes (`auto`, `default`, `acceptEdits`,
  `plan`; `auto` is the declared default a fresh conversation starts in).
  Listed per agent at `/api/chat/modes?agent=...`. OpenCode calls these
  agents on its own wire; uatu does not, because the word is taken.
- **subagent** — an agent the agent spawned inside a turn. What the
  pinned bottom track shows, and what opens as a drill-down transcript.

An agent declares what it can do, and Chat presents a control only when
the capability behind it is declared. A capability is declared positively:
it is in the agent's list, or the agent does not have it. There is no
"false" and no "unknown", so an absent control means the agent cannot do
that thing — not that it failed, and not that it is empty.

## Scope

OpenCode and Claude Code are the agents currently declared. This
integration does not implement ACP, Codex, session sharing, or a native
SwiftUI chat renderer, and it does not import Claude Code sessions
recorded under other working directories. Another agent may be added
behind uatu's normalized API; each agent's own provider support remains
configured and authenticated through that agent.

Chat surfaces the models each agent has available — OpenCode's configured
providers, Claude Code's model catalog with per-model effort levels — and
offers each agent's own slash commands. Neither adds a provider or
credential of its own: authentication stays with the agent.
