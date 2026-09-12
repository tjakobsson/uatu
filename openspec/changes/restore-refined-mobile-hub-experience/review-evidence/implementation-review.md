# Implementation review — reconciliation and historical findings

> Start with the [current evidence index](README.md) and [current verification](verification.md). Status and generated-artifact paths below are historical at pre-cleanup commit `373ef6350032f6a0f2a91c2037ebafb553bc002f`; they do not assert fresh passes or close pending gates.

## Current disposition — 2026-09-10

The interface refinements below were **approved and implemented**, not left as
proposals. `readCredentialFacts` supplies explicit protection/lock/OpenPGP user
ID; `readToolConfiguration` separates saved override from effective path.
`CloneSubmissionIntent.attemptId` and `reconcileCloneAttempt` provide owner-bound
accepted/pending/not-accepted/expired results and non-secret reload hints.
Unavailable is not nonacceptance; no public/live API was changed by this seam.

All original in-scope correctness findings below have implemented corrections
and targeted synthetic browser regressions:

| Historical finding | Current regression evidence under `tests/mobile-hub-review/` |
|---|---|
| Coordinated Stop prematurely closes result/draft | `lifecycle-regression.e2e.ts`: unrelated B draft, first-stop/second-failure, successful stop/remove; `exceptional.e2e.ts`: projected dependencies and nested partial outcomes. |
| Tool Save wrong root | `credential-clone-contract.e2e.ts`: sheet-owned pending/failure, Escape and repeated activation. |
| History Return leaves secret nodes/events | `lifecycle-regression.e2e.ts`: submitted and unsubmitted secret-node clearing and late-event rejection. |
| Auth identity/generation and mutable delayed clone owner | `credential-clone-contract.e2e.ts` auth-context loss; `adversarial-lifecycle.e2e.ts` stale after-effect unauthorized cannot sign out new session; matching Stop fences old Start/read/unlock. |
| CLI-only retained auth incorrectly excluded | `credential-clone-contract.e2e.ts`: selectable retained provider token, excluded one-time clone identity. |
| Clone Send in wrong phase/uncertainty | `credential-clone-contract.e2e.ts`: non-cloning/input-response-loss fencing across replay/reload. |
| Secret remote retained before validation | Contract suite and `clone-monotonic.e2e.ts`: malformed SSH secret clearing and valid username-only SSH/SCP preservation. |
| Unknown acceptance loses uncertainty | Contract suite: response-loss/reload, held admission, unavailable, fenced nonacceptance versus expiry, fresh requires-unlock attempt; monotonic suite: old lookup cannot replace accepted progress or resurrect retired hints. |

The visual corrections include 52px WebKit Side fields, 44px management selects,
reference-sized selector/vector silhouettes, luminous Preview rim/cyan Terminal
material, Hub group rhythm and unwrapped short Settings value. Fresh/reset handle
placement was subsequently approved/calibrated; saved .72 ratios and no-op Done
are preserved. Motion/continuity and actual Chat Send/queue/cancel/new conversation,
xterm new/close and any-running-known-id cross-workspace navigation are implemented
and browser-tested. There is no provider archive/steer or terminal rename client
API to invent. Full client feature-matrix coverage remains explicitly limited.

Latest supplied lead evidence: 194 unit tests / 1471 assertions and both
typechecks; 168 Chromium/WebKit tests before final cross-workspace change;
32 crossworkspace + continuity passes after it. **Full final rerun pending lead
update.** These are scoped runs, not additive totals. See `progress.md`.

Remaining gates: approved visual goldens (7.1), exact dirty pre-change full
interior/non-regression proof (7.4), remote verification (8.1), delivered URL
handoff (8.2), human approval (8.3). Settings +7.52px rhythm and smaller optical
differences remain presented, not accepted. All E compositions, coverage gaps
and historical harness observations are enumerated in `scenario-guide.md` and
`acceptance.md`. No live integration or archive/spec sync is authorized.

## Historical static assessment — retained verbatim below

The following 2026-09-09 findings/proposals describe that earlier source state.
They are not outstanding interface decisions or a current failure inventory;
retain them as the provenance of the implemented corrections above.

2026-09-09. Static assessment of the new mobile frontend followed by execution
of current tests. Tests do not cover every finding and do not override them.
This is not visual/interaction acceptance or live-backend proof.

## Interface decisions

1. **Explicit credential/tool facts:** `PublicCredentialDto` has no protection/
   lock state or OpenPGP public user ID. `PublicToolReadinessDto` has no saved
   override separate from effective path. Current details show readiness but
   cannot initialize all states required by S03–S07. Proposed bounded change:
   enrich only the mobile seam with explicit facts, preserving/reusing domain
   DTOs; populate synthetically. Do not infer facts from prose/names or change
   public APIs, invoke tools, or implement live adapters.
2. **Unknown clone acceptance:** an indeterminate submit can lack a job ID, and
   the seam has no authoritative attempt lookup. Blocking retry and offering
   Hub inspection cannot establish whether an unregistered clone is active.
   Proposed bounded change: submission-attempt identity and reconciliation in
   the frontend seam/synthetic model, with explicit reload/retention semantics.
   Never infer safe retry from absent registration. This does not promise live
   idempotency. Reconcile planning artifacts after the user's contract decision.

## In-scope correctness findings

Paths are relative to `src/hub/mobile/`. These are static findings requiring
targeted composed tests, not all reproduced bugs yet.

| Finding/source | Bounded correction and regression |
| --- | --- |
| `frontend.ts`, `flows.ts`, `flow-ui.ts`, `coordinator.ts`: stop invalidation closes active management task before its own coordinated result arrives. | Withhold stopped workspace immediately without losing management result. Model-backed first-stop-success/second-stop-failure must preserve catalog and visible partial-failure explanation; successful stop-and-remove retains completion. |
| `credential-flows.ts`: tool save mutates underlying view, not task root. | Bind mutation/busy/error/completion to sheet; test pending, rejection, indeterminate, cancel then new task. |
| `coordinator.ts`: history Return omits `view.suspend()`. | Clear original secret input and close Hub sheet before foreground workspace; late modal events cannot change workspace foreground. |
| `frontend.ts` refresh and `clone-flow.ts` hint ownership: identity changes do not reset protected generation; delayed acceptance reads mutable user. | Bind operation to captured authenticated owner; auth-unavailable then another user cannot disclose old draft/job or store under empty/new user. |
| `credential-flows.ts` supportsRole: provider-CLI-only tokens absent from retained auth selectors. | Permit GitHub/GitLab-only retained assignments/onboarding; restrict one-time clone identity to SSH/HTTPS Git. |
| `clone-flow.ts`: Send enabled in registering/starting and after indeterminate input. | Allow only authoritative cloning phase; prevent blind duplicate input; retain reconnect/inspection. |
| `clone-flow.ts`: remote URL captured before rejecting embedded credentials. | Reject/clear embedded secret material before non-secret draft retention; Settings detour must not redisplay it. |
| `clone-flow.ts`: unknown acceptance Back says no submission; discard/reload mishandles uncertainty. | Truthful copy and unresolved-attempt ownership under chosen reconciliation contract. |

## Visual findings

See [visual/README.md](visual/README.md), [historical gallery](https://github.com/addiberra/uatu/blob/373ef6350032f6a0f2a91c2037ebafb553bc002f/openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual/index.html), measured
JSON and comparison images: eight states per engine at explicit 390×844 CSS.
No actual screenshots were approved as goldens.

- WebKit Side field is 23px rather than 52px, overlapping label/value.
- Preview pill retains dark `#767676` perimeter instead of subtle luminous rim.
- Workspace selector exceeds reference geometry; tune type/spacing without
  sacrificing 44px targets and enlarged-text alternatives.
- Hub groups accumulate roughly 6–10px vertical drift.
- Settings short `7 seconds` value wraps unnecessarily.
- Terminal selector needs cyan rim and unboxed terminal silhouette.

Deliberate missing-icon, flattened-heading and removed-material mutations were
detected in both engines. Full responsive/accessibility/desktop/native-inset and
current-interior non-regression evidence remains incomplete.
