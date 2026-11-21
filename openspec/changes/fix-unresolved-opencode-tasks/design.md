## Status

**Combined direction approved; implementation in progress.** The pre-change
baseline uses recovery logic from `f3efee657ca293670ec9b3fbc895e33f81a89fbb`
with the separately approved injectable adapter scheduler. After the actual-session
diagnosis, the user approved the combined attribution-regression and counter-safety
direction with “Great lets implement this”. Final verification remains required.

**Current architecture approval:** On 2026-11-15 the complete native-history
replacement design was confirmed with “Implement + ADR”. Earlier
unapproved/interface-under-discussion statements below record the interview's
history, not a remaining implementation gate. The accepted scope and trade-off
are recorded in `docs/adr/0001-native-history-reuse-qualification.md`.

### Recovery contract clarification — 2026-11-17

The continuation planning discussion confirmed the following scope and acceptance
rules. At that planning checkpoint this checkout did not include the archived
uncommitted candidate; its restoration and verification remained outstanding.
That agreement authorized planning-document updates, not restoration, source/test
changes or publication. Subsequent recovery authorization and results are tracked
separately in tasks.md.

- Complete the existing v2-local native-history module using bounded, deny-only
  knowledge from the existing same-session record store. Keep retired-start
  corrections local to execution evidence; do not add a second ledger/cache,
  chronology engine, automatic retry or broader provider extraction.
- Cache denial supplies no authority. An independent current read may earn
  existing Stop eligibility only through its own qualified launcher, ownership,
  active-execution and history evidence. Preserve revocation/reconnect safeguards;
  retired starts and replays cannot restore revoked eligibility. Stop authorization
  still requires its separate fresh revalidation.
- Withhold inferred outcomes across changing observation windows, not according
  to a numbered call. Another consumer may observe the change first; a later
  independent genuinely quiet read may recover completion. Preserve initial
  nondismissibility, exact execution identity, no invented reports and the
  scenario's no-Stop safeguard. Do not suppress consumers or alter native fixture
  facts to force an expected sequence.
- Verify current causal provenance before changing the disputed assertions.
  Reproduce introduced review defects against the exact reviewed baseline and
  retain their orderings in regression coverage. Explain duplicates or findings
  whose invariants already hold without automatically patching production.
  Pause for genuine contract conflicts or repeated failure to localize the cause.
  Preserve fresh 10,000-seed coverage and exact-head GitHub CI/Codex gates; neither
  silently waive defects nor promise clean review after an arbitrary round count.

### Historical verification evidence

The completed 1,000-ordering campaign (seeds 0–999) recorded 21 publication
failures, zero progress failures and zero harness errors. The shortest sampled
representative, seed 428, and its reduced ordering each reproduced exactly in
three fresh processes; a further independent lead replay reproduced the reduced
failure. The reduced ordering is the smallest retained successful deletion trial,
not a proof of global or one-minimality. Earlier unreplayable samples remain
unvalidated and are not combined with this campaign.

The model snapshots responses at scheduled backend arrival, not JavaScript fetch
invocation; both lie inside the native request lifetime. It uses one child, one
page and fixed ownership. Exact saved-order replay is established for the retained
representative, not seed-only stability across earlier harness/setup versions.
The fixed progress bound is four logical owned adapter-history attempts; physical
parent HTTP reads are reported separately. These model limits do not waive the
actual-session fixture or the final 10,000-ordering and full-suite gates.

### Approved verification simplification

Exact uncertainty equality required a second provider to reproduce prior reads,
cache invalidations and overlapping events. That history-aware approach exposed
provenance gaps rather than a verified gate. Its code and failed receipts remain
preserved as historical evidence, not passing results.

After questioning that complexity, the user approved removing reference-provider
history replay: “Apply it and do not stop until you have completed the
implementation.” The replacement compares each published result, native report
fields and current activity with independent cold recovery of final native state,
or requires Unresolved. Extra conservative warnings are allowed; losing a warning
required by final evidence is not. This explicitly replaces exact warning-field
equality, not result/activity correctness or production behavior.

Check authority separately: Stop and dismissal cannot be more permissive than
final evidence allows; actual consumed negative execution/revert/replay evidence
must not restore revoked Stop; `outcomeWithheld: true` always denies dismissal.
Execution ends can permit legitimate terminal dismissal, so they are not a blanket
dismissal veto. Expected facts come from raw consumed native inputs and observed
events, never actual certainty flags or private production ledgers. Keep canonical
withholding-marker wire shape checks separate; do not normalize false into absence.

The existing read-only `observeHistoryConsumption` hook identifies actual complete
arrays consumed by each public read, including shared/cache hits, without replaying
those reads into the reference provider. The fixed one-parent/child model needs
only bounded negative facts. Do not expand this into another general chronology
engine. Explicit quiet-Completed and no-negative-Working controls prevent blanket
abstention or blanket revocation from passing. An unnecessary caution warning can
now pass; that is the accepted loss of precision.

Randomized actual concurrency, independent actors across metadata awaits, native
stage/clear/commit orderings, the four-attempt progress bound, 10,000 seeds and full
CI remain required. Strict saved-trace replay checks the current model; a reduced
representative needs its own replay before being labelled verified. Earlier models
and their counts are not relabelled or compared as production-bug totals.

## Context

See proposal.md for the original motivation and retrospective provenance.
The replaced implementation distinguished outcome requests by starts/completions,
owners, consumed baselines, staged visibility and publication phase. Its outcome
transfer/revalidation machinery is removed rather than expanded. Separate activity
ordering and native ownership/replay safeguards remain.
The independent Hub deadline change is isolated in
[PR #634](https://github.com/tjakobsson/uatu/pull/634).

## Goals / Non-Goals

**Goals:** One conservative publication rule for outcomes without parent reports;
parent history completes while children stream; preserve exact execution
attribution, ownership, Stop and replay safeguards. Recover the diagnosed
missing-report/reused-child chain without cascading unresolved launch rows.

**Non-Goals:** Extracting activity recovery now;
changing explicit parent-report precedence, native activity recovery, Stop,
authentication, dismissal persistence or deployment.

## Proposed Rule

Keep a change counter per session. Any native observation that differs from the
last known state for that session bumps it, whichever request delivered it and
whenever that request started. A recovery read records the counters for its
parent and each child before its first request. An outcome with no parent report
publishes only if those counters are unchanged at publication. Otherwise drop
that one outcome and leave the row Unresolved. Do not retry and do not fail the
parent read because of it. Explicit parent reports and activity recovery are
unaffected.

## Decisions

1. **One session-local observation revision.** History, session records, pending
   inbox, active inventory and SSE update that session's known native state.
   Differing observations advance its counter even from older, ownerless or
   overlapping requests. Identical observations/replays of already-known facts
   do not. Streaming content is not exempt. Do not add request-age or per-source
   relevance exceptions.
2. **Capture before use; check at publication.** Record the parent counter before
   its first request and each discovered child's counter before its first
   request. Keep those values through asynchronous work to publication. Cached
   content cannot be relabelled as new evidence or bypass a changed revision.
3. **Omit one inference instead of restarting the read.** A mismatch withholds
   only that inferred outcome. Return ordinary parent content and independently
   supported rows. Do not start another read, wait for quiet or spend the deadline
   retrying it. Existing transport/incomplete-read failures remain separate;
   this rule does not authorize incomplete history.
4. **Preserve independent authority.** An unchanged interval is necessary, not
   sufficient: keep complete owned history, unique execution intervals, native
    identity and replay assertions. Fabricate no result ID, summary or report
    timestamp. Explicit parent reports, activity recovery and revoked Stop controls
    keep their existing rules.
    Native-only terminal inference also needs existing execution identity through
    which the adapter can revoke it. Created/completed clocks without a proven
    execution ID or alias remain Unresolved; do not invent a `ran` timestamp or
    broaden matching across executions to preserve completion.
    A newer activity-only patch is not a new terminal report: if both covered
    history sources withdraw the same report-free execution, discard its inherited
    terminal status even across a projection change fence, preserving that newer
    row's independent activity/control evidence. Explicit reports and different
    execution identities retain their protections.
5. **Withhold stale dismissal proof too.** The Unresolved fallback must not inherit
   dismissibility from the discarded inference. Current `workerDismissalEvidence`
   allows running/Unavailable and running/Ended rows to be dismissible; changing
   terminal status alone is insufficient. Carry the withholding decision into
   authoritative compact evidence without weakening Stop or independently
   verified evidence.
   The user separately approved optional `outcomeWithheld` on the closed public
   worker row, workspace API revision 38 and strict-client migration guidance.
     True denies saved dismissal; actual fresh terminal evidence can clear it. This does
    not change Hub authentication, saved-dismissal format or Stop authority.
    The adapter remembers every proven alias of a vetoed execution, up to the
    2,048-alias dismissal limit, so a partial restatement keeps the veto. Past that
    limit it fails closed: every same-scope restatement counts as the vetoed
    execution, so a disjoint one may stay non-save-dismissible and uses the
    view-only row Dismiss instead.
    Apply the inference projection before computing latest-page live membership,
    so an off-page launcher whose outcome is withheld remains visible as Unresolved.
    Older cursor pages retain their existing membership rule.
6. **Replace, do not layer.** After approval remove the outcome-specific request
   chronology/owner routing, overlap exceptions, provisional stage transitions
   and source-specific report/visibility counterproof that this rule replaces.
   Keep bounded execution/ownership/replay evidence needed for activity and Stop.
    Do not reset a counter while an active recovery references it.

Pending raw-history reuse must not import contradicted evidence before a future
worker consumer can capture counters. Record-stage or positive-inbox responses
that finish while a warm load is pending can deny its installation even if their
requests began before registration. The subsequent native-history replacement
extends denial to installed entries while keeping independent activity request
ordering unchanged. Retiring a
contradicted cache entry does not cancel its current waiter, retry that read or
grant outcome authority; a later independent read loads current native truth.

During architecture exploration on 2026-11-15, denying further history reuse
after contradictory native evidence was approved even when that observation's
request began earlier. Existing waiters still finish normally; a later independent
reader may reload. This permits scoped read-count expectation changes, not weaker
outcome, activity, ownership or Stop assertions, automatic recovery retries, or
positive authority for the contradictory reply.

The confirmed module scope is one provider-local module owning
the full raw-history reuse lifecycle, including pending/installed qualification,
retirement and protection against late installation. Existing bounded storage
mechanics can remain inside that module. Worker outcome attribution, activity,
ownership, Stop and dismissal authority stay separate.

The confirmed strategy is replacement rather than parallel policy paths: move scattered
reuse qualification into the deepened module and remove superseded branches.
Retention limits, shared-read cancellation and stream behavior remain the baseline;
this is not approval to add a second cache or a compatibility path.

The confirmed compatibility envelope is OpenCode-v2-local. Keep the shared
HistoryReuse interface and other providers unchanged. Preserve retention limits,
collective cancellation, stream-generation/reconnect behavior, current freshness
invalidation scope and error behavior except for the approved contradictory-
evidence reload policy. One reconnect change is approved by the maintainer's
review of PR #625 and narrows task 5.54: the next subscription replaces a
saturated worker ledger instead of keeping it recovery-only until disposal.
Scoped recovery reads supply authority from then on, and only workers born after
the observation gap can gain Stop. The same review keeps top-level
conversations out of both ledgers: execution boundaries enter them only for
known or possible workers. Other sessions' boundaries stay in a bounded
pre-ownership store (4,096 sessions, 1 MiB) in the ledger's own form, readable
by cold recovery and moved into the ledger when the session becomes a worker,
including through a history reconciliation's ownership verification. A boundary
without a usable proof is kept as an unknown count for Stop admission. The store survives ordinary
reconnects. Overflow, by bytes or session count, first compacts sessions to
unknown markers; only a dropped marker sets the loss flag, which persists until
the ledger is replaced and fails closed for agent workers without a birth
observed in the current subscription (see ADR 0001).

The selected direction is native-history access. Complete-history reads
share one v2-local module with the native inbox and record observations needed
to qualify reuse, so qualification runs at native completion before results return
to callers. Keep the interface narrow rather than decorating the entire SDK or
introducing a typed-operation protocol/private event clock. Existing outcome and
activity ordering and authority remain outside. The implemented interface is
`complete`, `inbox`, `records`, `invalidate` and `dispose`; it exposes no mutable
qualification metadata or worker-source ownership.

The confirmed test surface moves reuse-policy scenarios to the new
module interface rather than duplicating their full matrix at provider level.
Retain public worker outcome/authority checks and meaningful coalescing,
cancellation, bounded-read and no-counterproof-I/O assertions. Change reuse-count
expectations only where the approved denial policy requires an independent
reload; investigate the disputed Failed-versus-Running fixture causally instead
of weakening it. Keep the existing seed and GitHub CI/Codex acceptance gates.

The isolated diagnostic confirmed the outcome timing conflict without changing
native payloads: a delayed older Succeeded reply retires reuse and advances the
child observation counter; the independent reload returns native Failed but
changes that counter inside its capture window, so it must withhold. A later
independently initiated quiet read returns Failed. The explicit approval covers
asserting full nondismissible Unresolved on that reload and retaining final Failed
on the separate quiet read, with identity/source-guard/Stop assertions preserved.
Do not move captures, ignore differing older observations, fabricate new mock data
or automatically retry to obtain immediate Failed.

The subsequent current-head Codex finding exposed a stage completed before any
warm entry exists, followed by clear/commit during the raw load. An exact-base
runtime comparison established introduced unsafe terminal publication: the base
remains Running/nondismissible while this PR publishes Completed/dismissible.
The approved amendment captures an already-known same-session record snapshot
from the existing observation store into entry-local qualification, with no
second ledger, new clock, pin leak, positive authority or automatic IO. Changed
records may conservatively deny reuse; missing/recreated observation state must
not silently appear unchanged. The indistinguishable crossing-clear quiet case
may require an independent reload, while no-crossing/identical observations
retain reuse. Identity, outcome, source-guard and Stop assertions remain strict.
The same deny-only snapshot carries a positive inbox read completed before
registration. Its report facts live in the SessionChanges inbox facet, an
approved, bounded, request-ordered amendment to that store's digests-only rule.
If that known report disappears (delivery, eviction or overflow) while the
transcript lacks it, the pending or installed entry is retired; it grants no
report, activity or authority.

## Workers list: one Dismiss action

The Workers list distinguishes the state of the work from whether its row is
shown. Verified Working and Needs your answer stay visible, even with a matching
saved dismissal or a previous view-only clear. Checking stays visible during the
existing bounded check unless the user already cleared that row from the current
view; unavailable evidence does not count as completion.
A window that expires without a result restores each row's pre-check evidence,
so Checking and its deadline never make a row save-eligible.
Known limit (pre-existing, deferred): any read that omits a Session active row
and completes outside its Checking window, whether a later retry in the same
recovery cycle or a late first read that finishes after the window has restored
the row, still unverifies it to Status unavailable, which the existing evidence
policy treats as save-eligible.
The provider still owns the existing eligibility and fresh revalidation for Stop.
Clicking Stop does not itself mark work Stopped.

Session active with the task unverified, Status unavailable, and Ended with
the result unavailable offer a row Dismiss. Known final results (Finished,
Failed, Stopped) keep compact rows without one. Use existing
saved dismissal handling when an exact eligible execution can be submitted for
authoritative verification. A withheld outcome, indeterminate eligibility, or
missing execution identity cannot create a saved mark. For those rows, Dismiss
clears only the currently displayed row in memory, without a dismissal write.
A failed or rejected saved dismissal remains a failure, not a fallback success.
The existing bulk **Dismiss finished** action stays limited to finished rows
and remains their only dismissal.

The temporary clear belongs to the current conversation view, not a durable
execution identity. It follows the row's task (row id, task id and type, child
session, launch call), its native references once known (an OpenCode shell's
native shell id, a result notification, a launch reference, the launch time,
so a reused launcher's later launch shows again) and its
provider-proven execution ids, not the item object. An active parent replaces that object for Checking, its restore and
other field churn; those keep the row cleared. Ids that overlap the clear's
(as saved marks match) are the same execution and join its set, so a chain of
overlapping restatements stays cleared; past the dismissal alias limit the
clear ends. Refresh, a new view, disappearance, a different task or execution
(ids disjoint from that set), a newly proven or lost execution,
another unresolved state such as Session active becoming Status unavailable, or
a known final result shows it again. A new observation of verified activity
always shows the row and ends the temporary clear. Dismiss does not alter task state, native
history, or Stop. Alias retention in authoritative dismissal evidence is a
separate fix (task 8.5); the view-only action does not replace it.

## Actual-session Attribution Acceptance

Read-only inspection of this conversation found a concrete chain: one launch has
a uniquely bounded native `succeeded` idle but no parent completion report. Two
later runs of the same child have explicit completion reports. In the installed
`52aca77` fold, the first launch remains running and competes with subsequent
launches when each report arrives. Reports become separate completed rows while
the launch rows accumulate as Unresolved. An isolated fold replay reproduced the
first eight row names in the screenshot, not its complete 36/11 count.

Add a sanitized fixture through the public provider history/reconciliation
interface. Require one canonical finished row per uniquely attributable run,
preserve the later explicit report IDs/summaries, and invent no report fields for
the first native-only outcome. A missing earlier report must not make every later
distinct execution ambiguous. Use owned native execution/admission boundaries,
not description matching or aggregate child success. Genuine overlap, unknown
clocks, changed ownership and hidden competing launches remain conservative.

Independent review rejected an initial two-idle-boundary exclusion: stored
synthetic report timestamps are delivery clocks, so a delayed older report can
arrive after later executions. Delivery time cannot identify which run produced
that report. The user approved replacing that exclusion with a unique exact
match to a terminal child assistant response within a proven execution interval.
Missing, repeated or ambiguous response matches do not authorize correlation.
Complete owned child history and all competing admissions remain required; this
is response evidence plus execution identity, not fuzzy summary/name matching.

Additional read-only inspection found 63 of 64 reports in the selected reused
child matched an assistant response exactly, including the two named reported
runs. Each selected response is a single text part with native terminal `stop`
and completion clocks before its enclosing idle. Fixtures use sanitized text and
must include this actual evidence shape, plus genuinely delayed delivery and
duplicate-response controls. No report timestamp is rewritten to execution time.

The counter rule protects publication freshness; it does not replace attribution.
The fixture must pass on the resulting implementation, including quiet recovery
after an initial observational pass. A counter mismatch does not authorize an
automatic retry merely to make this fixture pass. Actual native records remain
unchanged; private conversation text is not copied into committed fixtures.

## Risks / Trade-offs

- **Intentional cost:** an older finished run of a resumed child stays Unresolved
  until the child is quiet. Unique attribution does not bypass a changed counter.
  The parent must also span an unchanged observation window. A separate later
  independently triggered read can recover it; this read does not retry.
- First observations and stale but different responses can withhold valid results.
  Accept these false negatives instead of reconstructing request order. Exact
  replays must remain no-ops when they add no new native fact.
- Scope counter lifetime to the provider/session and retaining reads; do not build
  an unbounded global history cache or persist counters in personal state.
- Counters see observations, not silent future changes in another process. The
  property test must state its final-state/publication admission seam, not compare
  a legitimate earlier publication with future changes.

## Hub Save Re-check

Dismissal **POST** already obtains fresh authoritative evidence, not just GET.
`handleWorkerDismissals` uses `store.withAdmission` and
`reconcile(() => deps.read(parent))`; the session route supplies a protected child
worker-evidence fetch under the workspace lifecycle lock. The store reads before
checking revisions/dismissibility and committing single or bulk mutations
(`src/hub/worker-dismissals-api.ts:101–103`, `src/hub/server.ts:1641–1660`,
`src/hub/worker-dismissals.ts:292–375`).

This does not lock the native provider process through Hub persistence. Observed
positive activity has retirement fences, but an Unresolved label alone does not
guarantee nondismissibility. Keep authenticated private scope, revision checks,
fail-closed reads and no-store behavior unchanged.

## Approval and Acceptance

1. The combined direction is approved. Complete and report the reproducible
   current-head baseline before changing recovery logic; earlier exploratory
   counts remain unvalidated.
2. Implement the counter rule and the actual-session attribution acceptance,
   delete replaced ordering state and keep existing Stop, ownership and replay
   assertions. Keep independent activity's request-order protection separate from
   observation-order outcome counters; restore any activity protection lost in
   that replacement.
3. Require the property test to pass at least 10,000 seeds, including publication
   correctness/dismissibility and a fixed attempt bound during streaming, together
   with `bun run test:ci` and the actual-session regression fixture. Use the
   approved cold final-state comparison with separate observed-evidence authority
   checks; allow only extra cautious warnings, not extra permissions.
4. Only then request Codex review. Add each finding's ordering to the property test.
   Fix failing invariants; if they hold, explain that on the thread without code
   changes. Record accepted limits in the PR body with approval.

No stored-data migration is proposed. Archive the change after merge; PR merge and deployment
still require separate authorization.
