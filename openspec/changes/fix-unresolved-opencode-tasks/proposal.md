## Why

**Revision status:** The original implementation below is retrospective. The
user approved implementing the combined counter-safety and actual-session
attribution direction. The reproducible pre-change baseline is complete and the
replacement is implemented locally; final verification remains outstanding. The
independent Hub timeout change was split into merged
[PR #634](https://github.com/tjakobsson/uatu/pull/634). Activity-only extraction was
assessed but not performed. The user subsequently approved simplifying verification:
compare results/activity with final native recovery, allow extra cautious warnings,
and independently forbid unsupported Stop or dismissal authority.

OpenCode workers can remain Unresolved after reconnect, reuse, or a missing parent notification even when native evidence identifies their activity or outcome. Personal dismissal reads can also fail prematurely because the Hub's evidence deadline is shorter than the child's covered-history budget.

This change records the already implemented fixes retrospectively following review; it does not claim planning preceded implementation. Review identified child-history mutation and visibility races covered by this change.

## What Changes

- Recover verified activity after reconnect without restoring revoked Stop authority; exclude finished runs and chronologically older notifications from interference with resumed work.
- Recover explicit native child idle outcomes only for a uniquely attributable execution, without inventing a parent report or summary.
- Prevent the diagnosed missing-report/reused-child chain from accumulating unresolved launch rows and separate duplicate report rows when native execution boundaries uniquely identify the runs.
- Clear stale inventory observation clocks after disconnect. Withhold only inferred outcomes when recorded session counters change, without retrying or failing the parent history read; explicit parent reports and activity recovery stay independent.
- Allow 30 seconds for Hub evidence fetching instead of 10 seconds, accommodating the child's 25-second covered-history budget without bypassing evidence validation.
- Add public-provider and browser regressions, document dismissal ownership and limits, and consolidate duplicated test stream cleanup.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `opencode-chat`: Specify conservative activity and explicit-outcome recovery across reconnects and reused children.
- `chat-agents`: Specify publication fencing for consumed child-history evidence.
- `personal-workspace-state`: Specify evidence-fetch budget alignment while preserving authoritative reconciliation.

## Impact

Changes cover OpenCode V2 recovery, the separately split Hub deadline, tests and documentation. The user approved optional deny-only `outcomeWithheld` worker rows and workspace API revision 38, with strict-client schema migration guidance. Dependencies, authentication settings and persistent-store formats remain unchanged. The Hub remains the dismissal authority; the browser remains an in-memory projection.

## Non-goals

No browser-persistent dismissal cache, automatic dismissal replay, retry UI, lock redesign, deployment, or claim that the exact reported live failures are resolved. Ambiguous workers remain unresolved.
