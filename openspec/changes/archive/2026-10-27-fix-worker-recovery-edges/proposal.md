# Proposal

## Why

Two additional recovery defects can keep provably running or completed workers unknown: a transient failure in the first live inventory prevents successful retries from admitting an unchanged worker, and interleaved native tool-input/execution order prevents same-run launcher aliasing. Both reproduce through the real provider seam on the #559 branch.

## What Changes

- Compare verified historical execution intervals without assuming tool-content order matches native execution-clock order.
- Keep a partially failed initial inventory eligible for evidence-backed recovery without disabling healthy sibling workers or clearing revocations.
- Add permanent positive and negative regressions before correcting either path.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. Existing `opencode-chat` requirements already require one correlated result per confirmed occurrence and clearing uncertainty after successful reconciliation. This corrects implementation defects; `skip_specs: true` records that no normative contract changes.

## Impact

- Provider recovery/accounting, historical alias grouping, colocated tests, and the affected architecture notes.
- No API, stored-data, dependency, provider-configuration, or live-service changes.
- Missing or tied execution evidence, observation gaps, capacity closure, and retained revocations remain conservative. Notification-first multi-alias histories with unestablished production reachability remain outside this correction.
- This proposal, design, and task list were written before the recovery-edge implementation. Unlike the initial history-correlation record, this correction followed prospective planning; the user's accepted one-time deviation for the initial fix does not apply here or to future work.
