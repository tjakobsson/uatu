## 1. Phase 1 — Context meter measures the window (D1)

- [x] 1.1 Stop emitting the `result` usage as a `usage:` carrier in `normalizeClaudeMessage`; emit one carrier per live `assistant` message instead, and verify a normalization test with a five-call turn at 30k occupancy yields a latest carrier of ~30k, not 150k
- [x] 1.2 Add a `context_report` update (total, max, model, categories) to the provider seam and types, emitted from `getContextUsage()` after each turn result and from `compact_boundary` `post_tokens`; verify provider tests with a stubbed query see one report per turn and validation accepts the new shape
- [x] 1.3 Make the meter prefer the newest `context_report` when present and fall back to the latest assistant carrier, showing report categories, and save `screenshots/phase1-meter-and-breakdown.png` in the expanded breakdown; verify a ui test where a report of 300k/1M paints 30% and the breakdown lists the categories
- [x] 1.4 Add a `compaction` timeline item kind and its renderer row with pre/post figures; verify a renderer test and a fixture-driven e2e that a compaction marker appears between two activity runs and the meter drops after it, saved as `screenshots/phase1-compaction-marker.png`

## 2. Phase 1 — Models are named with versions and the app-only set is offered (D2, D3)

- [x] 2.1 Derive versioned names in `modelsFromCatalog` from `description`/`resolvedModel` when `displayName` has no digit, preserving the 1M marker; verify a provider test with the probed 2026-09-02 catalog yields "Opus 5 (1M context)", "Fable 5.1", "Sonnet 5", "Haiku 4.5", and save `screenshots/phase1-picker-versioned-names.png` plus `phase1-composer-model-button.png`
- [x] 2.2 Add the "More models" manifest (Fable 5, Opus 4.8, 4.7, 4.6, Sonnet 4.6 with windows and effort tiers) appended to live and fallback catalogs under a distinct group; verify a models test that the group sits after the catalog rows and never shadows a catalog id
- [x] 2.3 Add a typed-model-id row to the configuration picker that submits a verbatim id with no `contextLimit`; verify a picker unit test and a fixture-driven e2e that the typed id reaches the conversation configuration and the meter shows "?" for its limit, saved as `screenshots/phase1-more-models-and-typed-id.png`
- [x] 2.4 Surface a CLI model rejection as the turn's failed status with the reported message; verify a provider test where the stubbed query fails on an unknown model and the conversation shows the error

## 3. Phase 1 — Activity rows and permission copy (D4, D5)

- [x] 3.1 Add a `bash` case to `describeToolDetail` with the command as subject, description as meta, and a background-launch flag from `run_in_background`; verify tool-detail tests for single-line, multi-line, and background commands
- [x] 3.2 Extend `groupSummary` to name up to three subjects before falling back to counts; verify a renderer test that a finished run of Bash rows reads their commands and a fixture e2e screenshot shows the collapsed line, saved as `screenshots/phase1-bash-rows-with-commands.png` and `phase1-live-tail.png`
- [x] 3.3 Move the persistent-approval scope sentence onto the agent descriptor, keep OpenCode's verified sentence, and write Claude Code's from the actual `brokerToolUse` semantics; verify a renderer test per agent and the chat-agents e2e that a Claude card never contains "OpenCode", with `screenshots/phase1-permission-card-claude.png`

## 4. Phase 1 — Dialogs and elicitations (D6)

- [x] 4.1 Register `onElicitation` and a `request_user_dialog` handler in the provider that emit `question` items tagged with source and raw schema, resolve through the existing interaction registry, and abandon on session end; verify provider tests for answer, decline, and dead-session paths
- [x] 4.2 Render dialog and elicitation questions in the question form, choices for known kinds and a schema form otherwise; verify question-form tests and a fixture e2e that a dialog card is answered and the turn continues, saved as `screenshots/phase1-dialog-card.png`
- [x] 4.3 Phase 1 acceptance: run `bun test` and the chat e2e files, then a real Haiku turn in a scratch workspace confirming the meter stays under the window, Bash rows show commands, and the model button names a version; record the screenshots under the change's `screenshots/`

## 5. Phase 2 — Session lifetime and the background set (D7)

- [x] 5.1 Spike D9: with a scripted SDK session, background a `sleep 5 && echo done` and record whether the CLI starts a follow-up turn on its own or only queues the notification; verify by committing the script output to the change's `screenshots/` folder and updating design.md D9 with the answer
- [x] 5.2 Track `background_tasks_changed` (excluding ambient ids) and `session_state_changed` on `LiveSession`, and retire a session only when no pending turn, an empty set, and idle all hold; verify provider tests that a result with live tasks keeps the session and an emptied set retires it
- [x] 5.3 Emit a conversation-level `background` working state while the set is non-empty and teach the adapter's live-turn tracking and the composer status region the new state; verify adapter and ui tests that the composer names the running count and still accepts a prompt, saved as `screenshots/phase2-background-state-composer.png`
- [x] 5.4 Add the `"background-tasks"` capability to the declaration and validation, declared by Claude Code only; verify the capabilities test and that OpenCode's declaration is unchanged

## 6. Phase 2 — Task rows, stop, and wake-up (D8, D9)

- [x] 6.1 Add the `background_task` item kind and normalize `task_started`, `task_progress`, `task_updated`, and `task_notification` into in-place upserts linked to the launching `tool_use_id`; verify normalization tests covering start, progress, completion, failure, stop, and ambient exclusion
- [x] 6.2 Render running tasks as the composer list with a stop action and settled tasks as timeline rows with outcome and summary, populated on reopen from the provider's `backgroundTasks()` snapshot; verify renderer tests and a fixture e2e that lists, stops, and settles a task, saved as `screenshots/phase2-task-list-stop.png` and `phase2-settled-task-row.png`
- [x] 6.3 Add the `stopTask` chat API action routed to the provider's `stopTask(taskId)`; verify a routes test and a provider test that a stop yields a `stopped` row
- [x] 6.4 Implement the wake-up path chosen in 5.1 (CLI-driven observation or the hidden synthetic envelope) so a settled non-ambient task with no pending turn produces a follow-up assistant turn; verify a provider test with a stubbed query and a real-model run in a scratch workspace where "sleep 20 && echo done" backgrounded yields an unprompted follow-up, saved as `screenshots/phase2-wakeup-follow-up-turn.png`
- [x] 6.5 Normalize `tool_progress` heartbeats into an elapsed-time field on running tool rows and render it in place; verify normalization and renderer tests and that reasoning rows are unaffected

## 7. Phase 3 — Streaming and status signals (D10, D11)

- [ ] 7.1 Enable `includePartialMessages` and fold `content_block_delta` text into the current assistant message through the existing coalescer path, with the completed message overwriting streamed text; verify normalization tests and a fixture e2e that text grows in place and the final text matches, with a mid-stream `screenshots/phase3-streaming-text.png`
- [ ] 7.2 Map `api_retry` and compacting `status` onto named composer states and `rate_limit_event` onto a warning item plus a badge while rejected; verify ui tests for each state, reduced-motion behaviour, and accessible names, saved as `screenshots/phase3-status-retrying-compacting-ratelimit.png`
- [ ] 7.3 Handle `model_refusal_fallback` by swapping remembered model attribution and emitting a warning naming both models; verify a normalization test that later usage is attributed to the fallback
- [ ] 7.4 Render `memory_recall` as a "Recalled from memory" activity row; verify a renderer test and the row collapses into groups like reasoning, saved as `screenshots/phase3-memory-recall-row.png`
- [ ] 7.5 Show plan utilization from the SDK usage request beside the meter when the login reports limits, absent otherwise; verify a ui test for both cases and that API-key sessions show nothing, saved as `screenshots/phase3-plan-utilization.png`

## 8. Phase 3 — Titles and closing verification (D12)

- [ ] 8.1 Read the last `ai-title` entry in the transcript reader and handle live `rename_session`, keeping a UatuCode user rename authoritative; verify transcript and provider tests for generated title, no title, and user-rename precedence, saved as `screenshots/phase3-generated-title-in-chooser.png`
- [ ] 8.2 Sync the `claude-code-chat` and `opencode-chat` delta specs' new scenarios into the e2e fixture driver so every ADDED scenario has a fixture-driven test; verify `bun test:e2e` passes with the new files
- [ ] 8.3 Final acceptance on a real model: rerun the 2026-09-02 audit prompt (hello.sh, ls, read, backgrounded sleep, date) on Haiku and confirm meter, names, Bash subjects, background chip, settled row, follow-up turn, streaming, and title; store screenshots under `screenshots/` as `final-*` at desktop and phone widths and update ARCHITECTURE.md's chat section for the new item kinds and session lifetime
