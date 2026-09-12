## 1. Read authorship from the store

- [x] 1.1 Carry `origin.kind` and `isMeta` on transcript entries; parse a stored `<task-notification>` envelope (and only the generated envelope) to its fields; exclude harness-authored records from prompt text.

## 2. Replay the notification as the task row

- [x] 2.1 On stored replay, route a task notification into the background-task path as the frame the live stream would carry, naming the row from the launching tool's `description`; ignore `isMeta` records; keep quoted markup as the person's bubble.

## 3. Verify in the app

- [x] 3.1 Reopen a fixture conversation in touch and desktop mode and capture before/after screenshots.
