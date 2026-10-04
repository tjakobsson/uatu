## Why

An OpenCode turn that edits files never collapses into an activity group. OpenCode reports every touched file as a `file_change` row ("update src/foo.ts") — one per path on each assistant message's snapshot, and one per `outputPaths` entry on a tool — so a working turn arrives as `read · edit · update foo.ts · read · edit · update bar.ts …`. The timeline groups only tool, command, reasoning, and background-task rows; a file-change row ends the run. Every run between two file rows is shorter than the three-step minimum, so a finished edit turn renders as a flat ladder of rows, and while the turn runs the earlier steps fall out of the working line as flat rows instead of staying behind it. Claude Code never emits file-change rows, which is why only OpenCode conversations show this.

The spec already treats file changes as subordinate activity and expects a file row to name its path "so a row and any group summary it joins are legible". The code falls short of that; this change closes the gap and says so in the spec, so the grouping rule names its members.

## What Changes

- A file-change row is an activity step for grouping: a run of tool, command, reasoning, background-task, and file-change rows collapses behind one group line, and the live tail of a running turn keeps file-change rows inside the working line.
- A file-change row has no running or failed state. It counts as finished for the finished-run rule and never as a failed step on the group line.
- A group summary names file-change rows by their operation and path ("Updated src/foo.ts", "Created …", "Deleted …"). File rows are counted, not named, in the summary's named slots: an "Updated foo.ts" right after "Edit foo.ts" would name the same file twice, so the slots go to the tools and the file rows follow as "Updated ×2".
- The working line's step in flight is never a file-change row: between steps it names the last tool, command, or reasoning step, since a file row describes what a step did rather than being a step.
- A file-change row states its operation in the same word the group summary uses — "Updated", "Created", "Deleted" — instead of the raw operation name ("update"). This is the one change to the row itself, inside a group and as a flat row; a row that says "update" under a line that says "Updated ×2" disagrees with its own summary.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: "Chat presents turns as readable conversation with inspectable activity" gains the rule that file-change rows are members of activity groups and the working line, with scenarios for a finished run split only by file rows, the live tail, and the group summary's naming of file rows.

## Impact

- `src/chat/timeline-renderer.ts`: `ActivityItem`/`isActivity` admit `file_change`; `flushRun` and `describeGroup` treat a file row as finished and clean; `stepName`, `groupSummary`, and `currentStep` learn the file row's label and subject; the row's own markup uses that label.
- `src/chat/timeline-renderer.test.ts`: grouping tests for a run split by file rows, the live tail with a file row, and the summary wording.
- `src/styles.css`: the `.chat-file-change` row inside `.chat-group-items` reads like its sibling step rows.
- No wire, API, or normalization change: OpenCode 1.x and 2.x keep emitting the same `file_change` items; only the timeline's reading of them changes. Claude Code is unaffected.
