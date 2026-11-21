# antigravity-chat Specification (delta)

## Purpose

Define the Antigravity chat agent: how a workspace finds and reports the installed Antigravity CLI (`agy`), runs it over the Agent Client Protocol under the user's own Antigravity login, normalizes its activity into the shared conversation timeline, and reports its models, modes, permissions, usage, and cost.

## ADDED Requirements

### Requirement: Chat uses the workspace's installed Antigravity CLI
When an Antigravity conversation or listing is first needed, UatuCode SHALL find the `agy` executable on the workspace process's search path and report its availability from a bounded version probe, without keeping an idle process. A missing or failing `agy` SHALL be reported as an actionable unavailable state attributed to Antigravity, while the workspace, non-chat capabilities, and other agents remain usable.

#### Scenario: Antigravity is not installed
- **WHEN** the workspace cannot resolve an `agy` executable
- **THEN** the Antigravity agent reports that Antigravity must be installed
- **AND** OpenCode and Claude Code conversations, preview, search, and terminal continue working

#### Scenario: A failed probe names Antigravity
- **WHEN** `agy --version` does not answer within the probe budget or exits without a recognizable version
- **THEN** the unavailable state names Antigravity and carries the resolved executable path, any shadowed `agy` executables, the elapsed time, and bounded probe output
- **AND** a user-initiated retry probes again without restarting the workspace

#### Scenario: Availability leaves nothing running
- **WHEN** Antigravity's availability has been determined and no conversation is active
- **THEN** no `agy` process started by UatuCode is left running

### Requirement: Antigravity's login stays with its CLI
UatuCode SHALL run Antigravity under the login `agy` already holds and MUST NOT request, read, copy, persist, log, or transmit Antigravity credentials or tokens. Antigravity SHALL declare a login the Hub does not manage, with `agy` as its login command, so the Hub's Agent accounts has no Antigravity entry. A missing login SHALL be reported as the agent's login-missing state, not as a startup failure.

#### Scenario: An existing login is reused
- **WHEN** the user has signed in through `agy` and starts an Antigravity conversation
- **THEN** the conversation runs under that login without UatuCode asking for any credential

#### Scenario: No login is a login-missing state
- **WHEN** `agy` answers a conversation listing or creation with its authentication-required error
- **THEN** Antigravity is ready with a missing login, and its guidance says to run `agy` and sign in
- **AND** existing Antigravity conversations that were already listed remain readable

#### Scenario: Agent accounts has no Antigravity entry
- **WHEN** a user opens the Hub's Agent accounts
- **THEN** it lists OpenCode and Claude Code only

#### Scenario: A rejected login fails the turn as a login failure
- **WHEN** an Antigravity turn fails with `agy`'s authentication error
- **THEN** the turn is presented as "Antigravity login failed" with `agy`'s message as detail and the guidance to run `agy`

### Requirement: Each live Antigravity conversation has its own process
Each Antigravity conversation with a turn running, a pending permission, or an open history read SHALL be served by its own `agy acp` process scoped to the workspace directory. A conversation idle for a bounded time SHALL release its process. Listing conversations SHALL use a separate short-lived process. Workspace shutdown SHALL end every `agy` process it started before shutdown completes.

#### Scenario: Prompting a conversation without a process resumes it
- **WHEN** a user prompts an Antigravity conversation that has no running process
- **THEN** a process is started, the conversation's session is loaded, and the prompt runs in it with earlier context in effect

#### Scenario: One conversation's process failure stays in that conversation
- **WHEN** the `agy` process serving one Antigravity conversation exits unexpectedly
- **THEN** that conversation's running turn fails with an error naming Antigravity
- **AND** other Antigravity conversations and other agents are unaffected

#### Scenario: Shutdown ends the processes
- **WHEN** the workspace shuts down while Antigravity processes are running
- **THEN** each is ended before shutdown completes, and none is left behind

### Requirement: Antigravity conversations are listed and opened from agy's sessions
The workspace SHALL list Antigravity conversations for the canonical workspace directory from `agy`'s own session list, with their titles, as `antigravity:<sessionId>`. Opening a conversation SHALL present its history from `agy`'s session replay without starting a turn. A conversation id that `agy` does not list SHALL be reported as not found rather than loaded.

#### Scenario: A conversation from the session list opens with its history
- **WHEN** a user opens an Antigravity conversation from the chooser
- **THEN** its messages, thoughts, and final tool calls appear from `agy`'s replay
- **AND** no turn is started

#### Scenario: An unknown conversation id is refused
- **WHEN** a request addresses an Antigravity conversation id that `agy`'s session list does not contain
- **THEN** the request fails as conversation not found
- **AND** no prompt is sent to `agy`

#### Scenario: A failing listing does not empty the chooser
- **WHEN** `agy` cannot list its sessions
- **THEN** OpenCode and Claude Code conversations remain listed

### Requirement: History is enriched from agy's transcript when it can be read
Where `agy`'s on-disk transcript for a conversation is present and recognized, opened history SHALL add what replay omits: permission outcomes, file-read output, and each turn's tokens and model. A missing, unreadable, or unrecognized transcript SHALL leave the replayed history as it is, without an error shown to the user. Reading the transcript MUST NOT change it.

#### Scenario: A recognized transcript adds detail
- **WHEN** a user opens an Antigravity conversation whose transcript is present and recognized
- **THEN** tool rows show their permission outcome and file-read output
- **AND** each earlier turn has its tokens and model

#### Scenario: A missing or changed transcript falls back quietly
- **WHEN** the transcript is missing or its format is not recognized
- **THEN** the conversation opens with the replayed history alone
- **AND** no error is shown

### Requirement: Antigravity activity is normalized into the shared timeline
Antigravity's streamed messages, thoughts, tool calls, and turn ends SHALL appear in the shared timeline as assistant messages, reasoning, and tool activity with their statuses. A tool waiting for the user's permission SHALL be shown as waiting for permission, not as running. A command's output and exit code SHALL be shown when `agy` reports them.

#### Scenario: A gated tool waits for permission
- **WHEN** `agy` reports a tool as in progress and then requests permission for it
- **THEN** the tool row shows that it is waiting for permission while the permission card is open

#### Scenario: A command shows its output and exit code
- **WHEN** `agy` completes a command and reports its output and exit code
- **THEN** the tool row shows that output and exit code

#### Scenario: A denied tool ends the turn without a reply
- **WHEN** the user denies a permission and `agy` ends the turn without further text
- **THEN** the tool row is shown as failed and the turn as completed

### Requirement: Antigravity permission requests are answered in place
A permission request from `agy` SHALL appear as a permission card offering exactly the choices `agy` offers, which are allow once and deny. The card SHALL carry no persistent-approval sentence. The user's answer SHALL be returned to `agy`, and a request left unanswered when its turn or process ends SHALL resolve visibly as abandoned.

#### Scenario: Allow once runs the tool
- **WHEN** the user chooses allow once on an Antigravity permission card
- **THEN** `agy` receives that choice and the tool runs

#### Scenario: Only agy's choices are offered
- **WHEN** an Antigravity permission card is shown
- **THEN** it offers allow once and deny, and no choice that approves future requests

#### Scenario: An unanswered request is abandoned
- **WHEN** the turn is interrupted or the process ends while a permission card is open
- **THEN** the card resolves as abandoned and the conversation accepts a new prompt

### Requirement: Models, thinking levels, and modes follow agy
The model picker SHALL offer the models `agy` advertises for the session, with their thinking levels as reasoning variants, and the modes default, accept edits, and plan. A conversation's chosen model, thinking level, and mode SHALL be applied again whenever its session is loaded or resumed, because `agy` starts a loaded session on its own default.

#### Scenario: Thinking levels appear as variants
- **WHEN** `agy` advertises a model with thinking levels
- **THEN** the picker offers that model with those levels as its variants

#### Scenario: The chosen model survives a resume
- **WHEN** a conversation that chose a non-default model is prompted after its process was released
- **THEN** the new turn runs on the chosen model and thinking level, not `agy`'s default

#### Scenario: A mode change applies to the conversation
- **WHEN** the user switches an Antigravity conversation to plan mode
- **THEN** `agy` runs the conversation's next turn in plan mode

### Requirement: agy's slash commands are offered
The commands `agy` advertises for a session SHALL be offered as slash commands with their descriptions. A chosen command SHALL be sent to `agy` as the prompt text.

#### Scenario: A command is sent as prompt text
- **WHEN** the user submits an advertised `agy` command with arguments
- **THEN** `agy` receives the command and its arguments as the prompt text

### Requirement: An Antigravity turn can be interrupted
The user SHALL be able to cancel a running Antigravity turn. Cancelling SHALL end the turn as interrupted, stop any command the turn is running, and leave the conversation ready for a new prompt.

#### Scenario: Cancel ends the turn
- **WHEN** the user cancels a running Antigravity turn
- **THEN** the turn ends with an interrupted status
- **AND** a command it was running is stopped
- **AND** the conversation accepts a new prompt

### Requirement: Antigravity takes messages sent during a turn at once
Antigravity SHALL declare `immediate-steering` and `send-now`, and SHALL NOT declare `steering`, because `agy` takes a second prompt into the running turn at once and offers no way to withdraw it. A steer SHALL be sent to `agy` as a further prompt in the same session. The end `agy` reports for the earlier prompt SHALL NOT end the conversation's turn, and the workspace SHALL hold other prompts until the carried turn ends.

#### Scenario: A busy steer joins the running turn
- **WHEN** the user steers ordinary text while an Antigravity turn is running
- **THEN** `agy` receives it as a further prompt in the same session
- **AND** the conversation stays running, with the reply to the steer continuing the turn

#### Scenario: The first prompt's end is not the turn's end
- **WHEN** `agy` ends the earlier prompt because a steer arrived
- **THEN** no completion is reported and held messages stay held
- **AND** the turn ends when `agy` ends the steered prompt

#### Scenario: Queued messages wait for the whole turn
- **WHEN** the user queues a message with Alt/Option+Enter during an Antigravity turn that a steer has extended
- **THEN** the message is delivered only after the extended turn ends

### Requirement: Antigravity reports context use and token usage
Chat SHALL show an Antigravity conversation's context-window use from the used and size figures `agy` reports, and each turn's token usage, including thinking and cached tokens where reported. Opening a conversation SHALL show the latest figures its history supplies.

#### Scenario: Context use follows agy's report
- **WHEN** `agy` reports that a session uses part of its context window
- **THEN** the context indicator shows that fill against the reported size

#### Scenario: Earlier usage is restored from the transcript
- **WHEN** a user opens a conversation whose transcript records earlier turns' tokens
- **THEN** those turns' token usage is shown before any new turn

### Requirement: Antigravity conversation cost is estimated from a built-in price table
Because `agy` reports tokens but no price, Chat SHALL compute each turn's cost from the reported tokens and a price table built into UatuCode, without a runtime network request. The cost SHALL be presented as other agents' costs are. A turn whose model has no price, directly or through its family, SHALL contribute no cost rather than zero.

#### Scenario: A priced turn shows its cost
- **WHEN** an Antigravity turn on a priced model reports input, output, thinking, and cached tokens
- **THEN** the conversation's cost includes that turn, with thinking tokens at the output rate and cache writes unpriced

#### Scenario: A model without its own price uses its family's
- **WHEN** a turn ran on a model that the price table prices only through its model family
- **THEN** the turn is priced at that family's rates

#### Scenario: Thinking level does not change the rate
- **WHEN** two turns run the same model at different thinking levels
- **THEN** both are priced at that model's rates

#### Scenario: An unknown model is unpriced
- **WHEN** a turn ran on a model that the price table cannot price
- **THEN** the turn contributes no cost
- **AND** a conversation with no priced turns shows no cost figure

#### Scenario: Reopened conversations keep earlier costs
- **WHEN** a user opens a conversation whose transcript records earlier turns' tokens and models
- **THEN** the cost includes those turns before any new turn

### Requirement: Images attached to a prompt reach Antigravity
Where `agy` advertises image prompts, Antigravity SHALL declare attachments, and an image attached to a prompt SHALL reach `agy` with that prompt. Where it does not, attachments SHALL NOT be declared.

#### Scenario: An attached image is sent with its prompt
- **WHEN** `agy` advertises image prompts and the user sends a prompt with an attached image
- **THEN** `agy` receives the image with the prompt text

### Requirement: Antigravity capabilities are declared truthfully
The Antigravity agent SHALL declare models, variants, modes, commands, permissions, context, immediate-steering, and send-now, and attachments where `agy` supports them. It SHALL NOT declare steering, conversation rename, reversible history, background tasks, questions, subagents, scheduled wakeups, side questions, plan usage, or custom model ids.

#### Scenario: Undeclared abilities are absent
- **WHEN** a client reads the Antigravity agent's declaration
- **THEN** rename, undo and redo, background work, subagent, wakeup, and side-question controls are absent from Antigravity conversations
- **AND** no pending Steer entry or steer withdrawal action appears in them
