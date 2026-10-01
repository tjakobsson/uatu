## MODIFIED Requirements

### Requirement: Models and effort levels follow Claude Code's catalog
The Claude Code agent SHALL list the models Claude Code offers and SHALL
offer each model's supported effort levels as that model's reasoning
variants. Claude Code's own recommended default SHALL be offered as a
first-class entry presented as the active choice while no model has been
chosen — in place of a generic delegation row — and choosing it SHALL
leave the model resolution to Claude Code. Every surface that names a
model SHALL name it with its version (for example "Opus 5 (1M context)",
"Fable 5.1"), derived from the catalog when the catalog's display name
lacks one. In addition to the catalog, the agent SHALL offer the models
the Claude apps offer under "More models" that the catalog omits, and
SHALL accept a user-typed model id, each presented as distinct from the
catalog's own entries; a rejected id SHALL fail the turn with the CLI's
error, not silently fall back. A model or variant selection SHALL apply to
the conversation's subsequent prompts, an effort level not supported by
the selected model MUST NOT be selectable with it, and the model's
context-window size SHALL be reported when known so context usage can be
presented. The catalog SHALL be read from Claude Code itself before the
first conversation runs when the install permits it, with a static
fallback only for an install that cannot answer, and model ids reported by
a running session SHALL be attributed to catalog entries so context usage
joins the window actually in effect.

Each offered model's context window — the catalog's rows, the "More
models" rows, and the recommended default — SHALL be the window Claude
Code itself states for that model on this install and login, read from
Claude Code when the catalog is first read, before any turn needs it.
Reading the windows MUST NOT delay the catalog: each stated window SHALL
be presented from the first catalog read after Claude Code has stated it.
Reading these windows SHALL NOT spend tokens or make a model call, and
MUST NOT change the model of any conversation. A window derived from the
model's id, or kept in a static list, SHALL be presented only for a model
Claude Code has not stated a window for, including while the windows are
still being read. A stated window SHALL remain in force for the
life of the agent session, including after a conversation starts and the
catalog is refreshed from it.

The recommended default SHALL be presented as the model it actually runs
in the workspace — the model Claude Code puts in effect for a session that
pins none, after the user's, project, environment, and managed settings
are applied — and not as the catalog's account-level resolution when the
two differ. The model it runs SHALL determine the default entry's stated
resolution, its name on every surface, its description, its effort
levels, and its context window. A model the default runs that no offered
entry represents SHALL be named by its id. The default's resolution SHALL
be learned before any turn and SHALL remain in force across a catalog
refresh, as stated windows do; the catalog's own resolution is the
fallback only when Claude Code cannot report what the default runs.

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
- **AND** the context window presented is the one that model actually has

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
- **AND** an effort level the model does not support is not offered alongside it

#### Scenario: A model's window is the one Claude Code states, before any turn
- **WHEN** the model picker is read on a healthy install whose catalog offers Sonnet 5.5 under an id with no window marker, after Claude Code has stated a 1M window for it
- **THEN** Sonnet 5.5 is offered with a 1M context window, though no conversation has run
- **AND** no tokens are spent and no model call is made to learn it

#### Scenario: Reading windows does not delay the catalog
- **WHEN** the model picker is first read and Claude Code takes seconds to state every model's window
- **THEN** the catalog and the default's actual model are presented without waiting for the windows
- **AND** a model whose window has not been stated yet is presented with its derived figure until a later read

#### Scenario: Settings that override the account default are what the default names
- **WHEN** the catalog's default row resolves to Sonnet 5.5 and the workspace's Claude Code settings set the model to `fable[1m]`
- **THEN** before any turn the default is presented as "Default · Fable 5.1", resolving to the Fable 5.1 entry
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
- **WHEN** the default's actual model has been learned and a conversation then starts and refreshes the catalog
- **THEN** the default is still presented as the model it actually runs

#### Scenario: Without a report the catalog's resolution stands
- **WHEN** Claude Code cannot report what the default runs
- **THEN** the default is presented by the catalog's own resolution, as before

#### Scenario: Reading windows leaves running conversations alone
- **WHEN** the catalog and its windows are read while a Claude Code conversation is running under a chosen model
- **THEN** that conversation's model is unchanged and its next prompt runs under the model it had

#### Scenario: A stated window outlives a catalog refresh
- **WHEN** a model's window has been stated and a conversation then starts and refreshes the catalog
- **THEN** the model is still offered with its stated window, not an id-derived figure

#### Scenario: A model with no stated window falls back to the derived figure
- **WHEN** Claude Code cannot state a window for a model — the install cannot answer, the read for that model fails, or the id was typed by the user
- **THEN** the model is offered with the window derived from its id or the static list
- **AND** the catalog itself is still offered

### Requirement: Context usage measures the window, not the turn's spend
Context usage for a Claude Code conversation SHALL be the occupancy of the
context window after the most recent model call — the tokens that call
sent as input, read from cache, and wrote to cache — and MUST NOT be a
figure summed across the calls of a turn. When Claude Code compacts the
conversation, the reported occupancy SHALL drop to the post-compaction
figure and the timeline SHALL mark where compaction happened. Where the
session can report its own context breakdown, that breakdown SHALL be
offered as the expanded view and its total SHALL agree with the presented
fill. The window the fill is measured against SHALL be the one the session
itself reports for the model once it has reported one; before that —
during a conversation's first turn, and for a reopened conversation — it
SHALL be the window Claude Code stated for the model when the catalog was
read, and only for a model with no stated window the catalog's derived
figure. A derived figure that the observed occupancy exceeds SHALL NOT be
presented as a full window: the readout SHALL state the occupancy without
a fill until the session reports its window.

#### Scenario: A long turn does not exceed its window
- **WHEN** a turn makes many model calls, each against a window that is 30% full
- **THEN** the presented fill after the turn is about 30%, not the sum of the calls

#### Scenario: Compaction is visible and resets the fill
- **WHEN** Claude Code compacts the conversation mid-turn
- **THEN** the timeline shows a compaction marker with the before and after figures
- **AND** the presented fill reflects the post-compaction figure

#### Scenario: The expanded breakdown is the session's own
- **WHEN** the user opens the context readout on a session that reports a breakdown
- **THEN** it shows the session's categories (system prompt, tools, messages, memory, and so on)
- **AND** their total matches the presented fill

#### Scenario: The session's window beats the catalog's figure
- **WHEN** the catalog lists a model with a 200k window and the session reports a 1M window for it
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
- **WHEN** no window has been stated or reported for the model and a call occupies more tokens than the catalog's derived figure
- **THEN** the readout states the occupancy without a percentage
- **AND** it is not in its alert state
