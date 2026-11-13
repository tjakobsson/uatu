# Design

## Context

See `proposal.md` for the two reproducible failures. Native tool content is appended when input starts, while its execution clock is recorded when the tool is called; those orders can differ. Separately, a first live inventory can return uncertain rows after swallowing a failed evidence lookup, yet still mark the scope fully inventoried. Later reads then require launcher observations that a live-only stream need not repeat.

## Goals / Non-Goals

**Goals:** Recover provable same-execution aliases independent of content order, and allow a successful retry of incomplete initial evidence to restore working status and valid controls.

**Non-Goals:** Sort the parent transcript, infer completion from idleness, admit controls across an observation gap, clear unavailable-target records, weaken ownership checks, or change unrelated timing/permission tests.

## Decisions

1. **Treat distinct native start clocks as interval coordinates, not content positions.** Compare the boundaries between the earlier and later clocks while preserving tied/missing-clock ambiguity and parent presentation order. Do not simply merge every same-child launcher.
2. **Separate inventory completion from successful transport of a partial result.** An evidence lookup failure can still yield useful uncertain rows, but cannot close the initial inventory opportunity for the affected recovery. Preserve healthy sibling admission and all independent gap, capacity, ownership, and revocation fences.
3. **Preserve positive proof requirements on retry.** A retry restores working only after fresh evidence verifies the unchanged occurrence and current owner. An empty active list, failed read, or absent result cannot establish completion or authorize a newer run.

## Risks / Trade-offs

- Retry eligibility could accidentally admit a stale target → regress observation gaps, revoked/unavailable identities, changed parentage, stale results, and capacity closure; never reset those guards to obtain a green status.
- One unavailable worker could affect healthy siblings → test a mixed shell/agent inventory and retain already valid proofs.
- Reversed clocks could merge separate runs → test boundaries in both directions, tied starts, and delayed old results without reordering tools.
- Partial evidence may remain unavailable indefinitely → keep existing bounded reads and memory limits; do not add an unbounded retry queue or polling loop.

## Migration Plan

No migration is required. Deliver the corrections in #559 with the existing conservative provider contracts and revert the code changes to roll back. Running hubs and provider accounts are not modified by implementation or verification.
