# Design

## Context

See `proposal.md` for motivation and the retrospective planning note. The provider patch separates optional child enrichment from required parent history. The adapter uses a 25-second whole-history deadline, below the browser's ordinary 30-second read deadline; optional provider enrichment uses one second, while strict worker recovery retains five seconds.

The implementation began on `dcc486a`. During PR preparation, the user approved integrating upstream `389221a` (#572), preserving its independent activity/control evidence and contradiction handling alongside optional history enrichment. Integrated verification and fresh review must cover that combined state before publication.

Later PR review reproduced two remaining gaps: provider message coalescing let an optional caller's deadline abort a required reader, and omitted descendant links could still satisfy the accounting completeness cache. The user approved correcting both. Upstream `ffd92c36` subsequently changes only the Claude SDK lock state; its exact dependencies were restored in an isolated task-owned directory with scripts disabled, leaving shared dependencies untouched.

Round-one review found that the adapter subsequently reconstructed launcher accounting through child history without a separate deadline or cancellation signal. That path could defeat the provider's graceful degradation. The correction below bounds that work. The review also identified duplicated worker identity recipes between the worker fold and exclusion-only evidence, now shared through pure constructors.

## Goals / Non-Goals

**Goals:**
- Bound optional accounting across nested reads without publishing incomplete accounting as authoritative.
- Preserve the existing workspace, occurrence-control, stream-generation, revert, and late-result fences.
- Keep exclusion-only identities consistent with emitted worker rows without granting ownership or control authority.

**Non-Goals:**
- Faster paging, parallelization changes for performance, or a new caching policy.
- Public wire changes, dependency updates, authentication changes, or automatic service restarts.
- Claiming authenticated iPhone/SSE validation or a complete diagnosis of every symptom in issue #578.

## Decisions

### 1. Separate optional enrichment from the required transcript

Retain the provider patch's bounded optional child checks and its strict parent session/transcript failures. Unverified children cannot expose inspection or Stop targets. Partial reads remain incomplete inventory rather than evidence of completion or cancellation.

Keep native-origin revert exclusions independent of optional metadata availability: visible-prefix identities veto false exclusions, while hidden settled identities remain excludable even when child ownership cannot be read. Existing independently live detached-work handling remains authoritative.

Alternative rejected: swallowing every history failure or treating missing child rows as an empty authoritative worker list. Either would lose content or weaken control safety.

### 2. Give accounting reconstruction a bounded lifetime and late-result fences

V2 accounting reconstruction has a shared owner with a one-second deadline, independent of whole-history recovery. Its signal propagates through child paging and nested reconstruction, while an end-to-end race also releases callers of an uncooperative transport. Lifetime and existing epoch checks prevent retired reads from banking values or completeness. One caller leaving does not invalidate another caller's current work; an expired owner leaves a later read free to retry. Legacy-provider behavior is unchanged.

Parent history will retain already available accounting when enrichment cannot finish. Missing accounting remains unknown, not a zero value. Existing accounting epochs and live-arrival precedence must continue to protect newer values and evicted/reverted state.

Alternatives rejected: increasing the whole-history timeout again, which only delays failure; and racing only the caller's await while leaving an unbounded, authoritative reconstruction running underneath.

Shared provider message I/O must likewise belong to the shared operation rather than its first waiter. Each optional or required reader keeps its own cancellation window; departure retires the transport only when no current reader needs it. Owner lifetime, cache invalidation, stream generation and disposal remain bounded, and a retired owner cannot overwrite or remove a newer cached/in-flight read. Existing legacy-provider reuse behavior remains unchanged.

A successful normalized page is not necessarily complete descendant topology. The provider will carry an internal visible-enrichment incompleteness marker into accounting reconstruction. Known own accounting remains available, but any incomplete visible descendant coverage prevents the completeness stamp and permits a later parent refresh to retry. Hidden-suffix-only enrichment failures do not make the visible accounting tree incomplete. This marker stays below the public wire contract and remains separate from inbox-delivery visibility evidence.

Completeness must describe the current reconstruction, not merely the presence of an older cache stamp. If a previously complete nested tree becomes incomplete on refresh, its old completeness cannot make an ancestor appear freshly complete or delay the next retry.

### 3. Share only the native identity construction

Extract small pure constructors used by the worker fold and the exclusion-only collector. Preserve the existing string identities and validation. Candidate collection stays separate from ownership verification, worker-state folding, and Stop authorization.

Alternative rejected: running a permissive worker fold to recover exclusion identities. It would unnecessarily mix presentation evidence with control trust.

The PR review's proposed originless-row fallback is unnecessary: initial normalized insertions record an origin, and `finishHistory()` updates only already-present rows. Preserve that invariant rather than treating an unknown origin as permission to hide visible work.

A separate reproduced identity gap remains valid: a delivered result can first normalize as `notice:<messageId>` when ownership is unavailable, then normalize as a worker after ownership recovers. A later native revert must exclude the previously possible fallback notice identity as well as the current worker identity. Derive these removals from authoritative hidden native origins, retaining visible-prefix vetoes and independently live-work protections; do not infer adapter removals from ordinary page absence or grant new inspection/Stop authority. The user approved this third review correction after the section 5 fixes were published.

### 4. Verify through the existing public seams

Use `listMessages()` and `history()`, the seams already approved by the user. Extend adapter coverage to a verified child whose transcript hangs after the provider's optional check, nested accounting, cancellation/late responses, and successful later retry. Keep provider capacity, asymmetric enrichment, hidden/visible aliases, and detached-live revert tests meaningful.

## Risks / Trade-offs

- [Accounting is temporarily unavailable] → Preserve available values without inventing zero or completeness; retry on later reads.
- [Shared reads couple caller cancellation] → Give shared work a bounded owner and test concurrent callers and retired-owner retry.
- [Late results repopulate stale state] → Check lifetime and existing epoch/generation fences before banking any attribution or completeness.
- [Identity helpers drift from emitted IDs] → Use the same pure constructors and retain canonical/alias regressions.
- [Synthetic tests miss a separate live failure] → Report authenticated browser/SSE validation as unexecuted; do not restart agents or change access settings to obtain it.

## Migration Plan

No data or public interface migration is required. Complete the remaining review fixes, verification, and independent review before considering publication. Deployment or service restarts require separate user authorization. Rolling back the code does not require deleting provider history or changing authentication.
