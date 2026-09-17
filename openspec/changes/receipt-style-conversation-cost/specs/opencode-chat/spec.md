## MODIFIED Requirements

### Requirement: Chat reports what an OpenCode conversation has cost
Where OpenCode reports a cost for an assistant message, Chat SHALL present the conversation's accumulated cost in the same place a Claude Code conversation's session totals appear: the composer's usage chip reads the conversation's cost when the agent reports no plan windows, and the usage readout's conversation block states the total. The figure SHALL be the sum of the cost OpenCode reported per assistant message, in the currency OpenCode reports it, across the conversation and every subagent session beneath it at any depth. Each message SHALL be counted once — however many times it was restated while it streamed, and however many tasks the subagent that produced it was given.

The cost SHALL be populated when an existing conversation is opened, from its stored history, not only after a new turn is taken; it SHALL NOT be qualified as "since" a later time, because the stored history carries every message's cost. When every message in the conversation reports a cost of zero — a model OpenCode has no price for — Chat SHALL show no cost rather than a zero figure. A message for which OpenCode reports no cost contributes nothing and SHALL NOT be presented as zero.

The conversation block SHALL read as a receipt: line items, each with its tokens and cost, closed by a total line, where the line items' costs sum to the stated total. It SHALL offer three itemizations of that same total — by agent, by agent type, and by model — through one control that shows one itemization at a time. Switching itemization SHALL NOT change the total, and the chosen itemization SHALL be remembered on the device across conversations and reloads.

Itemized by agent, the block SHALL list:
- the main agent under the name OpenCode gives it, identified as the main agent, with one line per name the conversation ran under; an agent OpenCode runs on the conversation's behalf to summarise it SHALL have its own line saying so; where OpenCode names no agent the line reads "This agent";
- one line per task given to a subagent — labelled by the subagent's kind and the task's description, with the model it ran — stating the tokens and cost of that task alone: what the subagent spent answering that task, excluding any other task it was given and excluding any subagent it launched;
- a task given to a subagent that already has a line as its own line, identifying the earlier line as the same agent;
- a subagent launched by a subagent as its own line beneath its launcher's line, visibly subordinate to it, at every depth.

Itemized by agent type, the block SHALL list the main agent lines as above and one line per kind of subagent, stating how many distinct subagents of that kind worked in the conversation at any depth, with their combined tokens and cost, and stating the number of tasks where it exceeds the number of subagents. Itemized by model, the block SHALL list one line per model with the tokens and cost of every agent that ran it, naming which agents those were.

A subagent's timeline row and its row in the composer's subagent list SHALL state the same own-task cost as its receipt line, in the conversation that launched it and inside an opened subagent transcript alike. The header of an opened subagent transcript SHALL state what that subagent itself spent across every task it was given, excluding subagents it launched. A line whose session reported no cost SHALL be listed without a figure, not with zero.

#### Scenario: The chip reads the conversation's cost
- **WHEN** an OpenCode conversation has exchanged turns and OpenCode reported a cost for its assistant messages
- **THEN** the composer's usage chip reads the accumulated cost as "this conversation"
- **AND** opening the readout shows the total and the line items of the remembered itemization

#### Scenario: A restated message is counted once
- **WHEN** OpenCode restates one assistant message's cumulative cost several times while it streams
- **THEN** the conversation total counts that message's latest figure once

#### Scenario: Cost is restored from history
- **WHEN** the user opens an OpenCode conversation whose assistant messages carry costs
- **THEN** the chip and readout show the cost from that history before any new turn
- **AND** the readout block is titled for the whole conversation, not "since" a time

#### Scenario: A free model shows no cost
- **WHEN** every assistant message in the conversation reports a cost of zero
- **THEN** no cost figure is shown on the chip or in the readout

#### Scenario: The readout attributes cost per agent
- **WHEN** a conversation launched two subagents whose child sessions reported cost, on the same model as the main agent
- **THEN** itemized by agent, the conversation block lists the main agent's own spend and one line per subagent task with its label, model, tokens, and cost
- **AND** the chip's figure and the model line for that model include the subagents' spend

#### Scenario: The receipt adds up
- **WHEN** a priced conversation ran a main agent, several subagents, a subagent given two tasks, and a subagent that launched its own subagent
- **THEN** in each of the three itemizations the line items' costs sum to the total line
- **AND** the total line, the block's stated total, and the chip state the same figure
- **AND** that figure equals the sum of the costs OpenCode reported for every assistant message in the conversation and the subagent sessions beneath it

#### Scenario: A subagent given a second task is billed once
- **WHEN** the main agent gives a subagent a task, and after it finishes gives the same subagent a further task
- **THEN** the receipt lists two lines for that subagent, each stating only the spend of its own task
- **AND** the second line identifies the first as the same agent
- **AND** the two lines together equal what that subagent's session reported, and the total counts it once
- **AND** this holds while the second task streams and after the conversation is reopened

#### Scenario: Work between two tasks belongs to the task before it
- **WHEN** a subagent given two tasks summarised its own conversation partway through the first, so that its session holds prompts that are not tasks
- **THEN** the first task's line includes what the subagent spent summarising and continuing
- **AND** the second task's line states only what the subagent spent answering the second task

#### Scenario: Nested subagents are listed beneath their launcher
- **WHEN** a subagent launched a subagent, which launched a further subagent
- **THEN** each has its own line beneath its launcher's line, visibly subordinate to it
- **AND** the launcher's line states only the launcher's own spend

#### Scenario: Main agents are named
- **WHEN** a conversation ran under one named main agent, was switched to another, and OpenCode summarised it along the way
- **THEN** the receipt lists one line per main agent name, each identified as the main agent
- **AND** the summarising agent has its own line saying what it did
- **AND** no line reads "This agent"

#### Scenario: Types count distinct subagents
- **WHEN** a conversation ran three subagents of one kind, one of them given two tasks, and two nested subagents of another kind
- **THEN** the itemization by type lists the first kind with a count of three and states four tasks
- **AND** lists the second kind with a count of two and no task count

#### Scenario: Models name who ran them
- **WHEN** the user itemizes the receipt by model
- **THEN** each model's line states the tokens and cost of every agent that ran it and names those agents

#### Scenario: The itemization choice is remembered
- **WHEN** the user chooses an itemization, opens another conversation, and reloads the page
- **THEN** the readout opens on the chosen itemization

#### Scenario: A subagent row states its cost in context
- **WHEN** a subagent's child session reported cost with its tokens
- **THEN** the subagent's timeline row and its row in the composer's subagent list state that task's own cost, equal to its receipt line
- **AND** opening the subagent's transcript shows in its header what that subagent itself spent across its tasks

#### Scenario: An unpriced subagent is listed without a figure
- **WHEN** a subagent's child session reported tokens but no cost
- **THEN** its line in the conversation block names it and its tokens and asserts no cost

#### Scenario: Cost rides the usage wire
- **WHEN** a client validates a conversation snapshot or update carrying a usage record with a cost, a subagent row carrying the lines beneath it, or a usage record naming the agent that produced it
- **THEN** the record is accepted under the workspace API revision that introduced it

### Requirement: Chat reports context usage and subagent cost
Where the agent declares the context capability, Chat SHALL report how full the conversation's context window is, against the selected model's limit, and SHALL attribute each subagent with the model it ran and the tokens it consumed. Each SHALL be gated on that declared capability: undeclared, the readout or figure is absent rather than empty, and its absence SHALL NOT degrade the rest.

The context report SHALL be legible without the user opening anything, and MAY expand to the breakdown the agent reports — input, cache, and output, or the agent's own categories when it reports them. It reports the live window fill after the latest model call, not lifetime spend and not a sum over a turn, and SHALL be populated when an existing conversation is opened, not only after a new turn is taken. When the agent reports that it compacted the conversation, the fill SHALL follow the post-compaction figure. Where the agent reports plan utilization, the readout MAY present it alongside the fill, distinct from it.

A subagent's attribution SHALL reflect the subagent's own session — a subagent may run a different model from its parent — and SHALL state the tokens that subagent consumed for the task the row represents, taken from its child session onto the launching conversation. Where the agent gives one subagent several tasks, each task's row SHALL state that task's tokens alone, and tokens consumed by subagents the subagent launched SHALL NOT be added to its row. The model MAY be shown before any usage is known. When the agent has not reported usage for a subagent, the row SHALL stay readable and SHALL NOT assert a figure it does not have.

#### Scenario: The context indicator reads without being opened
- **WHEN** a conversation has exchanged turns and the agent declares context reporting
- **THEN** the surface shows how full the context window is against the model's limit
- **AND** the fill is legible without expanding anything

#### Scenario: The fill never exceeds the window from a long turn
- **WHEN** a turn made many model calls against a partly full window
- **THEN** the presented fill is that of the latest call
- **AND** it is not the calls summed

#### Scenario: The indicator is populated on opening an existing conversation
- **WHEN** the user opens a conversation that already has assistant turns
- **THEN** the context fill is shown from that history, before any new turn

#### Scenario: The context breakdown expands
- **WHEN** the user opens the context indicator
- **THEN** it shows the input, cache, and output the agent reported, or the agent's own categories when reported

#### Scenario: A subagent row names its model and tokens
- **WHEN** a subagent has run and the agent reports its model and token counts
- **THEN** its row states which model it ran and how many tokens it consumed

#### Scenario: A subagent's second task states its own tokens
- **WHEN** a subagent that finished one task is given a further task
- **THEN** the second task's row states the tokens of the second task alone
- **AND** the first task's row is unchanged by it

#### Scenario: A subagent without reported usage stays readable
- **WHEN** a subagent has not yet reported usage, or the agent does not report it
- **THEN** the row still names the subagent and its status
- **AND** no token figure is asserted for it

#### Scenario: An undeclared context capability leaves nothing behind
- **WHEN** the agent does not declare the context capability
- **THEN** the context indicator and the subagent token figure are absent
- **AND** the capabilities the agent does declare are unaffected

## ADDED Requirements

### Requirement: The composer's subagent list counts subagents and tasks distinctly
The composer's subagent list SHALL keep one row per task, and its summary line SHALL NOT count a subagent once per task it was given. Where every task went to its own subagent the summary SHALL count subagents as it does today. Where a subagent was given more than one task, the summary SHALL state the number of distinct subagents and the number of tasks.

#### Scenario: One task per subagent reads as before
- **WHEN** a conversation launched four subagents with one task each and all have finished
- **THEN** the summary reads "4 subagents finished"

#### Scenario: A subagent given two tasks is one subagent
- **WHEN** a conversation launched three subagents, gave one of them a second task, and all have finished
- **THEN** the list shows four rows
- **AND** the summary reads "3 subagents · 4 tasks finished"
