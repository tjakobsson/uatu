# Design

## Context

See `proposal.md` for the observed failure. The transient complete-history fold already reads verified child histories and processes the parent transcript in its native order. Idle records identify execution boundaries; they are not completion reports. The live control ledger separately retains authorization and revocation evidence.

## Goals / Non-Goals

**Goals:** Reconstruct historical launcher aliases without letting future idle evidence make earlier same-run launches ambiguous. Preserve distinct executions and evidence-backed settlement.

**Non-Goals:** Change live control admission, infer completion from inactivity, reorder the parent transcript, add execution identifiers, or fix unknown shell rows and unrelated navigation defects.

## Decisions

1. **Pass verified execution intervals to the transient history fold.** Complete child histories supply native idle clocks. Same-child launchers can share an unresolved occurrence only when their native start clocks are ordered and no execution boundary separates or ties them. Missing clocks or incomplete history do not prove aliasing.
2. **Apply later-idle uncertainty after grouping and explicit report correlation.** Finalize unresolved historical agent tasks as uncertain before projecting the existing control ledger. Successful settlement still requires an explicit, uniquely correlated provider result. Live normalization and retained revocations keep their existing rules.
3. **Keep parent presentation order unchanged.** A global timestamp sort would mix distinct clock semantics and could reorder tools and reports. Dropping the existing uncertainty guard would permit aliases across genuinely revoked or conflicting work; discarding idle evidence would lose execution boundaries.

## Risks / Trade-offs

- Incorrect aliasing could associate a result or control with a newer run → test intervening boundaries, delayed old results, duplicate reports, ambiguous clocks, and refusal to stop unresolved old work.
- Some unusual histories can remain unknown → preserve conservative handling for out-of-order clocks and notification-first ambiguity rather than fabricate outcomes. This is not a promise to eliminate all unknown statuses.
- Recovered history adds transient interval data → discard it with the complete-history fold; retain existing live-memory budgets and ownership checks.

## Migration Plan

No data or API migration is needed. Deploy the normal Uatu build and recover conversation history using the corrected fold. Revert the code change to roll back. This follow-up does not modify the already merged snapshot/replay and child-reader fixes in #558.
