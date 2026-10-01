## Why

The context meter for a Claude Code conversation measures against a guessed
window. Claude Code's model catalog (`supportedModels()`) carries no window
field, so UatuCode derives one from the model ids: the `[1m]` marker, else a
hand-kept figure, else 200k. The guess is wrong for most of today's catalog.
Sonnet 5.5 (now the catalog's default and its `sonnet` row), Opus 5.5 (`opus`),
Sonnet 5, and Opus 4.7 all run a 1M window and are presented as 200k. The
session's own report corrects the meter only after a live turn finishes, so the
first turn and every reopened conversation measure against the wrong window.
Past 200k occupied, a reopened conversation shows no fill at all.

Claude Code does state each model's window before any turn. On a promptless
session, `setModel(<id>)` followed by `getContextUsage({ detail: "summary" })`
answers `maxTokens` for that model in a few milliseconds, with no API call and
no tokens spent. Probed 2026-10-01 against CLI 2.1.281 / SDK 0.3.286:

| Catalog row | Reported window | Guess today |
|---|---|---|
| `sonnet` → claude-sonnet-5-5 | 1M | 200k |
| `opus` → claude-opus-5-5 | 1M | 200k |
| `claude-sonnet-5` | 1M | 200k |
| `claude-opus-4-7` | 1M | 200k |
| `claude-sonnet-4-6` | 200k | 200k |
| `haiku` | 200k | 200k |
| `fable[1m]`, `claude-fable-5` | 1M | 1M |

The figure is what this login actually gets, which no hand-kept table can know.

The same probe exposed a second discrepancy: the recommended default names the
wrong model. The catalog's default row says it resolves to Sonnet 5.5, which is
the account default. A session that pins no model, however, runs what Claude
Code's settings say. With `"model": "fable[1m]"` in `~/.claude/settings.json`,
it runs Fable 5.1. Until a conversation's first turn reports its model, the chip
reads "Default · Sonnet 5.5", the picker shows `default → sonnet` with Sonnet's
description and effort levels, and the meter uses Sonnet's window. The prompt
then runs on Fable. Project settings, `ANTHROPIC_MODEL`, and managed settings
can cause the same mismatch per workspace. The unprompted session's first
`getContextUsage`, read before any `setModel`, names the model the default
actually runs in that workspace.

## What Changes

- The catalog probe that already reads Claude Code's model list before the
  first conversation also reads each offered model's context window from Claude
  Code itself. That covers the catalog's rows, the "More models" rows, and the
  recommended default. Each row's window is what Claude Code states for it on
  this install and login.
- A window read this way survives the catalog refresh a live session performs.
  It is no longer replaced by the id-derived guess.
- The id-derived guess remains only for a model Claude Code has not stated a
  window for: an install that cannot answer, a row whose read failed, or a
  user-typed id. The hand-kept figures for Sonnet 5 and Opus 4.7 are corrected
  to the observed 1M, and Sonnet 5.5 and Opus 5.5 are added, so the fallback is
  also less wrong.
- Reading windows never switches a running conversation's model. It happens
  only on the probe's own promptless session.
- The recommended default is presented as the model it actually runs in this
  workspace, as Claude Code reports it on the probe session. That covers its
  name ("Default · Fable 5.1"), what it resolves to, its description, its
  effort levels, and its context window. It no longer follows the catalog's
  account-level `resolvedModel`. A model that no catalog row offers is named by
  its id. Like stated windows, this survives the catalog refresh a live session
  performs.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-chat`: "Models and effort levels follow Claude Code's catalog"
  now requires that each offered model's context window be the one Claude Code
  states before any turn, with the id-derived figure only as a fallback. It
  also requires that the recommended default be presented as the model it
  actually runs in the workspace, not the catalog's account-level resolution.
  "Context
  usage measures the window, not the turn's spend" now measures a first turn
  and a reopened conversation against that stated window.

## Impact

- `src/chat/claude/provider.ts`: `runCatalogProbe` / `captureModels` read
  the default's actual model and each row's window on the probe session.
  Provider-held state for both is applied whenever the catalog is served,
  including after the live session's refresh.
- `src/chat/ui.ts` / `src/chat/configuration-picker.ts`: a default whose
  resolution matches no catalog row is named by its id rather than falling back
  to "Default (recommended)".
- `src/chat/claude/models.ts`: fallback figures corrected and extended;
  `claudeContextWindow` documented as the fallback only.
- Tests: `provider.test.ts` (fake query gains `setModel` / `getContextUsage`),
  `models.test.ts`, and the real-CLI integration test.
- No wire change. `contextLimit` already exists on the chat model shape, so
  there is no API revision bump.
- The first model list is not slowed beyond one few-millisecond read for
  the default. The per-model windows take about 6–11 s, because each model
  switch costs up to about 2 s. They are read in the background on the probe
  session and served from the next model-list read, which the page makes when
  the picker opens. A failed window read leaves the catalog itself intact.
- Release notes: both the id-derived window guess and the default naming by the
  catalog's resolution are in v0.7.0, the latest stable release. This ships as a
  visible `fix(chat)`.
