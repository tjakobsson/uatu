## MODIFIED Requirements

### Requirement: Models and effort levels follow Claude Code's catalog
The Claude Code agent SHALL list the models Claude Code offers and SHALL
offer each model's supported effort levels as that model's reasoning
variants. Claude Code's own recommended default SHALL be offered as a
first-class entry presented as the active choice while no model has been
chosen, in place of a generic delegation row, and choosing it SHALL
leave the model resolution to Claude Code. Every surface that names a
model SHALL name it with its version, for example "Opus 5 (1M context)"
or "Fable 5.1", derived from the catalog when its display name lacks one.
In addition to the catalog, the agent SHALL offer the models the Claude
apps offer under "More models" that the catalog omits, and SHALL accept
a user-typed model id, each presented as distinct from the catalog's own
entries. A rejected id SHALL fail the turn with the CLI's error, not
silently fall back. A model or variant selection SHALL apply to the
conversation's subsequent prompts. An effort level not supported by the
selected model MUST NOT be selectable with it. The model's context-window
size SHALL be reported when known so context usage can be presented.
The catalog SHALL be read from Claude Code itself before the first
conversation runs when the install permits it, with a static fallback
only for an install that cannot answer. Model ids reported by a running
session SHALL be attributed to catalog entries so context usage joins
the window actually in effect.

Each offered model's context window, including the catalog's rows, the
"More models" rows, and the recommended default, SHALL use the window
Claude Code itself states for that model on this install and login.
Windows SHALL be requested when the catalog is first read. Reading the
windows MUST NOT delay the catalog. Each accepted discovery SHALL become
available to subsequent catalog reads and SHALL cause connected clients
to refresh the affected catalog and context readout without a user action
or waiting for a turn to finish. Reading these windows SHALL NOT spend
tokens or make a model call, and MUST NOT change the model of any
conversation.

A window derived from a known model id or a static list SHALL be labelled
as an estimate and SHALL be used only when no applicable Claude-reported
window is available. An unrecognized model with no defensible estimate
SHALL have an unknown window, not an assumed 200k window. A previously
reported value reused while its execution context is being revalidated
SHALL be identified as cached. An estimate or catalog refresh MUST NOT
replace an applicable confirmed window. A fresh session report SHALL be
allowed to replace an older window with either a larger or smaller one.

The conversation SHALL request its effective window from its own Claude
session after applying its selected configuration and before delivering
the first prompt on that session. This SHALL include typed model ids and
resumed conversations. Waiting for this answer SHALL be bounded: a failed
or slow read MUST NOT prevent prompt delivery, cancellation, or normal
stream processing. A valid late answer SHALL update the running
conversation. A response from a superseded session, selection, or login
context MUST NOT override a newer context. Different window variants
SHALL remain distinguishable even when Claude reports the same bare model
id for both.

A transient read failure SHALL remain eligible for a bounded retry with
backoff while the value is needed. An attempted read MUST NOT count as a
success. Concurrent requests SHALL share discovery work; unsupported
controls SHALL NOT cause an endless retry loop. Discovery SHALL stop
when its owning provider is disposed.

The recommended default SHALL be presented as the model it actually runs
in the workspace after user, project, environment, and managed settings
are applied, rather than the catalog's account-level resolution when the
two differ. The model it runs SHALL determine the default entry's stated
resolution, its name on every surface, its description, its effort
levels, and its context window. A model the default runs that no offered
entry represents SHALL be named by its id. The default's resolution
SHALL be learned before any turn when Claude can answer and SHALL remain
in force across an ordinary catalog refresh. An applicable newer
observation SHALL update it; the catalog's own resolution is the fallback
only when Claude Code cannot report what the default runs.

#### Scenario: The recommended default is the active choice and names its resolution
- **WHEN** a Claude Code conversation has not chosen a model
- **THEN** the catalog's recommended default is presented as the active choice
- **AND** surfaces that state the choice name the model it currently resolves to, with its version

#### Scenario: A catalog entry without a version in its name is still named with one
- **WHEN** the catalog names a model "Fable" and describes it as "Fable 5.1 · …"
- **THEN** the picker, composer, and conversation surfaces name it "Fable 5.1"

#### Scenario: An app-only model is offered and runs
- **WHEN** a user selects a "More models" entry such as Opus 4.6
- **THEN** subsequent prompts run under that model id
- **AND** the context window presented is the one that model actually has when Claude has stated it
- **AND** any fallback figure is explicitly identified as an estimate

#### Scenario: A typed model id runs or fails visibly
- **WHEN** a user enters a model id the picker does not list
- **THEN** the next prompt runs under that id
- **AND** an id Claude Code rejects fails that turn with the reported error

#### Scenario: An effort chosen while the default is active travels with the prompt
- **WHEN** a user selects an effort level without first choosing a model
- **THEN** the prompt runs under that effort against the default entry's model
- **AND** the presented effort is the effort actually sent

#### Scenario: The catalog is live before any turn
- **WHEN** the model picker is first read on a workspace whose Claude Code install is healthy
- **THEN** it lists Claude Code's own catalog with its recommended default
- **AND** an install that cannot answer yields the static fallback instead of an error

#### Scenario: Effort qualifies the selected model
- **WHEN** a user selects a model and one of its effort levels
- **THEN** subsequent prompts run with that model and effort
- **AND** the presented effort is the effort actually sent

#### Scenario: A model's window is the one Claude Code states, before any turn
- **WHEN** the model picker is read on a healthy install whose catalog offers Sonnet 5.5 under an id with no window marker, after Claude Code has stated a 1M window for it
- **THEN** Sonnet 5.5 is offered with a 1M context window, though no conversation has run
- **AND** no tokens are spent and no model call is made to learn it

#### Scenario: Reading windows does not delay the catalog
- **WHEN** the model picker is first read and Claude Code takes seconds to state every model's window
- **THEN** the catalog is presented without waiting for all windows
- **AND** a model whose window has not been stated yet is presented with a labelled estimate or an unknown window
- **AND** a discovered window reaches the open picker and applicable readout without reopening the picker

#### Scenario: Settings that override the account default are what the default names
- **WHEN** the catalog's default row resolves to Sonnet 5.5 and the workspace's Claude Code settings set the model to `fable[1m]`
- **THEN** before any turn on a healthy install the default is presented as "Default · Fable 5.1", resolving to the Fable 5.1 entry
- **AND** its description and effort levels are Fable 5.1's
- **AND** a first prompt under the default runs on Fable 5.1, matching what was presented

#### Scenario: The default's window is the window of what it runs
- **WHEN** the recommended default runs a model whose stated window differs from the window of the model the catalog names for it
- **THEN** the default entry's context window is the stated window of the model the default actually runs

#### Scenario: A default running an unlisted model is named by its id
- **WHEN** the workspace's settings make the default run a model id that no offered entry represents
- **THEN** the default is presented naming that id
- **AND** not as the catalog's account-level resolution, nor as an unnamed "Default (recommended)"

#### Scenario: The default's resolution outlives a catalog refresh
- **WHEN** the default's actual model has been learned and a conversation then starts and refreshes the catalog without reporting a different resolution
- **THEN** the default is still presented as the model it actually runs

#### Scenario: Without a report the catalog's resolution stands
- **WHEN** Claude Code cannot report what the default runs
- **THEN** the default is presented by the catalog's own resolution, as before

#### Scenario: Reading windows leaves running conversations alone
- **WHEN** the catalog and its windows are read while a Claude Code conversation is running under a chosen model
- **THEN** that conversation's model is unchanged and its next prompt runs under the model it had

#### Scenario: A stated window outlives a catalog refresh
- **WHEN** a model's window has been stated and a conversation then starts and refreshes the catalog
- **THEN** the model is still offered with its applicable stated window, not an id-derived figure

#### Scenario: A model with no stated window falls back to the derived figure
- **WHEN** Claude Code cannot state a window for a model with a known static or id-derived figure
- **THEN** the model is offered with that figure explicitly labelled as estimated
- **AND** the catalog itself is still offered

#### Scenario: An unrecognized model has no invented window
- **WHEN** a typed or newly listed model has no known estimate and Claude cannot state its window
- **THEN** the window is unavailable rather than assigned 200k
- **AND** the user can still send a prompt under that model id

#### Scenario: The conversation states its window before its first prompt
- **WHEN** the user selects Opus 5.5 and its own Claude session reports 1M within the bounded startup read
- **THEN** 1M is available to the conversation before its first prompt is delivered
- **AND** a smaller catalog estimate does not replace that answer

#### Scenario: A stalled startup read does not hold the prompt
- **WHEN** the conversation's initial window read exceeds its startup wait budget
- **THEN** prompt delivery proceeds with a labelled fallback or unknown limit
- **AND** cancellation and stream processing remain available
- **AND** a valid late answer updates the conversation while it is running

#### Scenario: A failed discovery can recover
- **WHEN** a window read fails transiently and a bounded retry succeeds
- **THEN** connected clients receive the recovered value without another model selection or a completed turn
- **AND** concurrent requests do not multiply the retry work

#### Scenario: Unsupported discovery does not loop
- **WHEN** the CLI does not support window reads
- **THEN** the catalog and prompting remain available with labelled estimates or unknown windows
- **AND** discovery does not continuously restart a process or issue reads

#### Scenario: A superseded answer cannot change the current window
- **WHEN** a read started under one session, model selection, or login finishes after that context has been superseded
- **THEN** it does not replace the current context's window
- **AND** a newer answer can increase or decrease the current window

#### Scenario: Window variants remain distinct
- **WHEN** two selections resolve to the same bare model id but Claude reports different windows for them
- **THEN** each conversation uses the window of the variant it actually runs
- **AND** the first catalog alias does not determine both conversations' limits

### Requirement: Context usage measures the window, not the turn's spend
Context usage for a Claude Code conversation SHALL be the occupancy of the
context window after the most recent model call: the tokens that call
sent as input, read from cache, and wrote to cache. It MUST NOT be summed
across the calls of a turn. When Claude Code compacts the conversation,
the reported occupancy SHALL drop to the post-compaction figure and the
timeline SHALL mark where compaction happened. Where the session reports
its own context breakdown, that breakdown SHALL be offered as the
expanded view and its total SHALL agree with the presented fill.

Window knowledge and occupancy SHALL update independently. A window-only
discovery MUST NOT replace the most recent occupancy with a promptless
estimate, zero, or another session's count. Within the applicable execution
context, the session's reported window SHALL take precedence over a
catalog-reported window, which SHALL take precedence over a known static
estimate. Retained observations SHALL be labelled cached when awaiting
revalidation. Estimates MUST NOT overwrite applicable reported windows.
The newest valid session observation SHALL replace an older session
window, including when the newer value is smaller. A model or window
variant change SHALL NOT cause the preceding model's occupancy to be
measured against the newly selected model's window.

The displayed percentage, fill, warning state, tooltip, and expanded
breakdown SHALL update when the applicable limit or its provenance
changes, even when no new usage message arrives. Connected clients SHALL
receive these updates while a turn is running. Reconnecting clients
SHALL recover the latest window knowledge together with conversation
state, without requiring another completed turn.

A readout based on an estimate SHALL visibly identify the percentage and
limit as estimated. If no limit is known, or occupancy disproves an
estimate, the readout SHALL state tokens used and explain that the limit
is unavailable, without a percentage, a bare question mark, or a full-window
alert. An explicitly reported compaction-policy boundary SHALL NOT be
discarded merely because occupancy exceeds it. Where Claude distinguishes
model capacity from a compaction boundary, the readout SHALL distinguish
those values and SHALL NOT label the latter as the model's hard capacity.

#### Scenario: A long turn does not exceed its window
- **WHEN** a turn makes many model calls, each against a window that is 30% full
- **THEN** the presented fill after the turn is about 30%, not the sum of the calls

#### Scenario: Compaction is visible and resets the fill
- **WHEN** Claude Code compacts the conversation mid-turn
- **THEN** the timeline shows a compaction marker with the before and after figures
- **AND** the presented fill reflects the post-compaction figure

#### Scenario: The expanded breakdown is the session's own
- **WHEN** the user opens the context readout on a session that reports a breakdown
- **THEN** it shows the session's categories, such as system prompt, tools, messages, and memory
- **AND** their total matches the presented fill

#### Scenario: The session's window beats the catalog's figure
- **WHEN** the catalog lists a model with a 200k estimate and the session reports a 1M window for it
- **THEN** a later call that occupies 212k tokens presents a fill of about 21%
- **AND** the readout is not in its alert state

#### Scenario: A first turn is measured against the stated window
- **WHEN** Claude Code stated a 1M window for Sonnet 5.5 when the catalog was read, and a new conversation's first turn on Sonnet 5.5 occupies 50k tokens before any session report
- **THEN** the presented fill is about 5% of 1M, not 25% of 200k

#### Scenario: A reopened conversation is measured against the stated window
- **WHEN** a Claude Code conversation on Sonnet 5.5 is reopened, its last call occupied 250k tokens, and Claude Code stated a 1M window for Sonnet 5.5 when the catalog was read
- **THEN** the readout presents a fill of about 25% against 1M
- **AND** it does not drop the fill for exceeding a 200k guess

#### Scenario: An occupancy beyond the catalog's figure is not a full window
- **WHEN** no applicable window has been reported and a call occupies more tokens than a static estimate
- **THEN** the readout states the occupancy and explains that the limit is unavailable
- **AND** it shows neither a percentage nor a full-window alert
- **AND** a later confirmed limit restores the percentage without waiting for the turn to finish

#### Scenario: A corrected limit repaints an unchanged usage message
- **WHEN** the latest usage message remains at 150k tokens and the applicable limit changes from an estimated 200k to a reported 1M
- **THEN** the percentage changes from an estimated 75% to 15%
- **AND** the fill, warning state, tooltip, breakdown, and source label agree with 1M
- **AND** no new message, model selection, or picker interaction is required

#### Scenario: A source-only change is visible
- **WHEN** a 1M estimate is confirmed as 1M with no new usage message
- **THEN** the percentage stays the same and its estimated label is removed

#### Scenario: Window discovery preserves occupancy
- **WHEN** an early window query reports a local occupancy estimate and a 1M window while the conversation already has a newer usage count
- **THEN** the readout keeps that usage count and uses the discovered window
- **AND** discovery creates no synthetic conversation message or reset to zero

#### Scenario: A fresh session answer can reduce the window
- **WHEN** the session reports a current 200k window after an earlier 1M observation and the applicable usage is 50k
- **THEN** the readout shows 25% against the newer 200k window
- **AND** an older delayed 1M answer does not reverse it

#### Scenario: A staged model change does not relabel old occupancy
- **WHEN** the last usage belongs to one model and the user selects a different model or window variant for the next prompt
- **THEN** the last usage remains measured against its own applicable window
- **AND** new usage uses the window of the execution that produced it

#### Scenario: Reconnect recovers window knowledge
- **WHEN** the browser disconnects before a corrected window arrives and reconnects while the turn is still running
- **THEN** its recovered conversation state includes the latest applicable window and source
- **AND** its readout agrees with a browser that remained connected

#### Scenario: A reported compaction boundary is not an invalid estimate
- **WHEN** Claude explicitly distinguishes a 200k compaction boundary from a 1M model capacity and reports usage above the compaction boundary
- **THEN** the readout labels the compaction boundary separately from model capacity
- **AND** it does not discard that reported boundary using the rule for disproven estimates
