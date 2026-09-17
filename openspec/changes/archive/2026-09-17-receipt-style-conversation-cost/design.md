## Context

See proposal.md for motivation and `screenshots/` for the real-case evidence. The constraints that shape the approach:

- The client holds one conversation's projection and can never read a child session's. Whatever the receipt shows about subagents must be materialized by the adapter onto items in the launching conversation — today `model` and `usage` on the `task` tool item.
- The adapter keys child attribution by `(parent session, child session)` and rolls descendants up under synthetic `agent:<id>` entries (`propagateInclusive`, `reconstructAttributionRead`). Both the reuse double-billing and the unlabelled nesting come from that key: the UI's unit is the launcher row, the tally's unit is the session.
- OpenCode continues an existing subagent when `task` is called with `task_id`: two tool rows, one `childConversationId`. Verified against a real run: the child session then holds one user message per task, and every assistant message names the user message it answers (`parentID`).
- OpenCode nests subagents only when `subagent_depth` is raised above its default of 1. Nesting is rare but real, and the store already links each level by `parent_id`.
- Assistant messages carry the producing agent's name (`agent`: `build`, `plan`, `compaction`, `general`, …). uatu's usage carriers do not keep it.
- Tool items and usage carriers are closed wire objects (`validation.ts`, `api/openapi.yaml`): a new field or a changed meaning is a workspace-revision break.
- Claude Code reports its own session totals, per model, on the context report; `resolveSessionTotals` prefers that report. It has no per-agent data.

## Goals / Non-Goals

**Goals:**
- One attribution unit end to end: the task (launcher row). Receipt line, timeline row and composer list row state the same figure from the same source.
- Every assistant message counted exactly once in the total, live and after reopen, with no server-side ledger — still rebuilt from the child's stored history.
- Nested lines reach the top-level receipt without the client opening child conversations.

**Non-Goals:**
- Claude Code's readout. It keeps today's per-model block; the itemization control appears only where a conversation's cost is itemizable per agent.
- The sidebar Usage pane (per-login plan windows; it has no conversation block).
- Showing nested subagents in the composer's subagent list or the timeline of the top-level conversation. They appear on the receipt and inside their launcher's transcript.
- Per-task duration, or any cost estimate where OpenCode reported none.

## Decisions

### 1. A task's spend is the replies to that task's prompt
Within a child session, assistant messages are grouped by the user message they answer (`parentID`), and each group is paired with one of the launching conversation's `task` rows for that child. A user message opens the next row only when it IS that task's prompt — its text equals the `prompt` the row's input gave; every other user message belongs to the task before it. A row's usage is the sum over the groups paired with it.

- *Why not timestamps* (row start → next row start): parallel launches and clock granularity make boundaries ambiguous, and a revert rewrites history under them. `parentID` is structural.
- *Why not one line per session* (merge the tasks): the composer list and the timeline already show one row per task; a merged receipt line would match neither (decided with the user).
- *Why not position* (k-th prompt ↔ k-th row), which the first implementation used: a child session holds more user messages than tasks. Every time a long-running subagent summarises itself OpenCode adds two — a compaction request with no text and a synthetic "Continue if you have next steps…" — so position hands the compaction, and everything after it, to the NEXT task. On the production store that is 7 of 58 reused subagents; one real session billed 281k tokens to a task that spent 23k. Prompt text is exact there: 148 of 148 task rows equal one user message's text as uatu normalizes it, and the 18 textless or synthetic ones are correctly not tasks.
- Groups with no matching row — the compaction pair, a prompt typed into the child from the OpenCode TUI — are attributed to the latest preceding row, so nothing is dropped from the total. A prompt whose text was never seen is taken to be a task's (its position); where nothing can be compared (an agent that reports no texts, rows that have lost their input) or no prompt matched any row, pairing falls back to position. A child with rows but no matching group yet (task just launched) has no usage, as today.
- The same pairing places a nested launcher: it hangs off the row of the task during which it was launched, not the row at its prompt's index.
- The provider seam gains the answered-prompt id on `StoredMessageAccounting` and on the live `assistantUsage` report; the adapter's per-message maps stay, and only the fold changes (group → row instead of session → row).
- Only the classic record names its prompt. The v2 flat assistant record has `agent` but no `parentID`, so where the record names none the provider pairs the message with the newest user message before it in the ordered transcript it already holds (live: the newest prompt the session was seen to receive). The producing agent's name is not needed on this seam — the adapter attributes by prompt — so it rides only the usage carrier (Decision 3).

### 2. Nested lines ride the launcher row; nothing is rolled up
`propagateInclusive` and the `agent:<id>` entries are removed. A tool item's `usage` becomes own-task spend. The top-level launcher row gains `descendants`: a flat, ordered list of the lines beneath it, each `{ id, parentId, subagent, description, conversationId, model?, usage? }` where `parentId` is the launcher row or another descendant. The adapter builds it the way reconstruction already walks grandchildren, and live events from any depth re-decorate the ancestor rows that are projected.

- *Why on the row, not a separate receipt item*: attribution already lives on the row, merges through the same upsert/replace path, and is evicted with the parent projection. A second carrier would need its own lifecycle.
- *Why flat with `parentId`*: closed-schema validation and the replace-on-shrink path stay simple; the client builds the tree.
- "Same agent as" is not sent: the client derives it from equal `conversationId` among lines.
- Inside an opened subagent transcript the same rule applies one level down, so its rows state own spend too.

### 3. Usage carriers name their agent
`AssistantMessageItem` usage carriers gain `agent?: string`, read from the message's `agent` (falling back to `mode`), live and stored. `conversationTotals` groups main-agent carriers by it; absent → "This agent". The name `compaction` is presented as the summarising agent; any other name is presented as a main agent.

### 4. The receipt is one client-side model with three projections
`conversationTotals` returns lines (`{ id, parentId?, kind: "main" | "task", agentName, label, conversationId?, model?, usage }`) plus the total; by-type and by-model are folds over those lines, so the three views cannot disagree. Distinct subagents = distinct `conversationId` per kind; tasks = lines. The markup becomes one table with a radiogroup reusing the `files-pane-filter` segment styling, a `tfoot` total, and depth-indented rows. The choice persists in `localStorage`, per device, not per conversation.

- *Alternative considered*: keep the Model table always visible and toggle only Agents/Types beneath it — rejected with the user; the callout gets tall once nesting is listed.

### 5. Wire: workspace API revision 20
`ToolItem.usage` changes meaning, `ToolItem.descendants` and the carrier's `agent` are new on closed objects. Per `api/CONVENTIONS.md`: bump `WORKSPACE_API_REVISION`, `contract.json`, `openapi.yaml` (`info.version`, `x-uatu-revisions`, schemas), and add a CHANGELOG migration section (clients summing row `usage` must now add `descendants`; rows sharing a `childConversationId` no longer repeat a figure).

## Risks / Trade-offs

- [Prompt↔row pairing drifts — a child prompted outside `task`, OpenCode's own compaction messages, or a task row whose launch failed before its prompt was stored] → pair by prompt text among the rows that named the child, attribute unmatched groups to the preceding row, fall back to position when nothing matches, and test that the rows always sum to the session. Live, a prompt's text arrives after the message itself: until it does the prompt reads as not-a-task, and the pairing corrects itself when the text lands.
- [A launcher row is removed while the subagent's messages stay — a tool part removed outside a revert, for a subagent given several tasks] → the removed task's spend moves to a surviving row for that subagent rather than leaving the receipt: the session still holds those messages and OpenCode billed them, so the total must keep them, and a reopen folds them the same way (one launcher left in the stored transcript, two prompts in the child). The cost of the rule is a line that reads as two tasks' spend under one task's label. Pairing is positional, so which prompt lost its row cannot be named; saying so would need a launcher↔prompt link carried from the provider. When the LAST launcher for a nested subagent goes there is no row left to hang its branch on, and its line and cost leave — live (`trackLaunchers`, with a tombstone that survives an in-flight stored read) and from the store alike.
- [A live reply names no prompt and the normalizer's memory of the session's prompts is empty — a restart or reconnect while a reused subagent is mid-task, with a record shape that has no `parentID`] → the adapter pairs a reply it has not already paired with the newest prompt known for that child, from the store or live; a message the store already paired keeps its pairing, so a restated earlier-task message does not move to the running task. Defensive: every one of the 63,927 assistant `message.updated` events in the production store carries `parentID`, and the only other live shape (`session.next.*`) does not feed attribution.
- [A `task_id` continuation reverts or removes messages] → the existing removal and revert-invalidation paths keep working per message; the fold is recomputed from the maps, never incrementally adjusted.
- [Reconstruction cost grows with depth] → unchanged in kind: one stored read per child, cached by the completeness mark; depth beyond 1 requires an explicit OpenCode setting.
- [Older conversations stored before OpenCode wrote `agent`/`parentID`] → absent agent falls back to "This agent"; absent `parentID` falls back to one group per session attributed to the first row, which is today's figure without the duplication.
- [Released v0.7.0 shows the duplicated token figure] → this change corrects it; release-note handling is in proposal.md Impact.

- [A stream gap after a tally is squared] → unchanged from before this change: once squared against the store, live events are trusted until an eviction re-arms the read, so a reconnect that drops events under-reports that subagent until then — direct or nested. Nested launchers make it slightly wider: their keys are only read as part of their ancestor's reconstruction, so a launcher that appears after the ancestor was squared (or is merged from live during the ancestor's first read) is never itself squared. Deferred as a follow-up: the narrow fix leaves an ancestor unmarked when a launcher merged from live has an unsquared key of its own; the general one re-squares on stream reconnect, and is the one worth designing. Nesting needs OpenCode's `subagent_depth` raised; the production store holds no nested sessions.

## Migration Plan

Ships as one change; no stored data to migrate (the receipt is rebuilt from OpenCode's history on open). A revision-19 client against a revision-20 server is caught by the existing build-identity handshake. Rollback is a revert.
