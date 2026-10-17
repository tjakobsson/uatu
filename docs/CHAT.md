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
Successful reads and saves say **Saved**; the switch shows ON/OFF. Conflicts,
unavailable settings and unconfirmed saves keep their explanatory messages.

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
Late evidence never schedules a delayed background request. Same-account,
same-request retries retain the first policy/outcome only while the bounded
in-memory receipt survives (15 minutes after settlement by default, or less
under count/byte pressure). Expiry, eviction and adapter/process restart end
that protection; reload/reconnect never automatically replays the mutation.
After refreshing evidence, explicit Continue is a fresh action, not a resend.

Unknown steer/resume retention does not depend on automation being available.
When private child trust is unavailable, the Hub still keeps accounts' operation
identifiers separate without sending unsigned account identity or automation
permission. The first degraded feedback snapshot is also memory-bounded (up to
15 minutes from the proxy decision, or less under capacity pressure); losing
either that snapshot or the child receipt ends composite replay protection.
Queue → Steer and Send now response loss or server errors show persistent
unconfirmed guidance for the current page and refresh state read-only, leaving
an unrelated composing draft untouched. Reconnect/reload does not replay them.

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

**Send** taps steer ordinary text while OpenCode V2 is busy; the separate
**Stop** cancels the current response. Hold Send continuously for **2 seconds**
to queue automatically, exactly once without releasing. Releasing an intentional
hold (250ms–2s), dragging outside the original button, Escape, lost capture,
pointer cancellation, leaving the tab, moving the target or changing the
draft/conversation/configuration cancels without sending.
The countdown clears the finger immediately; its pointer-transparent envelope
grows upward from 56px to 104px above the fixed Send target while filling
bottom-to-top. Reduced motion keeps the full extension and live countdown
without the growth. The visual is viewport-owned, outside composer/dock clipping.
The Send target never moves. Idle held
sends dispatch normally, rather than inventing a pending queue entry.
There is no Send dropdown. Keyboard users can hold Space on Send for the same
two-second Queue action; Enter activates Send immediately. Escape cancels the
hold and preserves focus. Send's accessible description explains these keys.
Desktop Enter in the message field uses the existing per-device preference;
on touch devices Enter always adds a newline and Ctrl/Command+Enter submits.
Alt/Option+Enter uses the other choice. Send's accessible description names the
current shortcuts. Idle messages send immediately. Claude Code
and OpenCode V1 queue busy follow-ups without offering steering. Pending images
and native commands queue rather than being labelled as a text steer; replacement
submission retains the native staged-revert semantics.

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
the response without stealing focus while it is generated. Empty native text is
reported honestly (the model may have attempted a tool call). Pending attachments
are refused and retained; V1/Claude do not offer this command, and typing it there
is refused rather than sent as an ordinary prompt. No automatic replay/retry is
performed. Like native inference it may consume model usage; these tests use only
the scripted fake, not a paid/live model. User-installed native plugins retain
their existing hooks; this is not a new sandbox against arbitrary plugin code.
If inference fails while you compose a newer draft, that draft stays unchanged;
**Side question failed** retains the original question and failure for inspection.

### Pending messages

The pending dock counts steers and queued messages. Each entry has its delivery
badge, a separate **Paused** chip when applicable, and message-specific actions.
For duplicate text and image-only entries, accessible action names also identify
a stable pending-message number while that entry remains in the dock. Each
successful action announces once, even when you repeat the same kind of action.
Paused messages wait for your next message or an explicit send action.
**Send N paused steers now** wakes them together. Sending a queued message as a
steer also wakes paused steers; its label and confirmation explain that effect.
Other dormant queued messages remain held. Undo's count-only warning explains
which batch will accompany the replacement, without repeating message text.

On touch screens, work tracks share a bounded, independently scrollable dock.
Short keyboard/landscape layouts use compact input controls and counts;
uncertain feedback has its own scrollable band (a bounded column in landscape),
so it cannot consume the draft field. The inline model/context pill opens the
real configuration picker directly, without a second Options panel or context
circle. Paused-batch Send and replacement warnings remain available while typing.
Outside picker taps dismiss it without activating controls below it.

Edit returns an entry to the composer only after withdrawal succeeds. If
delivery wins first, **Too late — already delivered** is informational: your
private draft stays intact and the delivered message appears only once.

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

When supported, **Continue while workers run** explicitly moves **all eligible
blocking jobs in the parent**, including shell commands, to the background.
It does not stop them, submit or clear your draft, or change delivery/model
selection. Acceptance is not a worker count; nothing eligible is a valid no-op.
Outside the verified personal Hub steer case above, Send never backgrounds
work automatically; standalone retains explicit Continue only.
The action appears only with running blocker evidence, not merely because the
parent is generating or already has detached workers. **What continues?** and
the button tooltip explain its all-eligible scope. Feedback disappears after
the parent and workers settle. Continue and its explanation remain in the work
dock; account usage stays beneath the inline actions when reported. The model
pill opens the single picker directly. The worker summary remains reachable
with hardware or software keyboards and in short landscape. Its compact header
uses a small chevron; deliberate expansion uses a content-sized sheet over the transcript
when space is constrained, without discarding the draft or forcing keyboard
blur. Pending counts, paused-batch Send and replacement warnings
remain available while typing.
Touch has one initially collapsed pending summary and one worker summary.
Pending counts distinguish steers from queued input without repeating the total
or zero categories (for example, **1 queued** or **2 steers · 1 queued**).
Its header uses a 32px target; compact cards share the delivery label and message
line where they fit, followed by inline actions. Pending actions use the explicitly
approved 32px density tradeoff with independent 8px gaps, including before Remove;
existing confirmation safeguards remain unchanged. Composer Send/Stop and
paused-batch Send stay 44px.
Pending message leading scales with text enlargement (14px type/20px leading at
default size, 28px/40px at 200%); multiline cards grow naturally inside the dock
scroller instead of overlapping lines or imposing a fixed card height.
Queued image rows and thumbnails stay within the card width when text is enlarged.
Pending footers and action groups can shrink to the card width; long labels such
as **Send now + paused steers** wrap without truncation. When a paused-batch
header would crowd out enlarged actions in a text-relative narrow container
(up to 12rem), it scrolls with the dock instead of remaining sticky. Normal-size
sticky counts, confirmation wording and paused-batch delivery semantics stay intact.
Worker counts distinguish
confirmed working, finished (including failed/stopped), and unknown occurrences.
Counts and rows use the same deduplicated executions: actual background shell
tasks count, ordinary foreground commands do not. Zero-count categories are
omitted. Dismissed counts are not shown; when no visible workers remain the whole
worker card disappears. Expansion shows one flat
list: active work first, then finished work ordered newest first from available
execution timestamps, without a second disclosure. Rows open inspection or retained results;
launch references and their costs remain in the transcript/timeline. Names use
14px type and compact model/Σ cumulative-token columns (11px at default scale), with distinct working,
unknown, finished, failed and stopped glyphs. **Stop worker** is a separate
44px target with an 8px gap; unknown execution state disables it. Inspection
targets and settled rows use the explicitly approved 28px density tradeoff;
only a row containing Stop grows to fit that separate action. **Dismiss finished**
stays on the right of the same compact header, not in a footer, and hides only this device's per-conversation
view using the existing persisted dismissal state, never provider history.
There is no Restore finished control. Results and their inspection remain in
the timeline; summaries count only visible rows.
Σ usage is cumulative, not context occupancy.
Deliberate worker expansion is kept per conversation within this page's bounded
presentation cache; new work and settlement do not open details.
Replacement/batch warnings, applicable batch Send and actionable operation
feedback stay outside the collapse. Only known successful automatic-background
acknowledgements clear on status change or complete settlement; failed,
unavailable and unknown guidance remains tied to its source operation; unrelated
Remove, delivery changes or later successful steers cannot clear it. A Settings
read failure means that page cannot confirm the saved preference, not that the
server has disabled a saved ON policy in another tab or device. Desktop
retains its existing tracks and automatic expansion: detachment collapses only
an automatically opened duplicate track, not one deliberately reopened.
Desktop tracks and pending messages share a scrollable aggregate capped at
40% of the measured chat panel (and 25rem), yielding further to keep the
composer fully visible and reserve the lesser of 12rem or 35% for the transcript.
The individual expanded-list rem caps remain. A new replacement warning is
revealed once within that aggregate after the restored draft has laid out;
later updates respect deliberate work-dock scrolling.
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
On touch devices, Stop parent with live worker records opens an in-app explanation
and confirmation before cancelling; settled history alone neither relabels Stop
nor triggers that confirmation. Cancel leaves all work untouched.

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
Missing evidence means **Status unavailable**, not finished or cancelled; an
unverified worker cannot be stopped. This is not a promise of execution survival
across service restarts. Reused child sessions can have ambiguous results, and
the native interruption API cannot atomically lock a particular execution
generation against an external continuation.

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
  deleted.
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
