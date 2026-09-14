## Why

OpenCode prices every assistant message it produces (`cost`, USD, beside the
`tokens` block we already read) and its own TUI sums that into a running
session cost. Uatu drops the figure at normalization, so an OpenCode
conversation shows tokens and window fill but never what it cost — while a
Claude Code conversation already does, through the same readout. The receiving
surface exists; only the OpenCode side is silent.

## What Changes

- The per-message usage the OpenCode adapter emits carries the message's cost
  in USD alongside its tokens, on the live stream and on a stored-history read,
  so a reopened conversation restores its cost without a live tally.
- Chat shows what an OpenCode conversation has cost so far: the composer chip
  reads "$x.xx this conversation" where the agent reports no plan windows (OpenCode
  reports none), and the readout's "This conversation" block lists the total
  and a per-model breakdown — the same block a Claude Code conversation gets.
- A subagent's row carries the subagent's cost beside its tokens, from the
  same mirrored usage.
- A conversation whose every message reports zero cost (a model OpenCode has
  no price for) shows no cost rather than "$0.00".
- **BREAKING (workspace API)**: `TokenUsage` gains an optional `costUsd`
  property. The schema is closed, so the workspace API revision is bumped
  (17 → 18) per the contract policy.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `opencode-chat`: adds a requirement that Chat reports what an OpenCode
  conversation has cost, alongside the existing "Chat reports context usage
  and subagent cost" requirement (which stays as is).

## Impact

- `src/chat/opencode/normalization.ts` — `tokensToUsage` reads `cost`;
  `storedMessageUsage` gets it for free.
- `src/chat/types.ts`, `src/chat/usage.ts`, `src/chat/validation.ts` —
  `TokenUsage.costUsd`; sums and equality account for it; wire validation
  accepts it.
- `src/chat/context-readout.ts` or a sibling — fold per-message costs into a
  `SessionTotals` on the client when no agent-emitted context report carries
  one.
- `src/chat/ui.ts`, `src/chat/composer-status.ts` — the chip and the readout
  block read from either source.
- `src/chat/timeline-renderer.ts` — subagent row shows cost when present.
- `api/openapi.yaml`, `api/contract.json`, `api/CHANGELOG.md`,
  `src/shared/version.ts` — revision bump.
- Screenshots under `openspec/changes/report-opencode-conversation-cost/screenshots/`.
