## Status

**Combined direction approved; implementation in progress.** The pre-change
baseline uses recovery logic from `f3efee657ca293670ec9b3fbc895e33f81a89fbb`
with the separately approved injectable adapter scheduler. After the actual-session
diagnosis, the user approved the combined attribution-regression and counter-safety
direction with “Great lets implement this”. Final verification remains required.

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
5. **Withhold stale dismissal proof too.** The Unresolved fallback must not inherit
   dismissibility from the discarded inference. Current `workerDismissalEvidence`
   allows running/Unavailable and running/Ended rows to be dismissible; changing
   terminal status alone is insufficient. Carry the withholding decision into
   authoritative compact evidence without weakening Stop or independently
   verified evidence.
   The user separately approved optional `outcomeWithheld` on the closed public
   worker row, workspace API revision 38 and strict-client migration guidance.
   True denies dismissal; actual fresh terminal evidence can clear it. This does
   not change Hub authentication, saved-dismissal format or Stop authority.
6. **Replace, do not layer.** After approval remove the outcome-specific request
   chronology/owner routing, overlap exceptions, provisional stage transitions
   and source-specific report/visibility counterproof that this rule replaces.
   Keep bounded execution/ownership/replay evidence needed for activity and Stop.
   Do not reset a counter while an active recovery references it.

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

No stored-data migration is proposed. Archive before merge; PR merge and deployment
still require separate authorization.
