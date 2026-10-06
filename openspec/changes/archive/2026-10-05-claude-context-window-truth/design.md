## Context

See `proposal.md` for the reported failure and scope. Investigation used main
`6ee68368`, matching remote main, CLI 2.1.281, and SDK 0.3.286. Direct
promptless summary reads for `opus` and `claude-opus-5-5` both returned
`maxTokens: 1000000` and `rawMaxTokens: 1000000`. Uatu's provider also served
1M for Opus 5.5 on its initial and settled catalog reads. The original
session's 200k has not been reproduced.

The remaining paths are identifiable in current code:

- `readStatedWindows` updates provider maps without notifying browsers and
  puts a row in `probedRows` before its read succeeds.
- `servedModels` preserves those maps across catalog replacement, but the
  wire carries only `contextLimit`, losing the distinction between a guess
  and an observation.
- A conversation's own context query normally runs after `result`.
- `contextReadout` preserves a session report's window, but treats every
  catalog number as a guess.
- `syncContextIndicator` skips rendering when the source item and model
  match its previous paint, even if the denominator has changed.
- `claudeContextWindow` returns 200k for unknown ids.

The existing chat transport supports replayed data-only items such as
`context_report`, and the page has one Hub-brokered live connection.
`LatestRefresh` already guards overlapping browser catalog fetches.

## Goals / Non-Goals

**Goals:**

- Treat a limit as an observation with an owner and source, independently
  of a token count.
- Keep prompt startup bounded, preserve streaming and cancellation, and
  accept a valid delayed observation before the turn ends.
- Make replay, snapshot recovery, and normal rendering agree on the same
  latest applicable window.

**Non-Goals:**

- A new external catalog service, direct Anthropic authentication, or
  parsing Claude's settings ourselves.
- Changing Claude's compaction policy, selecting a larger-window variant
  on the user's behalf, or making a paid probe prompt.
- A new disk-backed cache of model windows across workspace-process
  restarts. Existing observations can be reused within their current
  lifetime; restart recovery can rediscover the catalog without claiming
  an old answer is newly confirmed.

## Decisions

### D1. Model a window observation separately from occupancy

Introduce a shared window observation containing a positive finite limit,
its attributed model, its source (`session`, `catalog`, or `estimate`),
freshness (`current` or `cached`), and observation identity. A reported
observation records when it was checked. Unknown is the absence of an
applicable value, never a fabricated zero or 200k.

Carry catalog provenance alongside the existing optional `contextLimit`
field. Populate it explicitly in the Claude provider. Keep the other
agents' reported limits working as reported values; omitted metadata on
older input is handled conservatively rather than silently promoted to a
newly verified Claude answer.

For conversations, use a limit-only `context_window` data item, following
the established `context_report` pattern. It travels through ordinary
upserts, replay, validation, and snapshot recovery but renders no timeline
row. Provider-held records seed recovered snapshots even if the client
missed the live update. Keep the records bounded and avoid letting them
displace message pagination or token-usage carriers. The same source
metadata qualifies windows learned from full context reports.

Do not manufacture `context_report { total: 0 }` to deliver a limit. The
summary query's `totalTokens` is not consumed by window-only discovery.
Only the normal usage/report path can replace occupancy.

Alternative: add a parallel window event, snapshot field, and recovery
channel. A data-only item uses the replay machinery already required by
context reports and makes reconnect recovery easier to test.

### D2. Scope observations to the execution that produced them

Keep an internal execution epoch for each query and applied model/window
selection. Advance it when replacing the query, changing its effective
model, or receiving an account-context change. Reads capture the query,
selection, resolved model if known, account epoch, and a read sequence.
Accept a result only while that binding remains applicable. Newer accepted
session reads can replace older reads in either direction.

Preserve selection identity, including `[1m]`, alongside the reported
wire model. A bare id alone does not distinguish two window variants.
Attribute new usage carriers and window observations to the same execution
identity, with an optional shared context key where existing model
attribution is ambiguous. Existing history without that key falls back
only to an unambiguous matching model/window observation. Staging the
next model must not change the denominator of the last model's usage.

Within a matching execution context, choose the latest applicable session
observation first, then an applicable catalog observation, then a known
estimate. Reused observations awaiting revalidation are marked cached.
An account change invalidates cross-account reuse. A new query reads its
own settings rather than inheriting a prior query's window as current.
An ordinary catalog refresh alone does not downgrade a confirmed answer.

Prompt-admission rollback restores the window binding with the prior model
configuration. Invalidate the abandoned selection's reads before restoring
the live controls, then prepare the previous binding on the surviving query.
This applies both to a rejected model switch and to later admission failures,
such as an attachment disappearing after the switch succeeded.

Keep a private cache binding with each observation: the requested selection,
actual resolved model, and the known alias/default resolution at observation
time. Unset and explicit `default` selections share an identity. Reuse a cached
observation only while that selection and known resolution still match; a
fresh query answer can replace the cached model, and usage naming another
model invalidates the cached binding before its tokens are measured. This
preserves the session's own answer over an older, unchanged catalog default.

Alternative: keep the largest number ever seen, or latch the first answer.
Both fail when Claude legitimately reports a smaller window. Wall-clock
timestamps alone also cannot reject an old request that finishes late.

### D3. Read the conversation's window before delivering its prompt

After constructing or resuming the Claude query with the selected options,
start its stream pump and request `getContextUsage({ detail: "summary" })`
before putting the first prompt on its input queue. Do not wait for `init`,
which a promptless query may not emit. Reuse the same bounded read after an
authorized model change and before its next prompt.

Use a short startup grace, initially the existing 2-second default-read
budget, separate from the existing 8-second discovery deadline. A healthy
answer is emitted before prompt delivery. If the grace expires, deliver
the prompt and leave the read eligible to report until its deadline. Its
continuation checks D2 before publishing. Never await this work inside the
stream reader, and never retire a live conversation because a metadata
read timed out.

Recheck the account epoch after the startup wait, immediately before prompt
delivery. An account change releases the old waiter and starts discovery for
the current account. All such revalidation shares one total startup grace
budget, so repeated account changes cannot keep extending prompt startup.
The wait also follows a replacement readiness promise started by the account
change, rather than treating the cancelled old waiter as current readiness.
After prompt delivery, an account change resets the binding and restarts
discovery for queries still held by live work or scheduled wakeups. An idle
query leaves revalidation to its next accepted prompt.

The startup result supplies only window metadata. A full post-turn report
still supplies the breakdown and may correct the limit. Prefer the model
named by the actual response, reconciled with the execution binding, over
blindly assigning its window to a stale remembered model.

Alternative: await the complete catalog walk before prompting. This makes
unrelated model switches part of every cold startup and still does not
prove what the actual conversation runs.

### D4. Deliver discoveries through the existing live connection

Session observations use the existing conversation replay stream. Catalog
changes emit a typed, agent-scoped catalog invalidation through the
existing workspace inventory/live transport. Extend its narrow contracts
where needed instead of disguising a catalog update as a conversation
creation or opening another EventSource.

Coalesce invalidations from the background walk. The client refreshes that
agent's banked models through `LatestRefresh`, then updates the open picker
and context indicator. A reconnect re-reads the current catalog and obtains
the conversation's retained window items in its snapshot. A refresh that
started before a newer invalidation cannot install stale data over it.

Keep received catalog revisions separate from each bank's last successfully
refreshed revision. An invalidation arriving before the initial catalog is
banked remains pending; installing that catalog starts the catch-up read.
Coalesce repeated requests for the same bank and revision, but let a newer
revision supersede a slower read. Failed or discarded reads do not acknowledge
the revision. Refreshes use the target agent's capabilities, including while
another agent is selected. Initial catalog installation also repaints the meter.

Matching invalidations received while a refresh runs coalesce into one pending
retry. The active request owns that demand, including a request started by
reconnect or picker use. On success the revision is acknowledged and no retry
is needed. On failure, replay the queued demand once if the bank and revision
are still current. A failed retry does not create another attempt without a
new invalidation. A superseded request cannot clear or restart its successor.

The Hub retains the latest complete inventory payload, including the current
catalog revision map, for synthesized opening and catch-up ticks on shared or
lingering upstreams. Coalescing retains one latest payload rather than a tick
history. Reopening the child upstream clears that payload; before its first
inventory frame, the existing bare invalidation remains the fallback.

The indicator's paint key must include the effective limit, source,
freshness, and any separately displayed boundary, in addition to usage
source and model. Invoke it on catalog installation as well as conversation
updates. Equal text-only frames still skip redundant DOM work.

Alternative: rely on opening the picker or the end-of-turn report. That is
the current delivery gap and cannot satisfy correction during a long turn.

### D5. Separate successful discovery from retry state

Replace the attempted-row latch with per-binding discovery state: pending,
confirmed, transient failure with a next-attempt time, or unsupported.
Only a valid matching answer makes a row confirmed. An explicit missing
control makes it unsupported for that CLI lifetime.

Use single-flight, bounded retries with backoff while a conversation needs
the value or the catalog discovery is active. Start with at most three
automatic retries, after 1, 5, and 30 seconds, using injectable timing for
tests. A new query or changed binding permits new discovery. Catalog reads
do not reset the backoff or create a retry storm.

A probe whose timed-out `setModel` could still complete is retired before
retrying on a fresh probe. Never switch a live conversation as a discovery
retry. Keep one active logical discovery attempt per live query. Race its
SDK request against the deadline and an invalidation signal; either releases
the in-flight slot even if the SDK request never settles. The SDK has no
cancellation method for this control, so an abandoned request may reply later,
but it has lost the race and cannot publish or clear a newer attempt. This
allows bounded retries and normal context reports to recover after a timeout.
Turn-end and on-demand full reports cancel the pending summary attempt and its
retry timer while they take over. If a report cannot confirm a window, and
its query, account, selection, and sequence are still current, return
discovery to the shared summary retry scheduler while live work holds the
query. Keep the original attempt count and backoff budget. A stale report,
an already-confirmed window, or an idle query does not rearm discovery.
Disposal cancels waiters and timers and closes owned probes. Keep failures
observable using model ids, source, phase, epoch, and failure category in the
existing diagnostic mechanism, without
logging prompts or credentials.

Catalog walks keep their promise identity until query cleanup completes.
An older walk superseded by an account change still closes its own query,
but only the current owner clears the shared walk handle and schedules retries.
`windowsSettled()` follows a replacement installed while it was waiting,
including when the caller began waiting before the account change.

Alternative: mark all failures unsupported or retry on every render.
The first loses recovery; the second multiplies processes and reads.

### D6. Make fallback certainty visible

`claudeContextWindow` returns an optional estimate. Known manifest values
and explicit window markers remain useful; an unknown id returns no
limit. Default rows follow the resolved default rather than carrying a
universal window. Rebuild "More models" descriptions from the same value
and source the meter uses.

The compact readout uses an estimated marker such as `~15%` when based on
an estimate, and the expanded view explicitly says "Estimated limit".
A cached observation is labelled "Cached limit" while it is revalidated.
With no applicable limit, show tokens used and "Limit unavailable" rather
than a bare `?`; do not paint a full-window warning. Occupancy above an
estimate disproves the estimate and takes that unknown path. A reported
boundary is not subjected to that heuristic.

The installed SDK distinguishes context-report/compaction windows from
model capacity in some outputs. Preserve an explicit distinction when
present and label a compaction boundary as such. Do not infer hard model
capacity from `maxTokens`, `rawMaxTokens`, or `autoCompactThreshold` merely
because the names look suitable. Verify their mapping against actual
responses before assigning labels. When the CLI states only one effective
window, describe it as the reported context window without inventing a
second capacity.

Alternative: silently enlarge the table to cover today's models. It fixes
one id while preserving the same failure for the next unknown id.

## Risks / Trade-offs

- [A window query delays the first prompt] Mitigate with the short startup
  grace, a late-result path, and event-driven tests for prompt delivery and
  cancellation while a read is held.
- [The original 200k is not reproduced] Keep that fact explicit. Capture
  selected/resolved ids, CLI version, window sources, discovery failures,
  and the browser's final choice when reproducing. Do not declare the
  incident reproduced merely because a mocked fallback test passes.
- [More metadata complicates replay and history] Use one data-only item
  contract, bounded provider records, and tests for projection eviction,
  reconnect, duplicate frames, and legacy history without execution keys.
- [A login or alias changes under a pending read] Bind acceptance to D2,
  invalidate cached observations on known account changes, and re-read on
  each real query startup.
- [Capacity and compaction policy are confused] Preserve explicit SDK
  distinctions, test them separately, and use a neutral effective-window
  label when the CLI cannot distinguish them.
- [Fallback labels add UI width] Test the compact indicator and expanded
  breakdown in desktop and touch layouts, using existing sizing patterns.

## Migration Plan

Ship provider metadata, validation, replay, client handling, and rendering
together. Snapshots and model rows without the new optional metadata
remain readable. Add the new data-only item and catalog invalidation to
all relevant strict unions before enabling emission. Update the published
Hub live schemas, revision declarations, contract tests, and generated
consumers wherever those DTOs cross the public live protocol. Internal
workspace-only fields follow the existing same-build client contract.

There is no new persistent cache format. Rollback removes the new runtime
metadata with the workspace process and restores the previous behavior.
Record release classification before a PR: v0.7.0 has the wrong-fallback
behavior, while the background-discovery correction was added after that
tag in #483. Use the repository's release-note discipline for the actual
user-visible delta.
