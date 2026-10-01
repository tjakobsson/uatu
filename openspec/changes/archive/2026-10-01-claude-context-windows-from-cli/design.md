## Context

The Claude provider learns its model list in two places
(`src/chat/claude/provider.ts`):

- `hydrateCatalog` → `runCatalogProbe`: a promptless, transcript-free probe
  session started on the first picker or command read. It calls
  `supportedModels()` and is torn down. It runs only while `liveModels` is
  `null`.
- `captureModels` on every live session start (`void this.captureModels(query)`),
  which replaces `liveModels` wholesale.

Both build rows through `modelsFromCatalog`, which sets `contextLimit` from
`ModelInfo.contextWindow` (a field the CLI has never sent) or from
`claudeContextWindow(value, resolvedModel)`, the id heuristic over the
hand-kept tables in `models.ts`. `listModels` appends the "More models" rows
(`withMoreModels`), whose `contextLimit` and `detail` text ("… · 200k context
· …") are fixed at module load.

The client's readout (`src/chat/context-readout.ts`) takes a window from the
newest session `context_report` with `max` for the model, else the model row's
`contextLimit`. Live sessions emit that report after each turn through
`getContextUsage()`. Reopened conversations never do. This design changes only
where `contextLimit` comes from; the readout logic stays as it is.

Probe facts (2026-10-01, CLI 2.1.281, SDK 0.3.286), all on an unprompted
streaming-input session:

- `getContextUsage({ detail: "summary" })` answers before any prompt. The first
  call took about 530 ms (CLI warm-up); later calls took 3–13 ms. Per the SDK
  docs, `summary` uses local estimates and makes no token-count calls.
- `setModel` is the cost: about 0.2 s for a catalog alias (`sonnet`, `opus`)
  and 0.9–1.9 s for a full id (`claude-opus-4-8`, the "More models" rows).
  Reading every offered model took about 11 s in a cold measurement and
  5.7 s inside the provider. This was found while implementing; the first
  draft assumed about 10 ms per row.
- The chat service awaits the first `listModels()` before the chat becomes
  available (`src/chat/service.ts`), so anything the first read waits on
  delays the chat itself. The page re-reads the model list when the picker
  opens (`refreshCatalogsOnUse`).
- `setModel(id)` followed by that read returns `maxTokens` / `rawMaxTokens` and
  `model`, the resolved id actually in effect, for the new model.
- `setModel` on the probe is session-scoped. `~/.claude/settings.json` was
  unchanged afterwards.
- With no model set, the session ran the settings' model (`fable[1m]` →
  claude-fable-5-1), not the catalog default row's `resolvedModel`
  (claude-sonnet-5-5).

The default row is presented through `resolvesTo`. `modelsFromCatalog` sets it
to the concrete row that shares the default's catalog `resolvedModel`. The
composer chip (`modelChipName` in `src/chat/ui.ts`) renders
"Default · <resolved row name>", and the picker hint renders
`default → <id>`. The row's `detail` and `variants` are the catalog default
row's own. After a conversation's first turn, `init` reports the real model and
the conversation's configuration follows it, so the mismatch is visible exactly
in the window where the user is choosing.

## Goals / Non-Goals

**Goals:**

- Every row the picker serves carries the window Claude Code states for it
  whenever Claude Code can state one, from the first picker read onwards.
- No conversation's model is ever touched by the read.
- A failed or slow read degrades to today's behavior and never to a missing
  catalog.

- The default row presents the model the default runs in this workspace, from
  the first picker read onwards.

**Non-Goals:**

- Tracking a settings change made while the provider is running. A session
  started after an edit to `settings.json` reports its real model at `init`, as
  today. The picker's default catches up on the next provider lifetime.
- Learning windows for user-typed ids ahead of a turn. The session report still
  covers those after their first turn.
- Persisting stated windows across hub restarts. The probe re-reads them per
  provider lifetime.
- Changing the OpenCode stack, the wire shape, or the readout's precedence
  rules.

## Decisions

### Read windows on the probe session, row by row

Once `supportedModels()` answers, the probe reads first with no `setModel` at
all. That answer is the default: its `model` is what an unpinned session runs
in this workspace, and its `maxTokens` is that model's window. The probe then
walks the rows it will serve: the catalog's concrete rows plus the
"More models" rows `withMoreModels` would append. For each row it calls
`setModel(row.value)` and then `getContextUsage({ detail: "summary" })`. The
read reuses the probe's query handle and its existing teardown, so no extra
session is spawned.

*Alternatives considered:* the Anthropic Models API (`max_input_tokens`)
answers for the API, not for Claude Code on this login. Claude Code can run a
model at a different window than the API default, and the OAuth login is not an
API key. A one-turn probe per model spends tokens and writes transcripts.
Waiting for each conversation's own report is today's behavior and the bug.

### Accept an answer only if it names the row's model

A read is kept only when the answer's `model`, with any window marker stripped,
matches the row's `resolvedModel` (or the row's `value` when the catalog gives
no resolution). This guards against a `setModel` that the CLI silently ignored,
such as a model the login cannot use. Otherwise the previous row's window would
be attributed to this one. The `default` row is exempt: its window is by
definition the window of whatever the default runs, and the answer's `model`
names that. `maxTokens` is used, with `rawMaxTokens` as the fallback, mirroring
`normalizeContextUsage`.

### The default is re-resolved from what it runs

The provider keeps `defaultRuns`, the resolved id from the first, unpinned
read. When the catalog is served, the default row is rebuilt from it:

- `resolvesTo` is the served row whose resolved id, marker-stripped, equals
  `defaultRuns`. Exact matches are preferred. Among marker variants, the row
  whose stated window equals the default's own window is preferred, so
  `fable[1m]` beats a plain `fable` row when the default runs 1M.
- `detail` and `variants` are taken from that row. The default keeps its own
  `name` ("Default (recommended)"), its `default: true`, and its selection id
  `default`, because choosing it must still leave resolution to Claude Code.
- `contextLimit` is the default's own stated window from the unpinned read.

When no served row matches, `resolvesTo` is `{ providerId: "anthropic",
modelId: defaultRuns }` and `detail` names the id. The chip falls back to
`Default · <id>` (`modelChipName` gains this branch) rather than the bare
"Default (recommended)". Effort variants stay the catalog default row's,
because nothing better is known for an unlisted model.

When the unpinned read fails, `defaultRuns` stays unset and the catalog's own
`resolvesTo` stands, which is today's behavior.

*Alternatives considered:* parsing Claude Code's settings files ourselves
re-implements its precedence (user, project, local, managed, `ANTHROPIC_MODEL`,
`--model`) and drifts. Asking the running CLI is the only answer that matches
what a session will run. Renaming the default row itself to "Fable 5.1" would
lose the "this follows Claude Code's choice" meaning that the selection id
carries.

### Stated windows and the default's resolution live in provider state, applied at serve time

The provider holds `statedWindows: Map<rowValue, number>` and `defaultRuns`.
`listModels` applies both over `withMoreModels(liveModels ?? CLAUDE_MODELS)`.
The live session's `captureModels` keeps replacing `liveModels` as it does now
but cannot erase either, because they are held separately. The "More models" `detail` text is
rebuilt from the applied window, so the picker never says "200k context" for a
row it measures at 1M.

*Alternative:* write stated windows into `liveModels` rows. That couples them
to whichever capture ran last and loses them on the next live refresh, which is
the bug in the "stated window outlives a catalog refresh" scenario.

### Hydration runs until windows are read, not only until a catalog exists

Today a live session's `captureModels` can fill `liveModels` before any picker
read, and `hydrateCatalog` then never probes. The guard becomes "the catalog or
the windows are not yet read". The probe still refreshes `liveModels` on the
way, which is harmless and current. The single-flight and failure cooldown
latch stay as they are. The cooldown applies only when the catalog itself
failed. If the catalog answered but windows failed, the probe is not retried in
a loop; the fallback stands for that provider lifetime.

### The default is read before the first answer; the windows fill in behind it

The catalog is committed as soon as `supportedModels()` answers. The unpinned
read that names what the default runs takes a few milliseconds, so hydration
waits for it, and the first model list already presents the default
correctly. The per-row walk then runs in the background on the same probe
query, which stays open until the walk ends. Each stated window is served from
the next `listModels()`. The page performs that read when the picker opens,
and the hub on every inventory read, so no push channel is needed. Until a
window lands, the corrected fallback figure stands; for today's catalog it
already matches.

Each step is bounded at 8 s, which leaves room for a slow full-id switch. The
walk as a whole is bounded at 90 s, which only stops a CLI that stalls on every
row. A row that throws or times out keeps the derived figure. Disposal ends any
step the walk is waiting on and closes the probe. `windowsSettled()` lets a
caller that needs the complete figures, such as the real-CLI test, await the
walk.

*Alternatives considered (chosen with the user):* blocking the first read on
the whole walk delays the chat's availability and the first picker open by
about 10 s. Reading only the alias rows synchronously (about 1 s) still delays
chat start, for figures the fallback already gets right.

### Fallback tables corrected, not removed

`claudeContextWindow` stays as the derived figure for unstated models. Its
tables are refreshed to the observed truth: add `claude-sonnet-5-5` and
`claude-opus-5-5` at 1M, move `claude-sonnet-5` to 1M and the "More models"
`claude-opus-4-7` to 1M, and update the header comments. The static catalog
rows stay as a picker for an install that cannot answer.

## Risks / Trade-offs

- [An older CLI ignores `detail: "summary"` and runs `full`, making token-count
  API calls of about 500 ms per row] → The overall 8 s budget caps it. Rows not
  reached keep the derived figure. Token counting spends no tokens.
- [A CLI without `setModel` or `getContextUsage` on the handle] → Skip the walk.
  Today's behavior stands.
- [Stated windows go stale if the login's plan changes mid-lifetime] → The
  session's own report still wins in the readout. A hub restart re-reads them.
- [A conversation opened in the first seconds is measured against a fallback
  figure] → The fallback is corrected for today's catalog. The session's own
  report wins after its first turn. The next model-list read serves the stated
  window.
- [The probe process lives about 6–11 s longer than before] → It is
  promptless and transcript-free, and disposal ends it. One extra CLI process
  per workspace for a few seconds after the first chat read.
- [The answer's `model` spelling differs from `resolvedModel` (date suffix,
  provider prefix)] → Compare with the window marker stripped. A mismatch only
  costs that row its stated window, never a wrong one. For the default, a
  mismatch names the default by its raw id, which is still true.
- [The probe runs in the workspace cwd, but a user's terminal session elsewhere
  could resolve differently] → What matters is what a uatu conversation in this
  workspace runs, and that uses the same cwd and settings as the probe.

## Migration Plan

Ships in one change. No persisted state or wire changes. Rolling back restores
the derived figures.
