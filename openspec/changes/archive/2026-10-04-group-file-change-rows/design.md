## Context

See proposal.md — Why. The grouping rule lives in one place, `activitySegments()` in `src/chat/timeline-renderer.ts`: it walks the projection, gathers consecutive `ActivityItem`s (`tool | command | reasoning | background_task`) into a run, and flushes the run as a group when it is the live tail or when it has at least `GROUP_MIN` (3) finished members. Any other item type flushes the run flat. `describeGroup()` counts failed members by `item.status`; `stepName()` gives a member its label and subject for `groupSummary()` (the finished line) and `currentStep()` (the working line).

`file_change` items carry `path` and `operation: "create" | "update" | "delete"`, no `status`, and render as `<article class="chat-file-change">` with the raw operation word and a path button. OpenCode 1.x and 2.x mint them from a message's `snapshot.files` and a tool's `outputPaths`; Claude Code mints none.

## Goals / Non-Goals

**Goals:**
- Make a file-change row a group member without changing what it says as a flat row.
- Keep every existing grouping rule (GROUP_MIN, finished-run, live tail, awaiting line) exactly as it is for the four current activity types.

**Non-Goals:**
- Suppressing or merging file-change rows with the tool step that produced them. They stay visible rows inside the group.
- Changing OpenCode normalization, item ids, or the wire contract.
- A new look for the file-change row as a flat row (its word changes; its card does not).

## Decisions

**Admit `file_change` to `ActivityItem`, nothing else.** The alternative — filtering file rows out before grouping, the way empty usage carriers are filtered — would hide them from the timeline, and the spec requires file changes to be inspectable activity. Widening the type is the one-line version of the fix; everything else follows from the compiler pointing at `status` reads that no longer type-check.

**A file row is finished and clean.** It has no `status`; the finished check in `flushRun` and the failed count in `describeGroup` read `status` only on members that have one. A file row is a report of what a step did, so it cannot be running or failed. Alternative: give `FileChangeItem` a synthetic `status: "completed"` in normalization — rejected, it touches both OpenCode generations and the wire contract for a renderer-only concern.

**`stepName()` for a file row: label from the operation, subject the path.** `create → "Created"`, `update → "Updated"`, `delete → "Deleted"`. The label is the past-tense word the row would want anyway; the subject goes through `workspaceRelative()` like a tool's path.

**Counted, not named, in `groupSummary()`.** The summary names the first `GROUP_NAMED` (3) steps that have a subject. A file row's subject is usually the path the previous `Edit`/`Write` step already named; letting it take a named slot spends a slot on a repeat ("Edit foo.ts · Updated foo.ts · Read bar.ts") and pushes the next tool into the counted tail. File rows therefore skip the named slots and go to the counted tail: "Edit foo.ts · Edit bar.ts · Read baz.ts · Updated ×2". A group of only file rows reads "Updated ×3", which is honest. Alternative considered and rejected per the proposal: file rows take named slots like any subject-bearing step.

**`currentStep()` skips file rows.** The working line names the last running or pending member, else the last member. A file row is never running, and when it is the last member the line would read "Updated foo.ts" as though that were the step in flight. It picks the last running/pending member, else the last non-file member, else (a tail of only file rows) the last file row.

**The row says the summary's word.** The row's markup printed the raw operation (`update`); the summary says `Updated ×2`. One table, `FILE_CHANGE_LABELS`, feeds both, so the row and the line cannot drift. This touches the flat row too — a deliberate exception to "no new look for the row": wording, not look, and the raw operation was never a sentence.

**Styling.** `.chat-file-change` is a `chat-item` article; inside `.chat-group-items` it sits among `details.chat-activity` rows. Checked in the dev hub on OpenCode 2.x: as a member it kept its card — border, raised background, prose font — among quiet one-liners, so a `.chat-group-items .chat-file-change` rule lays it out as a step row (label, mono path, same size, touch variant). The flat row keeps its card.

## Risks / Trade-offs

- [A run of only file rows at the tail of a running turn] → the working line says "Updated foo.ts" with the live dot. Accurate (the file was updated, work continues), and OpenCode follows a snapshot with the next step within the same stream, so the state is brief.
- [Group ids are keyed by the first member's id] → a run that now starts with a file row (`file:…`) gets a `group:file:…` id instead of `group:tool:…`. Reader-expanded state is keyed by that id and only within a session, so nothing persisted changes meaning.
- [Finished runs that were flat become grouped on reload of old OpenCode conversations] → intended; that is the fix.
