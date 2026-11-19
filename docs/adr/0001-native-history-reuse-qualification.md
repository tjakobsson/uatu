---
status: accepted
---

# Qualify native-history reuse in one OpenCode v2 module

Native history can be retained before a worker reader captures observation counters, so those later counters cannot make an already contradicted transcript safe to reuse. One OpenCode-v2-local native-history module owns complete-history reads and the inbox/record observations that qualify pending and installed reuse; its interface hides mutable qualification metadata while the existing shared storage helper keeps retention and cancellation mechanics. Contradictory native observations may deny reuse regardless of request start order, but cannot replace history as newer truth or grant outcome, ownership, activity or Stop authority.

## Consequences

- Retired loads still finish for existing waiters but cannot install. Only a later independent reader may reload; counterproof itself starts no I/O or automatic recovery retry.
- A reload that changes an observation counter must withhold its inferred outcome. A separately initiated quiet read can recover the terminal outcome without changing native payloads or weakening identity/source-guard/Stop checks.
- Replace scattered provider qualification rather than maintain two policy paths. Keep the shared helper interface, other providers, retention limits, stream/reconnect behavior, freshness scope and error behavior unchanged apart from the approved reload policy.
- Test qualification through the module interface and retain public worker-authority checks. Read-count expectations may change only where the new denial policy requires independent reloads; coalescing, cancellation and bounded-read assertions remain meaningful.

## Amendment: records observed before cache registration

A staged record can complete before any reuse entry exists, followed by a clear
while an old transcript response is pending. Entry-local visibility alone loses
that transition. The approved extension captures a bounded, deny-only snapshot
of an already-known record in the existing session-observation store; the reuse
entry owns its snapshot, not a second visibility ledger or event clock. The
snapshot must fail closed on eviction/recreation without pinning cache entries
or granting authority. History/inbox/activity observations do not become record
changes merely because they share that store.

Changed same-session records may conservatively deny reuse even if the final
transcript is unchanged. A clear committing removed content and a clear retaining
that content are indistinguishable until a later independent read. Both may
therefore require that read; no-crossing and identical-record controls retain
reuse. This read-count trade-off was explicitly approved without weakening
outcome, identity, source-guard, Stop or no-automatic-retry assertions.

## Recovery contract clarification — 2026-11-17

Complete the existing v2-local module with bounded, deny-only knowledge from the existing same-session record store; do not introduce a second ledger/cache, chronology engine or automatic retry. Keep retired-start admission corrections local to execution evidence, with outcome counters, activity, ownership and Stop authorization separate from reuse qualification.

Cache retirement grants no authority. A later independent current read may earn existing Stop eligibility only from its own qualified evidence, without restoring revoked eligibility through retired starts, replays or reconnect gaps. Performing Stop still requires separate fresh authorization.

Withholding follows the changing observation window, not a numbered call. If another consumer observes the change first, a later independent quiet read may recover completion; preserve initial withholding/nondismissibility, exact execution identity, no invented reports and the scenario's independent Stop safeguards.

These are agreed planning clarifications, not verification of the archived candidate or permission to restore it, change source/tests, publish, merge or deploy. Reproduce current evidence provenance before changing disputed assertions.
