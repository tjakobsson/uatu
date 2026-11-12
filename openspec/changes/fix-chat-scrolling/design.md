## Context

See `proposal.md` for motivation and scope. This record was prepared after implementation for PR #633, against inspected HEAD `1cf9057309bce88ad07d3eb1a3079e381671b313`, with baseline spec at merge-base `1ab17f478aa99ed9215427edd255856cc40f33ff` (supplied target base: `49f9c7a48804136989e38b3381b682e1d8d09c2c`). It is not a reconstruction of prior approval or a claim of pre-implementation planning compliance.

The existing main spec already contains the PR's changed send, layout and reading contracts. Its actual-bottom-only timeline resumption conflicts with the subsequent explicit decision: “Restore 48px tolerance.” The delta retains the complete three affected requirement blocks, changes timeline arrival to 48px, and leaves independent shell arrival unchanged. This planning pass does not edit main specs.

Source inspection, not execution, establishes the following inventory:

| Area | Existing implementation and coverage to retain | Outstanding work |
| --- | --- | --- |
| Follow intent | `anchor.ts` separates upward intent, downward arrival, mutation echoes and extent clamps; `coordinated-scroll.ts` cancels on input. | Replace timeline's 0.5px arrival policy with 48px; update assertions that intentionally require actual-bottom arrival. |
| Semantic reading | `scroll-geometry.ts` resolves row/block/character geometry and `anchor.ts` falls back to row offsets. `anchor.test.ts` and early `ui.test.ts` cases cover duplicate/missing blocks, nested Markdown, rewrap and hidden activity. | Reverify on final source; no new universal layout guarantee. |
| Motion and ownership | `CoordinatedScrollOwner` combines correction/reveal, uses 240ms retargetable catch-up, and preserves elastic/fractional arrivals; `scroll-motion.ts` reads reduced motion per frame. | Retain cancellation, one-write ownership and native settling during the threshold fix. |
| Navigation and first placement | `ui.ts` saves independent parent/child anchors, tracks pending restore intent, and uses the existing cancellable owner after first-render layout; snapshot cancellation can preserve owed instant placement. | Reverify hidden/leave/resync/input races; do not add an uncancellable frame callback. |
| Loaded text and shell | CSS removes assistant prose from `content-visibility: auto`, retaining activity deferral. Shell output uses its own anchor adapter and shared coordinator. | Retain closed-tool deferral, selection/find and independent shell policy. |
| Desktop allocation | `expandedWorkBudget` uses 50%, bounded to 200–420px; `work-budget.test.ts` and `chat-desktop-reading.e2e.ts` cover allocation and controls. | Reverify short-window minima and unchanged touch allocation. |

No tests/builds were run for this planning pass. Existing test definitions and screenshots do not establish a passing final result.

Four first-round defect reports were hypotheses when this plan was drafted. Targeted failing core/rendered-UI regressions subsequently confirmed them: whole-paragraph text fingerprints lost an unchanged reading character during append plus rewrap; fractional downward movement was discarded as no movement or an echo; pinned-downward coordination bypassed shell horizontal capture; and deferred restoration overwrote newer pre-render reader intent. These remain within the existing preservation requirements. Fixes retain unique complete-prefix fingerprints across append, distinguish fractional movement from arithmetic roundoff, forward adapter observation during pinned downward progress, and retire pending restoration when live reader intent is paused. Final integrated verification remains tracked separately in `tasks.md`.

## Goals / Non-Goals

**Goals:**
- Preserve semantic reading location rather than a raw scroll offset, using stable opaque presentation keys without persisting message text.
- Keep one cancellable correction owner per scrollport; distinguish reader intent from layout, focus, correction echoes and native rebound.
- Restore asymmetric timeline intent: any deliberate upward input pauses; deliberate downward arrival within 48px resumes. Latest explicitly resumes regardless of distance.
- Keep regression work bounded and observable in controlled fixtures.

**Non-Goals:**
- No virtualization rewrite, new history fetching, new animation framework, transport changes, dependencies or compatibility expansion.
- No global scroll suppression, browser-native focus blocking or independent shell-policy change.
- No claims of physical-device Safari validation, universal paint readiness or previously executed test success.
- No implementation, main-spec synchronization, archive, evidence refresh or publication in this planning pass.

## Decisions

### 1. Preserve the coordinator as sole automatic vertical writer

Existing render, resize, reveal and follow paths converge on `CoordinatedScrollOwner`. Its frame timestamp guard and proposed-top reveal calculation avoid competing corrections. Smooth follow is a retargetable curve from the current visible position; reduced motion finishes directly. Initial/saved placement is direct, not a journey from an unrelated origin.

Retain this design rather than repeatedly calling native smooth scrolling or introducing a second layout scheduler: repeated native restarts and competing writers can countersteer during streaming. Preserve immediate wheel/touch/key cancellation and ordinary keyboard/accessibility focus reveals; a focused button is not an answer-field hold.

### 2. Restore 48px timeline arrival without weakening departure

Pending work belongs in `TimelineAnchorController` and affected tests/documentation. Its current default is 0.5px; restore 48px for parent/child timeline **downward reader arrival**, inclusive at 48px. A position outside that band remains paused. Do not apply that tolerance to upward departure, no-movement observations, restored/corrected positions or layout clamps. Latest continues to cancel pending reveals and explicitly request following.

The actual-bottom-only alternative is rejected by the explicit user decision, not by an invented historical approval. Do not widen `ShellScrollOwner`'s separate approximately-bottom policy: the old 48px default belonged to the timeline controller, not the shell adapter. Keep the coordinator's fractional/elastic arrival handling distinct from the resumption threshold; replacing every 0.5px comparison with 48 would change motion and native settling incorrectly.

Boundary regressions must include 49px, exactly 48px, a point inside the band, actual/fractional bottom, upward pause inside the band, same-position echoes, resize clamps, restored near-end anchors, and interruption of queued/in-flight Latest.

### 3. Retain semantic fallback instead of guessing identity

Existing geometry uses opaque versioned fingerprints for unchanged Markdown regions, with optional character offsets resolved afresh after DOM replacement. Leaf blocks, own inline list text and retained wrapper compatibility avoid anchoring an entire list/table/quote when earlier content changes. Duplicate, missing or unmeasurable content falls back to the item box; existing legacy anchors remain valid. Closed details descendants and nested shell output cannot become outer reading anchors, while visible summaries remain eligible.

Raw offsets alone lose words during rewrap; indexing duplicate text as if it had stable identity can restore the wrong occurrence. Retain the conservative row fallback instead. Investigate whether whole-text fingerprints are too coarse when a paragraph appends while an unchanged visible word rewraps; if confirmed, retain enough unambiguous reading identity across that append without persisting raw text or guessing duplicate identity. This does not promise to preserve a word that was removed or rewritten.

### 4. Bound ordinary row lookup; keep correctness-first fallback

Existing viewport hit testing probes at most three columns across four line bands, validates visible rows and, for a gap, one adjacent predecessor. Each read reuses measured rectangles and includes retained/preferred rows even when offscreen. Ordinary controlled fixtures budget at most four item-rectangle reads and twelve point queries per semantic measurement. These are row-lookup counters, not a bound on every Markdown range read, text traversal or fallback scan.

If hit testing is absent, occluded or inconclusive, retain the full conservative row scan instead of returning empty geometry or choosing a later narrow row. The fallback can exceed the ordinary four-read budget. Native scroll observations should perform at most one semantic measurement; deduplication of uninterrupted upward touch intent must not suppress fresh native movement, renewed gestures, direction changes or new layout work.

### 5. Keep loaded prose laid out, defer only the existing activity bodies

Normal layout for already-loaded assistant text avoids placeholder-height replacement under the reader. Preserve existing activity `content-visibility` and closed-tool deferral; do not fetch or materialize extra history. First parent/child presentation without a saved anchor crosses the render/layout boundary before instant bottom placement. Snapshot replacement retains an already owed instant placement using fresh geometry, but hiding, navigation and upward input retire stale movement. Saved anchors and ordinary updates keep atomic correction.

An empty child-loading render must not consume placement intended for the still-pending transcript. Keep that intent through hide/reopen and layout callbacks until loaded content can use it. The coordinator reports deliberate reader pause separately from ordinary changes, so layout-only corrections cannot clear pending restoration merely because its saved anchor is paused. This preserves the newer-input priority without conflating it with a pending snapshot's existing paused state.

Retaining skipped assistant bodies was cheaper for distant text but conflicted with stable loaded-text geometry. The chosen trade-off needs final long-history regression checks rather than claims based on screenshots.

### 6. Preserve measured control minima when enlarging desktop reading

Retain the existing 50% compact-desktop reserve, bounded to 200–420px, with the prior emergency floor and whole measured header/action priorities. At 720px available with fitting minima, conversation gets 360px and work gets 360px through independent scrollports. Do not achieve more reading space by shrinking Stop/composer targets, clipping headers or changing comfortable/touch allocation.

## Risks / Trade-offs

- [Restored tolerance accidentally resumes an upward reader] → Gate resumption on real downward arrival; retain input cancellation, echo/clamp guards and near-end restore tests.
- [Tolerance conflated with native settling epsilon] → Change timeline policy narrowly; retain fractional and elastic unit regressions and coordinator ownership budgets.
- [Ordinary-row work appears bounded while fallback or a huge message remains expensive] → Report counters with their scope; verify fallback correctness separately and retain long-history responsiveness coverage.
- [Opaque content keys become ambiguous after replacement] → Fall back to item geometry; do not persist raw text or guess duplicate occurrence identity.
- [Normal assistant layout raises long-history layout cost] → Run loaded-text/history/follow performance fixtures before acceptance; preserve closed activity deferral.
- [Reported fractional-arrival, diagonal-shell or pre-render intent race is confirmed] → Add the focused reproducer first; preserve real fractional reader movement, horizontal capture and newer input priority without weakening echo, clamp or stale-work guards.
- [Synthetic evidence masks browser/device behavior] → Use existing Chromium/WebKit fixture coverage and clearly label remaining physical-device limitations. Existing screenshot handoffs are not proof of final-source behavior.
- [Retrospective artifacts look like process compliance] → Label provenance here and in proposal/tasks; distinguish source present from verified completion.

## Migration Plan

No data migration or deployment is needed for planning. After explicit authorization to apply: make the narrow threshold/test/documentation change, verify preserved contracts on the final source, and reconcile the main spec with this delta. Preserve existing client-local anchor compatibility. A rollback should target the new threshold change without discarding unrelated scrolling fixes; re-run affected acceptance checks. Sync/archive only after final verification and the appropriate authorization, without claiming the missing original planning step occurred.
