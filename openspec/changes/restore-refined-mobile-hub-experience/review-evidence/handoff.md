# Frontend review handoff — phone access confirmed, approval pending

> Start with the [current evidence index](README.md) and [current verification](verification.md). Status and generated-artifact paths below are historical at pre-cleanup commit `373ef6350032f6a0f2a91c2037ebafb553bc002f`; they do not assert fresh passes or close pending gates.

2026-09-10. **Mock backend; do not enter real credentials.** Actual frontend,
synthetic management/Chat/Terminal protocols only. This is neither live-backend
validation nor visual/interaction approval. No archive/spec sync or live rollout
is authorized by these documents or tests.

## Local review access (historical phone connectivity confirmed 2026-09-10)

Privacy cleanup: private review access details and machine-specific exposure
commands have been removed from these review documents. Edited documents are
not byte-identical to their original captures; historical results, fingerprints
and approval gates remain historical records, not fresh verification.

**Current candidate:** [creation exit, Session Security and preview recovery](navigation-recovery/verification.md).
Cancel creation returns to Add Workspace; Devices is inside Session Security.
Open Atlas → Files → examples → operations to try mixed-format sibling arrows,
or START-HERE.md for the linked preview tour. Workspace visuals/chrome remain
unchanged; functional boot and nested-task history corrections are verified.
Interactive reference: `/review/design-system`; guide: `/review/design-system/guide`.
The checkpoint `b5d5f30` is the last requested commit/push. Direct actions,
single Devices entry, deliberate field entry and cold-loading safeguards remain.
No visual approval or verification waiver is inferred; older captures are historical.

- Local-only reviewer: `http://127.0.0.1:4703` when explicitly started.
  Product `/`, separate controller `/review/controller`, evidence `/review/evidence`.
- Simulation login: **reviewer / review-only**. Use only disposable opaque key,
  token/passphrase text and harmless Chat Files; never personal secrets.
- Historically, the user confirmed **“It opens”** on their phone, explicitly as
  connectivity only, not visual approval. Other services were unchanged. The
  self-TLS timeout on both the review and existing HTTPS endpoint remains a
  historical local diagnostic limit, not a current remote-access claim.

| Served-version field | Status |
|---|---|
| Source version / dirty-tree description | Uncommitted implementation atop preserved dirty baseline; fingerprint identifies served frontend bytes, not a clean Git revision. |
| Frontend content fingerprint (`sha256:…`) | `sha256:dc2b6253b6434c9bb194ef49e58ccbfff7c2080f64da27acb96199db3177b996` |
| Instance id / owned PID | Use `bun tests/mobile-hub-review/manage.ts status` for the current owned process and instance; they change on scoped restart. |
| Evidence manifest hash/snapshot time | Served `/review/evidence/manifest.json` records snapshot time and per-file SHA-256; it is separate from frontend fingerprint and approval. |
| Earlier local HTTP / SSE / WebSocket | Historical two-engine `served-smoke.ts` pass; not a fresh transport matrix for the picker candidate. |
| Remote HTTPS / phone | User confirmed Workspaces opens on the phone on 2026-09-10. No physical interaction/accessibility or visual approval inferred. |
| Earlier pre-correction full matrix | **172 passed**, Chromium/WebKit, before the iOS correction; not a pass for the current candidate. |
| Current candidate verification | **437 tests / 5151 assertions**, both typechecks pass; focused recovery/flow/preview **48/48** Chromium/WebKit, boundary **4/4** Chromium/WebKit, normal E2E preview regression **9/9** Chromium. Broader current full-app integration remains incomplete. |
| User visual/interaction decision and explicit exceptions | **AWAITING USER REVIEW** |

Content fingerprint identifies served asset bytes, not Git cleanliness or user
acceptance. Evidence is captured into the launch snapshot; restart after any
intended source/evidence change and record the new identity before approval.

## Scoped lifecycle

From repository root, after E2E releases 4703 and lead checks existing listeners:

```sh
bun tests/mobile-hub-review/manage.ts start
bun tests/mobile-hub-review/manage.ts status
bun tests/mobile-hub-review/manage.ts reset
bun tests/mobile-hub-review/manage.ts stop
bun tests/mobile-hub-review/manage.ts restart
```

Start defaults to local-only `127.0.0.1:4703`, with no default remote origin.
An unconfigured restart preserves the verified instance's existing port and
optional origin; it does not silently change an existing remote setup. Manager verifies ownership,
startup identity and fingerprint; do not use generic process kills or overwrite
stale runtime records. Reset affects only this synthetic model, not live state.
An optional public origin requires explicit local runtime configuration; no
private or default remote origin is published here. Leave other services and
proxy mappings untouched. See `tests/mobile-hub-review/hosting.md` for origin/host checks,
allowlisted evidence and lifecycle failure handling. This handoff does not
itself authorize live integration or changes to the other endpoints.

## What to review

1. [Complete scenario guide](scenario-guide.md): all H01–W03 and R01–R11,
   nine actual controller fixtures, JSON controls, credential/onboarding and
   exceptional flows, same-workspace continuity versus cross-workspace boundary.
2. [Latest visual evidence](visual/review-ready/README.md): 50 reference/actual
   comparisons, overlays/differences and six unpictured extensions. Earlier
   initial/corrected evidence and 400-file preservation record are retained.
   The hosted gallery renders selected PNGs; original HTML reports are inert
   source, not an executable published report or arbitrary directory listing.
3. [Responsive report](responsive/README.md), [motion](motion/README.md) and
   [fresh/reset placement](motion/default-placement.md), [isolation](isolation/README.md).
4. [Implementation review reconciliation](implementation-review.md),
   [verification/progress](progress.md), [acceptance record](acceptance.md).

The explicit facts and attempt-reconciliation seam are approved **and implemented**
with regressions, not pending proposals. Older README/static-review counts and
“remaining browser matrix” entries describe earlier checkpoints. Latest scoped
lead results: **202 unit tests / 1602 assertions**, both typechecks; **172 browser
tests** passed in Chromium/WebKit after final cross-workspace expansion.
Responsive: **1102 pass, 0 fail, 0 untested, 1 unsupported**
(WebKit reduced transparency). These counts are separate runs, not additive.

## Open review items / stop boundary

- Every unpictured grouped detail/task-sheet family and destructive confirmation
  needs user review. No omission or exception has been accepted implicitly.
- Settings rhythm **+7.52px**, small icon/font/material/dock differences, visible
  focus and documented fixture/interior substitutions remain optical review items.
- Reference/measured regression guards exist, but **approved pixel goldens do
  not** (7.1). Exact dirty pre-change all-four-interior/non-regression proof remains
  incomplete (7.4): only aggregate baseline, current Preview exact comparison,
  earlier upper Terminal comparison and scoped desktop/native-web observations.
- Physical keyboard/Dynamic Type/VoiceOver/native SwiftUI/live backend and full
  document/provider capability matrix are not certified. See guide for explicit
  search/diff/provider/terminal limitations and historical harness observations.
- 8.1 phone access is confirmed; 8.2 URL handoff is delivered;
  **8.3 waits only for the user's explicit served-version approval**. Stop there.
  Even approval requires separately authorized live integration tasks before
  real API/security/routing work, production rollout, spec sync or archive.
