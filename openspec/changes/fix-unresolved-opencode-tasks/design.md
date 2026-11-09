## Context

See proposal.md for motivation and retrospective provenance. The current worktree already separates worker activity from destructive controls, uses complete child history to reconstruct execution intervals, and keeps dismissal storage in the Hub. The installed client declares explicit idle outcomes; inactivity alone is not a result.

Round-one review found that a child revert processed after its history is read can escape the parent recovery's publication fences. Existing parent-only mutation invalidation is insufficient for the new outcome dependency.

## Goals / Non-Goals

**Goals:** Preserve exact execution identity, current source ownership, conservative controls, and private dismissal reconciliation while recovering genuinely attributable state.

**Non-Goals:** No global history cache, browser-authoritative dismissals, automatic mutation retries, service changes or broader concurrency redesign.

## Decisions

1. **Recover activity independently of Stop proof.** Fresh agent history may recover presentation across stream generations; destructive controls retain their live proof requirements. Reusing control authorization for activity would retain false Unresolved rows or improperly revive Stop.
2. **Attribute outcomes to strict execution intervals.** Count every potentially overlapping occurrence, including terminal competitors. Reject missing or contradictory evidence rather than infer success from absence. Preserve explicit parent reports and leave report fields absent when only a child outcome exists.
3. **Carry child-history dependencies through publication.** Extend existing source/read invalidation so observed child transcript changes revoke dependent parent results. Register dependency ownership before consuming the child read and validate it after asynchronous work through publication. Prefer bounded per-read/source dependency tracking over an unbounded global child cache or blanket invalidation of unrelated conversations. The regression must hold recovery after child evidence is consumed, process a child revert, then release publication.
4. **Align evidence deadlines without changing authority.** Keep the Hub authoritative and increase its fetch deadline to 30 seconds. Do not decouple saved marks from current evidence: stale marks could hide active work.
5. **Share test stream lifecycle locally.** Consolidate repeated connect/abort/drain ownership inside the recovery test file, without abstracting scenario assertions or changing production interfaces.

## Risks / Trade-offs

- Incorrect attribution can hide active work → retain tied/straddling/missing-clock, competing-run, ownership and concurrent-mutation tests.
- Dependency tracking could leak or over-invalidate → scope lifetime to active reads/source leases and test unrelated conversations and cleanup.
- Longer fetches occupy existing queues longer → document this unchanged architecture limitation; do not claim the timeout fix removes queue contention.
- Deterministic fixtures may miss deployment-specific failures → retain live screenshot confirmation as an unverified follow-up, not a passed acceptance check.

## Migration Plan

No data or API migration is required. After review and approval, publish the branch and PR through the normal workflow. Deployment requires separate authorization; rollback uses the previous application build without changing stored dismissal data. Synchronize capability deltas and archive the completed change before merge.
