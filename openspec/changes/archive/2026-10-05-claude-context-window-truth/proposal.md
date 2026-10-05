## Why

A Claude Code conversation on current edge was reported to show a 200k window for Opus 5.5, lose its percentage past 200k, and correct itself only after the turn finished. Main can discover 1M before a prompt, but still mixes estimates with confirmed limits, leaves background discoveries waiting for a browser refresh, and can skip repainting a corrected limit.

## What Changes

- Read the effective window from a conversation's own Claude query before delivering its first prompt, after applying its selected configuration. Bound the wait so a failed read cannot prevent prompting; publish a valid late answer while the turn is running.
- Carry the window's source and freshness through the provider, conversation state, and browser. A current session answer wins over a catalog answer or estimate; a newer valid session answer can correct an earlier answer in either direction.
- Keep window metadata separate from token occupancy. Discovering a limit must not replace a real usage count with a promptless estimate or zero.
- Push catalog discoveries through the existing live connection and repaint the meter when its limit or provenance changes, even if the usage message and model ID stay the same.
- Retry transient window-read failures with bounded, single-flight backoff. An attempted read is not a confirmed window.
- Remove the universal 200k fallback for unrecognized models. Label known static values as estimates, label retained older observations as cached, and show tokens used with an unavailable-limit explanation when no defensible limit exists.
- Add regression coverage for delayed answers, failed reads, stale replies, model/window-variant changes, reconnects, and a corrected limit during an unchanged usage message.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `claude-code-chat`: Strengthen window discovery, source precedence, retry behavior, and live delivery; make context-readout certainty and updates explicit.

## Impact

- Claude provider and fallback model metadata in `src/chat/claude/`, including query startup, model switching, account-change invalidation, and report normalization.
- Shared chat types, validation, adapter, replay/snapshot state, client projection, and the existing Hub live transport where window metadata and catalog invalidations travel.
- `src/chat/context-readout.ts`, the context indicator in `src/chat/ui.ts`, and picker descriptions that display context limits.
- Published live-event schemas and protocol revision metadata if their DTOs change, plus corresponding contract tests and generated consumers where required.
- Provider/readout/projection tests and focused Playwright coverage. The investigation observed CLI 2.1.281 returning 1M for both `opus` and `claude-opus-5-5`; it did not reproduce the affected session's initial 200k. Implementation must establish failing regressions for the confirmed gaps and retain enough diagnostic facts to investigate that discrepancy.
- No new external model-catalog dependency. Claude remains the primary source; fallback metadata remains explicitly provisional.
