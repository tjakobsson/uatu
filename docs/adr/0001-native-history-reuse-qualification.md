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
