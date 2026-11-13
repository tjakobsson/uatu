# Proposal

## Why

Completed OpenCode V2 workers can remain unknown after history recovery when several launches reuse one child session ([#555](https://github.com/tjakobsson/uatu/issues/555)). Recovery applies later idle boundaries before grouping earlier launcher aliases, leaving explicit completion reports unable to select an occurrence.

## What Changes

- Reconstruct verified historical execution intervals before applying later-idle uncertainty to unresolved work.
- Correlate same-interval launcher aliases with their explicit completion report while keeping separate runs distinct.
- Retain uncertainty for insufficient or ambiguous evidence and preserve existing Stop authorization rules.
- Add provider-level regressions for reused children, missing or tied clocks, delayed reports, and duplicate results.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. This corrects the implementation of existing `opencode-chat` lifecycle, notification-correlation, and recovery requirements. `skip_specs: true` avoids inventing a contract change for an implementation defect.

## Impact

- `src/chat/opencode/v2/background.ts`, `provider.ts`, and colocated provider tests; `ARCHITECTURE.md` documents the history-fold boundary.
- No API, dependency, configuration, stored-data, or frontend layout changes.
- Related: #457 describes background lifecycle behavior; #552 is a distinct lookup defect already addressed by #558. No claim to resolve #522 navigation failures or the separately observed unknown shell rows.
- This tracking record was added after the diagnostic implementation; prospective OpenSpec planning was omitted. Verification and review completion are recorded in `tasks.md`.
- During review of #559, the user accepted this disclosed, one-time planning-order deviation with truthful remediation documentation. That acceptance does not retroactively make this record prospective or waive future planning: the recovery-edges correction and the later interval-supersession correction were each planned before their implementation.
