# Personal worker dismissals

`POST /s/{workspaceId}/api/personal-worker-dismissals` accepts the existing
singleton dismiss/retire request or one explicit bulk dismissal:

```json
{
  "version": 1,
  "conversationId": "opencode:example",
  "operation": "dismiss",
  "targets": [
    { "executionId": "execution:example", "expectedRevision": 0 }
  ]
}
```

Use exact IDs and revisions from the authenticated personal-state read, not
child-session IDs. A batch contains 1–8192 unique targets and at most four MiB
of UTF-8 JSON. Singleton bodies remain limited to 4096 bytes. Account scope
comes from authentication; the request cannot select another account.

A successful batch reads authoritative evidence once and persists the whole
selected group atomically before responding. A stale, active or foreign target
refuses the group rather than partially dismissing it. Verified activity still
retires old marks, including activity arriving during a disk write. Abandoning the
request does not withdraw observation ownership from an already-running atomic
write; affected marks are still retired after that write publishes. Persistence
failure does not confirm success. Refetch and let the user review the current
state before retrying; do not automatically retry conditional mutations.

GET also reconciles fresh authoritative evidence. Hub admission, lifecycle and
store coordination serialize reconciliation and persistence; they do not lock
native OpenCode state across the child read and the Hub's disk write.

The response is the existing version-1 dismissal state. Private live notices
remain account-scoped invalidations, not dismissal payloads. Clients may make
one coalesced follow-up read for queued invalidations so another device's later
change is not lost.

The Hub obtains complete worker-only evidence through the internal child route
`GET /api/chat/conversations/{conversationId}/worker-evidence`, under the child's
configured base path and existing authentication. Its closed envelope contains
`version: 1`, the selected `conversationId`, `complete: true`, and `entries` of
`executionId`, `signature`, `active`, and `dismissible`. It carries no transcript
text, tool output or personal marks. The Hub rejects malformed, incomplete,
contradictory and over-capacity evidence. This is a same-build internal protocol,
not an additional public OpenAPI operation; older children must be restarted.

Current source rows are validated before normalization or id-based deduplication.
Conflicting lifecycle/occurrence/association facts refuse the read rather than
letting a terminal duplicate erase positive activity. Compatible display/clock
updates and alias-order changes are permitted; a shared child session alone
never joins execution identities. Shared aliases must also agree on known
immutable occurrence/association facts; unknown optional facts do not erase
known facts when alias groups join. Compatible legacy alias enrichment remains
supported.

Native OpenCode history can also certify an old call-scoped running/unavailable
row as an abstaining shadow of a larger canonical launcher/alias set. This
requires matching native parent/child scope, fully anchored contained aliases
and launcher sets, and compatible known generation/launch-reference facts.
Both rows must already independently permit dismissal. Positive or
nondismissible rows, conflicting terminal outcomes, same-row contradictions
and supplemental coverage gaps still refuse. This dismissal projection does
not establish worker completion or permission to Stop.

Current source activity and nondismissibility cannot be withdrawn by stale
projection rows, empty/failed recovery or weak launcher/result matching. The
compact read checks source strength again before publication. Mixed evidence
that would grant dismissal fails unavailable; a fresh current source read must
establish a settled/weaker state. Positive recovery can still enrich or
strengthen earlier observations. These strength checks grant no new Stop authority.

For OpenCode report-free historical outcomes, differing native observations
during recovery withhold only the inferred outcome, not the entire parent read.
The public worker row carries optional `outcomeWithheld: true`, is Unresolved
and cannot authorize dismissal—even when its activity is Unavailable or Ended.
Sparse updates cannot erase that barrier; fresh authoritative terminal evidence
can replace or clear it. Explicit parent reports, activity and Stop retain their
separate evidence requirements. See [the read architecture](../../docs/worker-dismissal-read-architecture.md).

This optional public row field requires workspace API revision 38. Strict
clients migrating from revision 37 must accept the boolean field and preserve
its dismissal semantics. Hub API revision 15, bundled Web revision 4 and the
version-1 personal-dismissal envelope are unchanged.

Native providers can supply complete source coverage in one read regardless of
display-history pagination. Providers without that coverage retain a bounded
twenty-page row-only fallback with retained page currentness guards. A page
carrying provenance such as association contradictions, origin/hidden-result
facts, fallback/revert relations or accounting requires complete-source coverage;
the fallback refuses it rather than silently discarding those facts. Exhaustion
also fails visibly rather than permitting a partial dismissal. Evidence/source
capacity remains 8192 and compact transport remains
bounded to four MiB. Provider history normalization can still be expensive;
bulk dismissal removes repeated per-worker reads, not that underlying cost.
