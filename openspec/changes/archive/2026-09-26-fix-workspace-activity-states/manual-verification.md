# Manual verification against a real Claude Code session

Task 6.2, 2026-09-23: first pass 21:45–22:07 local, **scenario C re-run
22:37–22:46 after its defects were fixed**. Not an e2e fake — a real Claude
Code agent, real background work, real hub. A, B and D are the first pass's
findings and still stand; C is the re-run.

## What was run

- Uatu from this worktree at `7219998` + working tree, started as
  `bun run src/cli.ts hub --config /tmp/uatu-verify/hub.json` on port 4791
  (`bun run dev`'s 4702 was held by a dev hub from the main checkout; the
  throwaway config is `dev/hub.json`'s shape, user `dev`/`dev`, state under
  `/tmp/uatu-verify/state`).
- Two workspaces: `watch-docs` (= `testdata/watch-docs`, "A") and `uatu-ws-b`
  (= a scratch git repo at `/private/tmp/uatu-ws-b`, "B").
- Agent: Claude Code, `@anthropic-ai/claude-agent-sdk` 0.3.261 (bundled CLI
  2.1.261). Model **Haiku 4.5** throughout. Auth from the local Claude Code
  login worked in both passes; no auth problems.
- Driver: throwaway Playwright 1.63.0 / Bun 1.4.2 scripts in `/tmp/uatu-verify/`
  (`lib.ts` + `phase*.ts`; the re-run adds `recheck-lib.ts` and
  `recheck{1..5}.ts`, screenshots `recheck-*.png`); headless Chromium, real
  clicks. Permission cards were answered by clicking `Allow once` /
  `Allow always`.
- Re-run note: sessions do not survive a hub restart — each workspace needed
  `POST /api/hub/sessions/<id>/start` first (a bare page load answers 503).

## A — a backgrounded shell command is listed mid-turn; the composer keeps working

**Verified.** Prompt: the `for i in 1..10; do echo tick-$i; sleep 3; done`
background command from the spike.

- 6 s in, with the turn still `working`, `#chat-background-tasks` was unhidden
  (label `1 background task running · for i in 1 2 … done`), one
  `li[data-background-task="bik3yid6n"]` with a
  `button.chat-background-task-inspect[data-inspect-view="output"]` and
  `[data-stop-task]`; `#chat-input` was not disabled. (`A1-task-listed.png`)
- With the turn over (agent answered `STARTED`) and only the command live, the
  composer status was `background` and still accepted a prompt.
  (`A2-background-state.png`)
- On settle the row left the list, the timeline gained `Background task
  finished` + the command, then the agent's own follow-up turn ("… exit code
  0"). (`A3-timeline.png`)

## B — the output view shows real interim output and Stop works

**Verified.**

- The row's inspect button opened `#chat-drilldown` with the timeline hidden and
  `#chat-drilldown-output` shown;
  `#chat-drilldown-task[data-task-id="bik3yid6n"][data-task-state="running"]`
  carried the command, Stop and a ticking clock (0:02 → … → 0:27).
  `#chat-drilldown-output-text` held real output and grew while it ran,
  `tick-1` → `tick-1..3` → … → `tick-1..10`, then `\n[exited with code 0]\n`
  once the strip flipped to `data-task-state="settled"`.
  (`B1-output-view-open.png`, `B2-output-growing.png`, `B3-output-later.png`)
- Stop (separate run, 60 iterations): `[data-stop-task]` became `Stopping…`;
  within 1 s the strip read `stopped · …`, the output ended `tick-3\n\n[killed]`,
  the row left the list and the timeline gained `Background task stopped`.
  (`B4-before-stop.png`, `B5-after-stop.png`, `B6-timeline-stopped.png`)

## C — subagents and shell tasks while they run (re-run, after the fixes)

**Verified.** Four fresh Claude Code conversations on Haiku 4.5; every
observation is from a live run, not a replay.

- **C1 — a backgrounded subagent reads as running, with its progress note**
  (`recheck1.ts`). While the task was live the track read `1 of 1 subagent
  working · Read and summarize four repository files`, the row was
  `class="is-running"` with `.chat-subagent-progress` = `Using Read` and
  `data-open-conversation="claude:sub:<sessionId>:<agentId>"`; on settle it
  flipped to `1 subagent finished` / `is-completed`.
  (`recheck-C1-track-running.png`, `recheck-C1-track-final.png`)
- **C2 — a foreground subagent is openable while running, from both places**
  (`recheck2.ts`, `recheck3.ts`). The track row carried
  `data-open-conversation` from the first poll that showed it (5 s in) and kept
  it for the whole ~27 s run. The `Agent` tool row's `Open transcript` button
  (same child id) was present 7 s in, while the row's own status still read
  `running` — but only after expanding its collapsed group and the row itself,
  whose body is deferred while closed.
  (`recheck-C2-track-running-openable.png`,
  `recheck-C2b-timeline-open-transcript.png`)
- **C3 — the opened child transcript fills in live, through settle**
  (`recheck4.ts`, `Read` pre-approved with `Allow always` so the child was not
  blocked). Opened from the launching row while running, `#chat-drilldown-items`
  went 2 items / 100 chars → 4 → 5 / 900, ending with the subagent's own
  four-file summary, **with no reload**; the track flipped to `1 subagent
  finished` while the transcript stayed open, and on return the launching row
  read `Agent … completed` and still offered `Open transcript`.
  (`recheck-C2c-child-open.png`, `recheck-C2c-child-settled.png`,
  `recheck-C2c-row-after.png`)
- **C4 — a shell task's composer row ticks** (`recheck5.ts`).
  `li[data-background-task="bip30m6t3"]` carried
  `.chat-background-task-elapsed[data-elapsed-since]` reading `0:00`, then
  `0:03, 0:06 … 0:27` across ten polls; when the command settled the row left
  the list, `#chat-background-tasks` went hidden and its label emptied.
  (`recheck-C3-elapsed-first.png`, `recheck-C3-elapsed-ticking.png`,
  `recheck-C3-after-settle.png`)
- First pass, still valid: the backgrounded `Agent` is listed within 6 s, mid
  turn (`data-inspect-view="transcript"`, task id = agent id, as D8 expects),
  and its drill-down strip shows `general-purpose`, a ticking clock, `Using
  Read`, `17k tokens · 3 tool uses` and Stop. (`C1-agent-task-listed.png`)
- Side observation (not a defect): the subagent's `Read` permissions land in the
  parent timeline, hidden behind an open drill-down — in the re-run that stalled
  an open child transcript for ~40 s until the cards were answered.

## D — the hub switcher: working → finished → cleared

**Verified.** A ran the background command; B's page (same login, second tab)
was watched. A's chat panel was collapsed while the work ran, so A did not
report the chat surface in view.

- Baseline: B's menu row for `watch-docs` carried no state word, chip hidden.
- With A's turn over and only the shell task live, B's row read
  `.hub-menu-state.is-working` "working" and the chip
  `.hub-activity-badge.is-working` for ~48 s — **issue #388 fixed**.
  (`D2-B-working.png`)
- When the command and the follow-up turn ended, B flipped to
  `.hub-menu-state.is-finished` and `.hub-activity-badge.is-finished` count `1`
  — **issue #383's missing state**. (`D3-B-finished.png`)
- Re-opening A's chat panel cleared both on B within the first 2 s poll, with no
  reload of either page. (`D4-A-chat-back.png`, `D5-B-cleared.png`)
- Wire shape checked on `/api/hub/live?ws=…&activity=1`:
  `{"running":true,"working":…,"awaiting":…,"finished":…}`.

## Resolved — re-observed fixed against a real agent

1. **A running backgrounded subagent announced as finished** — reads running,
   with its progress note, until it settles (C1).
2. **A running foreground subagent could not be opened** — openable while
   running from the track row *and* the launching timeline row, and the child
   transcript follows it live through settle (C2, C3). The spec scenario "A
   running subagent is opened and followed … from its row or the subagents
   track" is now met for both kinds of run.
3. **A shell task's row carried no elapsed readout** — present, ticking, and it
   stops with the row (C4).
4. Cosmetic (first-pass defect 5): `#chat-background-tasks-label` no longer
   keeps stale text — at settle the list was hidden with an empty label.

## Open defects and surprises

1. **The tracks are collapsed `<details>`.** `#chat-background-tasks` and
   `#chat-subagents` show their label but hide their rows — and the inspect,
   open and Stop controls — until the summary is clicked; the launching timeline
   row costs two more clicks (its group, then the row, whose body is deferred
   while closed) before `Open transcript` exists in the DOM at all. Everything
   works after those clicks.
2. **A settled `Agent` row shows the raw result envelope** — `[ { "type":
   "text", "text": "Here are summaries of four files…" } ]` instead of the prose
   `renderSubagentResult` intends (`recheck-C2c-row-after.png`). Pre-existing:
   the Claude tool-result text path and `src/chat/tool-detail.ts` are untouched
   by this change.
3. After a task is stopped the composer status stayed `background` for a moment
   with zero rows (first pass, not re-exercised).
4. Harness note, not a product defect: a permission left unanswered in *any*
   conversation keeps the workspace `awaiting` forever, correctly suppressing
   `finished`. The first D run was invalidated by exactly that.

## Not covered and why

- `/code-review` and other skill forks — the spike established they produce no
  task frames at default levels, so there is nothing for this change to show.
- The two-user rule for `finished` — only the single `dev` user exists here.
- Monitors, touch mode, `finished` surviving a page close, output truncation
  (`#chat-drilldown-output-note` never fired at these sizes), Hub dashboard.
- Tab-visibility-driven "chat not in view": headless and headed Chromium both
  report every tab `visible`, so the collapsed chat panel was used instead —
  the same `chatSurfaceInView()` predicate, a different one of its inputs.

## Re-check: forked runs on CLI 2.1.280 (task 11.5)

2026-09-24, 18:03–18:10 UTC. A real Claude Code agent against a real hub. No
e2e fakes.

### What ran

- Test hub on `http://127.0.0.1:4703/` (user `dev`/`dev`), running this
  branch's rebased code with a clean git environment. The footer reads
  `fix/workspace-activity-states@2b8a86f`. The hub was already running and was
  not restarted. Workspaces: `playground` (a scratch repo whose only change is
  the uncommitted `add()` → `a - b` in `src/math.ts`) and `watch-docs`.
- Agent: the `claude` on PATH (`~/.local/bin/claude`, CLI 2.1.280). Every
  conversation used **Haiku 4.5**, picked in the configuration dialog. Auth
  worked. No permission card appeared in any run: the reviewers' `git`/`find`/
  `Read` calls ran without a prompt.
- Driver: throwaway Playwright + Bun scripts in `/tmp/uatu-recheck/` (`lib.ts`,
  `common.ts`, `a.ts`, `b.ts`, `b2.ts`, `c.ts`, `e.ts`, `r.ts`). They use
  headless Chromium, real clicks and keystrokes, and poll every 2 s. Logs are
  in `*.log` and screenshots in `*.png`, all in that folder.
- Five real sessions, each a new playground conversation:

  | run | what | conversation | forked run (task id) | length |
  |---|---|---|---|---|
  | A | typed `/code-review low` | `claude:8c6bf667…` | `a27806a476b6b5002` | ~12 s |
  | C | "Call the Skill tool with skill 'code-review' …" | `claude:8263f2e6…` | `a913ea94afdd0d0cb` (Skill `toolu_01F3xQ…`) | ~34 s fork, ~44 s turn |
  | A′ | typed `/code-review high` (supplement: longer silent run, drill-down open through settle) | `claude:8d853151…` | `a04e6ad3f03866381` | ~38 s |
  | D | typed `/code-review low`, chat panel collapsed right after sending | `claude:14eed6d2…` | `a87ac072977dee52b` | ~16 s |

### A: typed `/code-review low`: partially verified (one defect)

- **Typing the command:** `/code-rev` in `#chat-input` opened
  `#chat-command-menu` with one active option, `/code-review | [low|medium|high|xhigh|max|ultra] …`.
  Clicking it left `"/code-review "` in the input. The script then typed `low`
  and pressed Enter. (`A0-command-menu.png`)
- **(1) Listed as running, no Stop, not background work: verified.** At +2.2 s
  (first poll) the `#chat-subagents` track was unhidden and open, labelled
  `1 of 1 subagent working · /code-review`. It held one `li.is-running`,
  `/code-review`, with
  `data-open-conversation="claude:sub:8c6bf667…:a27806a476b6b5002"`. Its only
  button was the open button: no `[data-stop-task]` in the row.
  `#chat-background-tasks` stayed hidden with an empty label and zero rows at
  every poll. The drill-down strip read `/code-review | general-purpose | 0:01`
  and also had no Stop. (`A1-track-running.png`, `A2-drilldown-open.png`)
- **Composer during the run:** `#chat-composer-status[data-state]` read
  `sending` at +0 s, `working` ("Working") from +2.2 s to +11.2 s, then `ready`
  ("Completed") at +13.2 s. It never showed `background`, and the input stayed
  enabled.
- **(2) The opened transcript fills in without reopening: verified while
  running; see defect 1 for the end state.** The drill-down was opened once
  from the track and never reopened. `#chat-drilldown-items` read 0 items at
  open, then at +5.0 s 2 items / 105 chars (`Thought`, "I'll perform a
  low-effort code review…"), and at +7.0 s 3 items / 199 chars (adds `Working ·
  0s | 1 failed | Bash git diff main...HEAD …`). By +9.2 s the step had moved on
  to `Bash git diff HEAD …`. At +13.2 s the strip flipped to `finished ·
  /code-review` (`data-task-state="settled"`), 3 items / 265 chars.
  (`A3-drilldown-growing.png`, `A4-drilldown-settled.png`) The high-effort
  supplement A′ shows the growth more clearly. Counting nested
  `[data-chat-item-id]` in the open drill-down: 2 → 4 → 7 → 9 → 11 → 14 → 16 →
  18 → 22 → 23 over +5 s … +37.5 s, with the visible step moving `Bash git diff
  HEAD` → `Read src/math.ts` → `Bash ls -la` → `Bash git log --oneline -10` →
  `Bash git show 844d186:src/math.ts` → a `13 steps` group → `Bash cat
  README.md`. It was never reopened. (`E1-drilldown-open.png`,
  `E2-drilldown-growing.png`)
- **(3) Output in the timeline, entry reads finished: verified.** The timeline
  held exactly two items: the user's `/code-review low` and a message with
  "(low-effort review) · src/math.ts:2 — `add` function returns subtraction
  (`a - b`) instead of addition; any call to `add(x, y)` will return the wrong
  result". There was no model turn and no launching row. The track then read
  `1 subagent finished`, with the row `is-completed` and "Dismiss finished"
  offered. (`A5-timeline-after.png`)

### B: reopen: verified

- After a fresh page load (a new browser context, so no client state), the
  picker listed `/code-review low · Claude Code` and selected it. The timeline
  again held exactly `/code-review low` + the review text. The same was true
  after switching to another conversation and back. No `<local-command-…>`,
  `<command-…>` or `<task-notification>` text appeared, including in the stored
  `system/local_command` record, whose raw content is wrapped in
  `<local-command-stdout>`. (`B1-reopened-after-load.png`,
  `B2-reopened-after-switch.png`)
- The same check on the reload of all four review conversations (A, A′, C, D)
  also showed no markup. (`B5-reload-{A,C,D,E}.png`)
- **The run's entry was still listed after the reload** (`1 subagent finished`,
  collapsed, row `is-completed` with the same open target). This was a page
  reload with the session still live, so the provider's in-memory run map
  survived it. The design's expected absence applies to a reload from disk
  after the session restarts. That was not exercised, because the hub was not
  to be restarted.
- Reopened from that listed entry, the child transcript is **complete**: 4
  items, ending in "(low-effort review) · src/math.ts:2 — …". A′ is also
  complete, ending in its angles D–H summary. (`B3-child-reopened.png`,
  `B4-E-child-reopened.png`)

### C: model-invoked Skill fork: verified

- The run was listed at +6.2 s, the first poll after the `Skill` call; the poll
  at +4.2 s showed nothing yet. It read `1 of 1 subagent working ·
  code-review`, with the row `is-running` `Skill · code-review`,
  `data-open-conversation="claude:sub:8263f2e6…:a913ea94afdd0d0cb"`, and no
  Stop. `#chat-background-tasks` had zero rows throughout. (`C1-track-running.png`)
- The launching row (`tool:toolu_01F3xQxYHA67qqnSweQBSEzz`, summary
  `Skill code-review running`) offered `Open transcript` with the **same**
  child id at that same poll, while it was still running.
  (`C2-skill-row-open-transcript.png`)
- It was opened from the Skill row and never reopened. The drill-down went from
  0 items (+9.2 s) to 2 items / 274 chars (+11.2 s, "…Let me start by
  gathering the diff…") to 3 items. The live step then moved through `Bash git
  diff HEAD` → `Read src/math.ts` → `find … *.test.*` → `Bash grep -r "add("` →
  `Bash git show HEAD:src/math.ts` → `Read README.md` → `Thought`. At settle
  (+40.2 s) it held 4 items / 2130 chars, including the fork's **final**
  `Findings` JSON (`add(5, 3) should return 8 but returns 2 …`). The track
  flipped to `1 subagent finished` while the transcript was open.
  (`C3-drilldown-open.png`, `C4-drilldown-growing.png`,
  `C5-drilldown-settled.png`)
- Afterwards, the Skill row read `Skill code-review completed` and still offered
  `Open transcript`. Its result reads `Skill "code-review" completed (forked
  execution). Result: …`, followed by the agent's own summary.
  (`C6-timeline-after.png`)

### D: switcher: verified

- A second page on `watch-docs` read the switcher menu (`#hub-menu`) every 2–6 s.
  Baseline: no state words on `playground`, badge hidden.
- **Working:** the `playground` row read `.hub-menu-state.is-working`
  "working", with the chip `.hub-activity-badge.is-working`, from the send
  through the end of the run in A, C, A′ and D. (`D1-W-working.png`)
- **Finished:** in run D, `playground`'s chat panel was collapsed 1.5 s after
  sending, so no page reported the chat in view. At +16.8 s `watch-docs` showed
  `.hub-menu-state.is-finished` "finished" and `.hub-activity-badge.is-finished`
  with the text `1`. (`D2-W-finished.png`) Expanding `playground`'s chat panel
  cleared both on `watch-docs` by the first poll, 2.5 s later, with no reload.
  (`D3-W-cleared.png`) Run D's timeline has the review text, and its track reads
  `1 subagent finished`. (`D4-P-after.png`, `D9-timeline.png`)
- In A, C and A′ the chat panel was open at the end, so the switcher went
  straight from working to no state. That is expected: the finish was viewed.

### E: git environment: verified

No review output, timeline or reopened transcript mentions a broken git wrapper
(`gitWarn=false` on every timeline). Every `tool_result` in the four reviewer
transcripts on disk was checked for `warning|wrapper|credential|GIT_|askpass`:
there were 0 hits across 23 results. The only "wrapper" text in those
transcripts is Uatu's own `CLAUDE.md`, which the nested playground session loads
as context ("…Uatu's projected Git/SSH wrappers…"). It is not a warning.

### Defects found

1. **An open drill-down on a typed command's run stops one step short of the
   end.** Seen in both A and A′. When the run settles, the open transcript keeps
   its last disk re-read, which lacks the reviewer's final `Thought` and its
   review text. The drill-down never catches up.
   - **A:** the transcript on disk wrote the final text ("(low-effort review) …")
     at 18:03:20.284. The strip read `finished` at 18:03:21, and the open
     drill-down stayed at 3 items / 265 chars, ending "… · Thought", through
     18:03:27.
   - **A′:** the final "Based on my high-effort code review of the diff …" was
     written at 18:07:58.576, with `system/local_command` at 18:07:58.603. The
     drill-down stayed at 9 items / 564 chars, ending "Bash cat README.md ·
     Thought", from 18:07:59 to 18:08:10. (`A4-drilldown-settled.png`,
     `E3-drilldown-settled.png`)
   - Reopening the run shows the complete transcript (`B3`, `B4`).
   - **Cause:** `SilentRunFollower.follow(false)` in
     `src/chat/task-inspection.ts` stops the follow, and aborts any in-flight
     read, as soon as the run settles. The code comments that "the settled run's
     last word arrives on its own stream", but a typed command's run has no
     stream. Its last word arrives only in the parent's `<synthetic>` frame and
     on disk, so no final re-read happens.
   - The Skill fork (C) streams, and its open transcript did end complete.
   - This falls short of "continues to update until the run ends" / "the run's
     completion is reflected in the open transcript".

### Observations (not defects)

- Opening the Skill fork from its launching row (C) showed no task strip:
  `#chat-drilldown-task` stayed hidden. Opening a typed command's run from the
  track (A, A′) shows the name, type, clock and settle line. The C run was not
  opened from its track row, so it is unknown whether the track route shows the
  strip for a Skill fork.
- In C and A′ the open drill-down folds the reviewer's tool calls into one
  "Working" / "N steps" group that shows only the latest step. The top-level
  item count stays flat while the run works, so growth is visible in the
  changing step line and the nested item count rather than in new top-level
  rows.
- Every `playground` page load logs one `409 (Conflict)` resource error in the
  console. It was not investigated.
- The reviewer's first `git diff main...HEAD` fails, because the scratch repo's
  branch is `master`. It retries with `git diff HEAD`. This is the review
  recipe's behavior and shows as `1 failed` in the step group.

**Resolution of the defect above.** Fixed after this re-check: the silent-run follower now records whether the run's own stream carried its words since the last disk read. A run that settles without having spoken (a typed command) gets a fresh read at the settle and one more a refresh period later, then nothing; a run that streamed (a skill fork) stops as before with no extra reads. Covered by fake-timer tests in `src/chat/task-inspection.test.ts` and a drill-down test in `src/chat/ui.test.ts` that reproduces the status-only settle; both fail without the fix. The `409 (Conflict)` seen on every page load is `GET …/api/chat/usage?agent=opencode` answering "this agent does not report plan usage": an expected unsupported answer, identical on upstream `main`, not this change.

