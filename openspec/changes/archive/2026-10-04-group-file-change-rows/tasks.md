## 1. Grouping rule

- [x] 1.1 Add `file_change` to `ActivityItem` and `isActivity()` in `src/chat/timeline-renderer.ts`; make `flushRun`'s finished check and `describeGroup`'s failed count read `status` only on members that carry one, so a file row is finished and clean. Verify with a renderer test: `[user, tool, file_change, tool, tool, answer]` at `idle` renders `["message:u1", "group:tool:a", "part:a1"]` with the count "4 steps" and four member rows.
- [x] 1.2 Keep the live tail together: verify with a test that `[user, tool(completed), file_change, tool(running)]` at `running` renders one `group:tool:a` working line, no flat rows, and its subject names the running tool.
- [x] 1.3 A lone file row still renders flat: verify with a test that `[user, answer, file_change, answer]` shows the `chat-file-change` article at the top level and no `.chat-activity-group`.

## 2. Naming

- [x] 2.1 Teach `stepName()` the file row: label "Created"/"Updated"/"Deleted" from `operation`, subject the path. Make `groupSummary()` send file rows to the counted tail instead of the named slots. Verify with a test that a finished group of `Edit foo.ts`, `file_change update foo.ts`, `Edit bar.ts`, `file_change update bar.ts`, `Read baz.ts` reads "Edit foo.ts · Edit bar.ts · Read baz.ts · Updated ×2", and a group of three file rows reads "Updated ×3".
- [x] 2.2 Make `currentStep()` prefer the last running or pending member, then the last non-file member, then the last member. Verify with a test that a live tail ending in a file row after a completed `Edit` names the `Edit`, and a live tail of only file rows names the file row.

- [x] 2.3 Make the row's own markup print the `FILE_CHANGE_LABELS` word ("Updated") instead of the raw operation, inside a group and flat. Verify with a renderer test that a flat `file_change` update row's text starts with "Updated" and the group member row reads the same.

## 3. Presentation

- [x] 3.1 Check the `.chat-file-change` row inside `.chat-group-items` against the sibling tool rows (inset, font size, hover) and add a `.chat-group-items .chat-file-change` rule in `src/styles.css` only if it is misaligned. Verify by opening a grouped OpenCode edit turn in the dev hub (`bun run dev`, an OpenCode conversation that edits two files) and saving a screenshot of the collapsed group line and the opened group to `openspec/changes/group-file-change-rows/screenshots/`.
