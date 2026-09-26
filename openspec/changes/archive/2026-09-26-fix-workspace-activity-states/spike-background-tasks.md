# Spike: what Claude Code reports for running background work

Date: 2026-09-22. Timeboxed (~25 min). Task 0.1 of `fix-workspace-activity-states` (design D9).

- Global CLI: Claude Code 2.1.267 (compiled Bun binary, `/opt/homebrew/Caskroom/claude-code/2.1.267/claude`).
- SDK used by Uatu: `@anthropic-ai/claude-agent-sdk` 0.3.261, bundling `claude-agent-sdk-darwin-arm64` CLI **2.1.261** (also a compiled binary — there is no `cli.js`; the transcripts stamp `"version":"2.1.261"`).
- Method: live probes through the SDK `query()` (auth from the local Claude Code login worked on the first try) plus `grep -a` on the compiled binary and the SDK `.d.ts` files. Probe script and raw frame logs: `/tmp/uatu-spike/{probe.ts,a2,b,c,d,d2}.jsonl` (throwaway, outside the repo).
- Probe options: `model: claude-haiku-4-5`, `permissionMode: bypassPermissions` + `allowDangerouslySkipPermissions`, `perTaskStopAffordance: true`, `agentProgressSummaries: true`, `forwardSubagentText: true`, `includePartialMessages: false`, cwd `/tmp/uatu-spike/work` (a one-commit git repo). The prompt was a **streaming** `AsyncIterable` kept open after the first result (like Uatu's PushQueue); see Surprises for why.

## Q1 — `local_agent`: is `task_started.task_id` the subagent's agentId?

**Yes, for both foreground and backgrounded runs.** `task_id` == `AgentOutput.agentId` == the `<agentId>` in `~/.claude/projects/<cwdSlug>/<sessionId>/subagents/agent-<agentId>.jsonl`. `tool_use_id` on every task frame is the launching `Agent` tool_use's id, and every forwarded subagent frame carries that same id as `parent_tool_use_id`.

Backgrounded (probe b):
```
task_started  task_id=ada2b9582caa230c5 tool_use_id=toolu_013s2jZsDCiw3cAHYTqFeSpc subagent_type=general-purpose
              is_backgrounded=true spawn_depth=1 task_type=local_agent prompt="List the files in the current directory ..."
user/tool_result (tool_use_result): {isAsync:true, status:"async_launched", agentId:"ada2b9582caa230c5", description, resolvedModel,
              prompt, outputFile:"/private/tmp/claude-501/-private-tmp-uatu-spike-work/<sessionId>/tasks/ada2b9582caa230c5.output", canReadOutputFile:true}
assistant/user frames with parent_tool_use_id=toolu_013s2jZs...  (thinking, tool_use Bash, tool_result, text — forwardSubagentText delivered text+thinking)
task_progress task_id=ada2b9582caa230c5 usage{total_tokens:13122,tool_uses:1,duration_ms:4751} last_tool_name=Bash   (no `summary`: run < 30 s)
task_updated  patch{status:"completed",end_time}
task_notification status=completed output_file=<same path> summary="There is **1 file** ..." usage{...}
on disk: ~/.claude/projects/-private-tmp-uatu-spike-work/<sessionId>/subagents/agent-ada2b9582caa230c5.jsonl  (+ .meta.json
         {"agentType":"general-purpose","description":"List files and count them","toolUseId":"toolu_013s2jZs...","spawnDepth":1})
```
Foreground (probe c): `task_started task_id=adcea0e635b291813 is_backgrounded=false`, subagent frames under `parent_tool_use_id`, then `task_updated`/`task_notification` (same `task_id`, `output_file=.../tasks/adcea0e635b291813.output`), then the sync tool_result with `tool_use_result.agentId="adcea0e635b291813"`, `agentType`, `content`, `usage`. Transcript: `.../subagents/agent-adcea0e635b291813.jsonl`. A foreground agent emits **no** `background_tasks_changed`; a backgrounded one is listed there (`task_type: local_agent`).

Agent-task `output_file` is a **symlink** to the subagent transcript: `tasks/<agentId>.output -> ~/.claude/projects/<cwdSlug>/<sessionId>/subagents/agent-<agentId>.jsonl`.

## Q2 — backgrounded `local_bash`: where is the output, and who names it before settle?

**The path is named at launch, in the Bash tool_result text, and is derivable by convention.** It is *not* under `~/.claude`.

```
<tmpRoot>/claude-<uid>/<cwdSlug>/<sessionId>/tasks/<task_id>.output
e.g. /private/tmp/claude-501/-private-tmp-uatu-spike-work/57489e13-.../tasks/bgjpa5uwy.output
```
Evidence (probe a2, tool_use → frames within 10 ms):
```
background_tasks_changed tasks=[{task_id:"bgjpa5uwy", task_type:"local_bash", description:"sleep 25; echo spike-done"}]
task_started  task_id=bgjpa5uwy tool_use_id=toolu_01E1fJ... description="sleep 25; echo spike-done" is_backgrounded=true task_type=local_bash
user/tool_result content: "Command running in background with ID: bgjpa5uwy. Output is being written to:
   /private/tmp/claude-501/-private-tmp-uatu-spike-work/<sessionId>/tasks/bgjpa5uwy.output. You will be notified when it completes.
   To check interim output, use Read on that file path."
   tool_use_result: {stdout:"",stderr:"",interrupted:false,isImage:false,noOutputExpected:false,backgroundTaskId:"bgjpa5uwy"}   <- no path field
... 25 s, NO task_progress for local_bash ...
background_tasks_changed tasks=[]
task_updated  patch{status:"completed",end_time}
task_notification task_id=bgjpa5uwy tool_use_id=... status=completed output_file=<same path> summary="Background command \"sleep 25; echo spike-done\" completed (exit code 0)"
```
Binary (2.1.261) confirms the template: `outputDir = join(bR(), K(), "tasks")` and `outputPath = join(outputDir, `${taskId}.output`)` (function `P7e`, with an `outputPathBindings` override map used only for rerooted/sandboxed tasks), and the launch text is built by `F2t({backgroundTaskId, outputPath, ...})` — the same template also produces "Command did not complete within its Ns timeout and was moved to the background (ID: …). Output is being written to: …" and the "manually backgrounded"/"moved to the background so that a message … can reach you" variants. So: **the structured `BashOutput` carries only `backgroundTaskId`; the path is in the tool_result *text* (parse `Output is being written to: (.+?)\.` ) or reconstructable from `<tmpRoot>/claude-<uid>/<cwdSlug>/<sessionId>/tasks/<task_id>.output`**. The file is a plain text file that already contains interim output while running (`spike-done` + `\n[exited with code 0]` at the end). `task_started`/`task_updated` never name it; `task_notification.output_file` is the only structured carrier.

## Q3 — how `/code-review` runs its work

Partial. `/code-review` is a CLI-bundled skill (not on disk under `~/.claude`; the only extracted bundled skill at `/private/tmp/claude-501/bundled-skills/2.1.267/` is `run`). Sending the literal prompt `/code-review` through the SDK was **not expanded** as a slash command: the model answered "I don't see an explicit task in your message" (probe d, 5 frames, no tasks). A second probe asking the model to call the `Skill` tool with `code-review` (probe d2) is recorded below if it finished inside the timebox.

Probe d2 (model asked to call `Skill` with `code-review`, haiku, a one-line README diff) — **the skill ran as a *forked* agent, not as a task**:
```
assistant tool_use Skill {skill:"code-review"}                                (tool_use_id = toolu_...)
3 assistant + 3 user frames with parent_tool_use_id=<that id>                  (forwarded fork transcript: thinking, Bash `git diff HEAD`, text)
user/tool_result tool_use_result: {success:true, commandName:"code-review", status:"forked", agentId:"aaeeab292f002e3d7", result:"Based on my analysis ..."}
assistant tool_use ReportFindings {count:1, level:"high", findings:[{file:"README.md", line:7, summary:"Function named 'add' implements subtraction ..."}]}
```
No `task_started`, `task_progress`, `task_updated`, `task_notification`, or `background_tasks_changed` frame appeared for the fork or anything inside it; nothing was created under `.../tasks/`. On disk the fork is an ordinary subagent transcript: `~/.claude/projects/<cwdSlug>/<sessionId>/subagents/agent-aaeeab292f002e3d7.jsonl` (+ `.meta.json`). Inside it, at this effort level and diff size, the review ran only foreground `Bash` (`git diff HEAD`) — **no `Agent` launches, no `run_in_background`, no background bash**. So for the default levels `/code-review` contributes to activity only through the normal `running` turn; it produces no background-task rows and no `is_backgrounded`/`subagent_type`/`prompt` task frames. The skill description says the `ultra` level does a "deep multi-agent review in the cloud" (a `remote_launched` AgentOutput / remote task) — not probed. Static check: the binary's printable strings hold only the skill's descriptions ("Review the current diff or a PR for bugs and cleanups", the `/code-review high` level hint, "Run /code-review ultra ... to review these changes in the cloud") and the `ReportFindings` tool text — no readable skill body or agent-launch code — so the live probe is the only evidence for how it runs. Caveat: the SDK-bundled CLI is 2.1.261; a larger diff or a higher effort level may make the forked reviewer spawn foreground `Agent`s, which would then surface as ordinary `local_agent` task frames per Q1.

## Surprises Uatu should know about

1. **Single-string prompts kill background tasks.** With `prompt: "<string>"` the SDK closes the session after the first `result`; the `sleep 25` task was reaped 5 s later as `task_updated patch.status="killed"` + `task_notification status="stopped"` (probe a). Uatu's streaming PushQueue avoids this — the spike switched to a streaming prompt and the task then completed.
2. **The CLI's follow-up turn after a notification starts with a fresh `system/init` frame** (same `session_id`), then assistant text and a second `result`. Both shell and agent completions produced it (~60 ms after `task_notification`).
3. **`local_bash` emits no `task_progress` at all** (25 s run, nothing). `task_progress` was observed only for `local_agent`, once per subagent tool use (`last_tool_name`, cumulative `usage`); no `summary` arrived because the runs were shorter than the ~30 s summary cadence, so the model-written line is unverified here.
4. **`forwardSubagentText: true` works:** subagent `thinking` and `text` blocks arrived as `assistant` frames with `parent_tool_use_id` set, for foreground and backgrounded agents alike; the subagent's `user` tool_result frames also carry `parent_tool_use_id` (their `tool_use_result` was `null`).
5. **The async `AgentOutput` tool_result is complete at launch**: `agentId`, `description`, `prompt`, `resolvedModel`, `outputFile`, `canReadOutputFile`, `isAsync`. The foreground result adds `agentType`, `content`, `usage`, `totalDurationMs`, `totalTokens`, `totalToolUseCount`, and `harness*` fields not in `sdk-tools.d.ts`.
6. **Agent `output_file` is a symlink into `~/.claude/projects/...subagents/agent-<id>.jsonl`**; shell `output_file` is a regular file under `/private/tmp/claude-<uid>/...` (macOS `os.tmpdir()`-style root). Reading through `realpath` lands agents inside the config dir and shells outside it.
7. Task ids: `local_bash` ids are 9-char random (`bgjpa5uwy`), `local_agent` ids are 17-hex (`ada2b9582caa230c5`) = agentId. `background_tasks_changed` fires for backgrounded tasks only (both types) and precedes `task_started` by <2 ms; the empty list precedes `task_updated`/`task_notification`.
8. The foreground agent also gets `task_started` (`is_backgrounded:false`), `task_updated`, and `task_notification` (with `output_file`), matching the normalizer's "foreground so far: keep, show nothing" branch.
9. `rate_limit_event` and `system/thinking_tokens` frames are interleaved everywhere (already ignored by Uatu).

## Recommended adjustments to design D6–D8

- **D8 (confirmed):** `childConversationId` for a `local_agent` task = `sub:<sessionId>:<task_id>` — `task_id` is the agentId for foreground and backgrounded runs, so the provider can learn the child id at `task_started` and keep `tool_use_id → child` for routing frames tagged `parent_tool_use_id`. No need to wait for the tool result. The `.meta.json` beside the subagent transcript (`agentType`, `description`, `toolUseId`, `spawnDepth`) is a second source if ever needed.
- **D6:** keep `subagent_type`, `prompt`, `spawn_depth` from `task_started`; `usage` from `task_progress`/`task_notification`; for shell tasks do **not** expect `task_progress` — elapsed time from `createdAt` is the only live signal, so the row's "progress" line for `local_bash` should be the elapsed readout, not `Using <tool>`.
- **D6/D7 output path:** derive the shell task's `outputFile` at launch from the launching Bash tool_result **text** (`Output is being written to: <path>.`), with the convention `<tmpRoot>/claude-<uid>/<cwdSlug>/<sessionId>/tasks/<task_id>.output` as a fallback; `task_notification.output_file` then only confirms it. The spec's "from the moment Claude Code makes the task's output location known" is therefore effectively "from launch".
- **D7 path guard must change:** "refusing paths outside Claude Code's config directory" would refuse every shell task, because the file lives under the OS temp root, not `~/.claude`. Replace with: accept a path only if it equals the notified/parsed `output_file` for a task that belongs to the conversation AND, after `realpath`, it is under either the CLI's task-output root (`<tmpRoot>/claude-<uid>/<cwdSlug>/<sessionId>/tasks/`) or the config dir's `projects/<cwdSlug>/<sessionId>/subagents/`. Keep the bounded tail; the file already contains interim output while running and ends with `[exited with code N]` on settle.
- **D7 agent tasks:** the agent `output_file` is just the subagent `.jsonl`; the child drill-down already reads it, so no output pane is needed for agents (as designed).
- **Skill forks (D8):** a `Skill` tool result with `status:"forked"` carries an `agentId` whose frames stream under the Skill tool_use's `parent_tool_use_id` but never announce a task; if a live child is wanted for forked skills too, the provider needs the same `tool_use_id → sub:<sessionId>:<agentId>` mapping from that tool result (only available when the fork ends) or a `parent_tool_use_id`-keyed buffer. Out of scope unless the drill-down should cover skill forks.
- **Provider lifecycle:** the `init` frame that opens the CLI's own follow-up turn after a notification must not be treated as a new session/reset (it carries the same `session_id`).

## Q4 — `/code-review` typed as a slash command (local command)

Setup: streaming `AsyncIterable` prompt kept open, Uatu's `query()` options (`includePartialMessages`, `enableFileCheckpointing`, `perTaskStopAffordance`, `agentProgressSummaries`, `forwardSubagentText`), `bypassPermissions`, `claude-haiku-4-5`, one user message `/code-review low` (and a second run `/code-review high`), scratch repo with an uncommitted `add` returning `a - b`. **Executable matters:** Uatu passes the discovered `claude` (`~/.local/bin/claude` → CLI 2.1.280), not the SDK-bundled 2.1.261; the Q3 probe used the bundled CLI, which did not expand the slash command. With 2.1.280 `/code-review` runs as a local command. Three runs: low 8 s, high 64 s (Bash + Read inside the reviewer), low again 24 s. All produced the same frame sequence.

**a. Every non-stream frame (low run; high run identical, times in brackets)** — nothing else arrived, not even `stream_event`:
```
+0.50 s (0.43)  system/task_started      1
+4.8 s  (4.9)   rate_limit_event         1
+8.4 s  (63.9)  system/task_notification 1
+8.4 s  (63.9)  system/init              1   <- the first init comes AFTER the command, not before it
+8.4 s  (63.9)  assistant                1
+8.4 s  (63.9)  result/success           1
```
No `task_progress` (even at 64 s with two reviewer tool uses, so no `agentProgressSummaries` line), no `task_updated`, no `background_tasks_changed`, no `tool_progress`, no `session_state_changed`. The run is announced once, at +0.5 s, with no `tool_use_id`:
```json
{"type":"system","subtype":"task_started","task_id":"ad53ca64bd188affb","description":"/code-review",
 "subagent_type":"general-purpose","is_backgrounded":false,"spawn_depth":1,"task_type":"local_agent",
 "prompt":"`low effort → 1 diff pass → no verify → ≤4 findings` ## Turn 1 — read …",
 "skip_transcript":true,"ambient":true,"uuid":"8848…","session_id":"0058…"}
```
**b. Reviewer frames:** none reach the SDK stream — no assistant/user frames, no thinking/text, no Bash tool_use, with any `parent_tool_use_id`. `forwardSubagentText` does not apply to this run. They exist only on disk (`isSidechain:true`, `agentId:"ad53ca64bd188affb"` on every record).

**c. How the review arrives:** as one `assistant` frame with `model:"<synthetic>"`, zeroed `usage`, `parent_tool_use_id:null`, and a top-level `local_command_source` field, then a `result` that repeats the text:
```json
{"type":"assistant","message":{"id":"4c59…","model":"<synthetic>","role":"assistant","stop_reason":"end_turn",
 "usage":{"input_tokens":0,"output_tokens":0,…},"content":[{"type":"text","text":"math.ts:2 — function named `add` now returns subtraction (`a - b`) …"}]},
 "parent_tool_use_id":null,"local_command_source":"<local-command-stdout>math.ts:2 — …</local-command-stdout>","session_id":"0058…"}
{"type":"result","subtype":"success","is_error":false,"num_turns":0,"duration_ms":7984,"duration_api_ms":0,
 "local_command":"code_review","result":"math.ts:2 — …","total_cost_usd":0.0229,"result_index":0,"queued_turn_count":0}
```
It is not a `system/local_command` frame live; that subtype exists only in the stored transcript (parent `.jsonl`: `user` isMeta caveat, `user` `/code-review low`, `system` `local_command` `<local-command-stdout>…`).

**d. Turn shape:** a `result` does end the command (`local_command:"code_review"`, `num_turns:0`). Nothing marks its start except `task_started`: no `init`, no stream events, no assistant frame for 8–64 s. Uatu's own dispatch (`provider.command()` → `prompt()`) emits `status:"running"` at acceptance and bumps `pendingTurns`, so the conversation **status** is `running` the whole time and turns `completed` at the result. The dead air is in the **timeline**: nothing is added between the user's message and the final text.

**e. Agent id:** `task_started.task_id` (+0.5 s) and `task_notification.task_id` are the agent id: `~/.claude/projects/<cwdSlug>/<sessionId>/subagents/agent-ad53ca64bd188affb.jsonl` (meta `{"agentType":"general-purpose","requestShape":"foreground","requestNonInteractive":true}`, no `toolUseId`). `task_notification.output_file` = `/private/tmp/claude-501/<cwdSlug>/<sessionId>/tasks/<task_id>.output`, a symlink to that `.jsonl` (the same convention as Q1). The file is written **live**: polled at 0.5 s intervals, it existed about 1.5 s after the prompt with 10 lines and grew to 19 while the reviewer ran.

**Why Uatu showed nothing, frame by frame**
- `task_started`: `normalization.ts` `backgroundTaskUpdate` sees `ambient:true`/`skip_transcript:true`, adds the id to `memory.ambientTasks`, and returns `ignored`. Even without that flag, `is_backgrounded:false` would take the "remembered but silent" branch, and `launchingRowUpdate` requires a `tool_use_id`, which is absent. `provider.ts` `learnSubagentRuns` opens a child only when there is a `toolUseId` and the task is not ambient, so no child is opened. No `backgroundTasks` entry is created, so there is no row and no drill-down.
- Reviewer activity: never streamed, so `routeSubagentFrame`/`bufferForkFrame`, which key on `parent_tool_use_id`, have nothing to route.
- `task_notification`: ambient id → `ignored`; there is no child to settle.
- `init` (post-command): `pendingTurns` is 1, so it is not read as an unprompted turn. Harmless.
- `assistant` `<synthetic>`: normalized as ordinary assistant text, so the review does appear at the end. Side effect: `memory.lastModel` becomes `"<synthetic>"` (there is no guard for it), and its zero `usage` is a per-message carrier. Both may disturb the model/context readout. Not verified in the UI.
- `result`: ends the turn normally. Replay: the stored `system/local_command` record falls to the `system` branch's final `ignored`, and `local_command_output` is on the `INTENTIONALLY_IGNORED` list. The review text therefore likely **disappears on reopen** from transcript (inferred from code, not run).

**What Uatu could key on**
- (i) Show a running review: treat `system/task_started` with `ambient:true` + `task_type:"local_agent"` + `description` starting with `/` (here `"/code-review"`) as a user-initiated command run, not housekeeping. It needs a row keyed `task:<task_id>` from `task_started` (+0.5 s) to `task_notification` (`status`), with `prompt` (the level recipe) available. `result.local_command:"code_review"` confirms at the end. Elapsed time is the only live signal the stream gives. "What it is doing" must come from tailing the subagent `.jsonl` (the stream has no `task_progress`).
- (ii) Open the live transcript: child id `sub:<sessionId>:<task_id>` from `task_started.task_id`. Its transcript is the file at `<configDir>/projects/<cwdSlug>/<sessionId>/subagents/agent-<task_id>.jsonl` (or `realpath` of `tasks/<task_id>.output`), and must be **read from disk incrementally**, because no frames are forwarded. There is no `tool_use_id`, so the D8 `tool_use_id → child` map cannot be used. Key the child by `task_id` instead.
- Final text: take the `assistant` frame carrying `local_command_source` (model `<synthetic>`) as the command's output. Skip it for model/usage bookkeeping. On replay, render stored `system/local_command` `<local-command-stdout>` content.

## Q5 — forked runs on CLI 2.1.280: census and skill forks

**Part A — census of `~/.claude/projects/*/*/subagents/` on this machine (141 runs, every `agent-*.jsonl` has a `.meta.json`; transcripts from CLI 2.1.236–2.1.280).**

| launch | n | `agentType` | `requestShape` | `toolUseId` | other meta keys |
|---|---|---|---|---|---|
| `Agent` tool in the parent session | 78 | general-purpose 71, Explore 5 (+2 older, no shape) | background 57, foreground 19 | yes | `description`, `model`, `spawnDepth:1` |
| `Agent` tool inside a subagent (nested) | 49 | general-purpose 31, `fork` 18 | background 26, foreground 23 | yes (a tool use in the sibling subagent's `.jsonl`) | `parentAgentId`; the `fork` runs also `isFork:true`; `spawnDepth:2` |
| model-invoked `Skill` fork (`code-review`) | 5 | general-purpose | foreground 3, none 2 (CLI ≤2.1.261) | **no** | `spawnDepth:1`, no `description` |
| typed `/code-review` (local command) | 9 | general-purpose | foreground 7, background 1, none 1 (2.1.261) | **no** | the background one (CLI 2.1.267, TUI session) also has `name:"code-review"`, `description:"/code-review"` and two side files, `agent-<id>.forked-skill.json` `{skillName, attributionName, effort}` and `.forked-skill.marker.json` `{forkedSkill:true, skillName}` |

`requestNonInteractive` is `true` on every run that has the key (136). All 14 runs without a `toolUseId` were classified from the parent transcript at the run's first timestamp. Nine sit directly after a `user` record that begins `/code-review`, preceded by `queue-operation` enqueue/dequeue, or by a `<local-command-caveat>` in the TUI. The other five sit directly after an `assistant` `tool_use: Skill(code-review)` whose `tool_result` has `toolUseResult.status:"forked"` + `agentId` = the run. **No housekeeping runs were found:** no compaction, hook, auto-memory, or title/summary run left a transcript under `subagents/`. Every run there is either an `Agent` launch or a `code-review` fork, typed or model-invoked. A UI that lists every run there would see no noise on this machine's history. This proves only that such runs are absent from this sample, not that the CLI never writes them. Caveat: in the model-invoked fork, the fork's `meta.json` never carries the Skill `toolUseId`; the only on-disk link is the parent `tool_result.toolUseResult.agentId`, written when the fork ends.

**Part B — model-invoked `Skill` fork on 2.1.280 (live; Uatu's options, `~/.local/bin/claude`, haiku, a one-line uncommitted diff; 46 s fork)**
1. **Still a fork.** `tool_result` `tool_use_result: {success:true, commandName:"code-review", status:"forked", agentId:"afd1c64a374700d34", result:"## Findings …"}` at +45.9 s.
2. **Task frames now appear, at the start.** Q3 (bundled 2.1.261) had none. `task_started` arrives 12 ms after the Skill `tool_use`, now **with** a `tool_use_id`, but still ambient:
   ```
   +4.798 assistant tool_use Skill {skill:"code-review"}   id=toolu_…Jmk1r
   +4.810 system/task_started {task_id:"afd1c64a374700d34", tool_use_id:"toolu_…Jmk1r", description:"/code-review",
          subagent_type:"general-purpose", is_backgrounded:false, spawn_depth:1, task_type:"local_agent",
          prompt:"(No effort level given — reusing high …", skip_transcript:true, ambient:true}
   +34.8  tool_progress {tool_use_id:"toolu_…Jmk1r-heartbeat-0", tool_name:"Skill", parent_tool_use_id:"toolu_…Jmk1r", elapsed_time_seconds:30, heartbeat:true}
   +45.93 system/task_notification {task_id:"afd1c64a374700d34", tool_use_id:"toolu_…Jmk1r", status:"completed",
          output_file:"/private/tmp/claude-501/<cwdSlug>/<sessionId>/tasks/<task_id>.output", summary:"/code-review", ambient:true}
   +45.93 user tool_result (status:"forked", as above)
   ```
   No `task_progress`, `task_updated`, or `background_tasks_changed` arrived.
3. **The fork streams.** 21 `assistant` + 10 `user` frames arrived tagged `parent_tool_use_id` = the Skill tool use, from +4.81 s (the fork's prompt as a `user` frame) to +45.9 s: thinking, text, eight `Bash`, one `Read`, and the paired tool_results. No `stream_event` partials came from the fork.
4. **The file is live on disk.** `subagents/agent-afd1c64a374700d34.meta.json` appeared at +4.85 s (40 ms after `task_started`) and the `.jsonl` at +5.10 s with 10 lines. The `.jsonl` grew in step with the streamed frames to 53 lines at +46.2 s. `meta.json` = `{"agentType":"general-purpose","spawnDepth":1,"requestShape":"foreground","requestNonInteractive":true}`, with **no `toolUseId`** and no `description`. No `forked-skill*.json` was written. The fork's records carry `isSidechain:true, agentId`.

`simplify` (model-invoked, same setup) is **not** a fork. Its Skill result is `{success:true, commandName:"simplify"}` with no status or agentId. The skill expands inline, and the main model then launches four ordinary `Agent` tool uses (`run_in_background`). Each gets `background_tasks_changed` + `task_started` (`tool_use_id`, `is_backgrounded:true`, not ambient) and a `meta.json` with `toolUseId`, which is the Q1 pattern. Among the bundled skills, only `code-review` was seen forking, both in the probe and in the census.

**Signals a general mechanism can key on**
- *Agent tool, foreground or background:* the earliest signal is `task_started` (`tool_use_id`, `task_id` = agent id, not ambient; bg preceded by `background_tasks_changed`). It streams with `parent_tool_use_id` = the Agent tool use. The `.jsonl` is live, and `meta.json.toolUseId` links it back.
- *Model-invoked Skill fork (`code-review`):* the earliest signal is `task_started` at launch, with `tool_use_id` = the Skill tool use and `task_id` = agent id, but **`ambient:true`**. Only the tool_result `agentId` confirms it at the end. It streams with `parent_tool_use_id` = the Skill tool use, and Skill `tool_progress` heartbeats every 30 s. The `.jsonl` is live, and its `meta.json` has no `toolUseId`.
- *Typed `/code-review` (local command, Q4):* the earliest signal is `task_started` with `ambient:true`, **no `tool_use_id`**, and `description:"/code-review"`. It does **not** stream; the only live source is the `.jsonl`, polled from disk. The `meta.json` has no `toolUseId`, and older TUI runs have `forked-skill*.json` side files.
- *Housekeeping:* none found in `subagents/`, so there is nothing to filter. The practical rule is: `ambient` + `local_agent` means a forked skill or typed command; open it by `task_id`, and route its frames by `tool_use_id` when one is present.
