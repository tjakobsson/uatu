# Frontend review handoff — phone access confirmed, approval pending

2026-09-10. **Mock backend; do not enter real credentials.** Actual frontend,
synthetic management/Chat/Terminal protocols only. This is neither live-backend
validation nor visual/interaction approval. No archive/spec sync or live rollout
is authorized by these documents or tests.

## Review access (delivered and phone-confirmed 2026-09-10)

**Current candidate:** [focused folder picker](folder-picker/verification.md),
building on the [shared design system](design-system.md). Folder rows navigate;
Choose selects; Add Workspace → Manage folders retains maintenance separately.
Interactive reference: `/review/design-system`; guide: `/review/design-system/guide`.
The checkpoint `c259efb` remains the last requested commit/push. Direct actions,
single Devices entry, deliberate field entry and cold-loading safeguards remain.
No visual approval or verification waiver is inferred; older captures are historical.

- Product: `[PRIVATE_REVIEW_ORIGIN_REDACTED]/`
- Separate controller: `[PRIVATE_REVIEW_ORIGIN_REDACTED]/review/controller`
- Evidence: `[PRIVATE_REVIEW_ORIGIN_REDACTED]/review/evidence`
- Simulation login: **reviewer / review-only**. Use only disposable opaque key,
  token/passphrase text and harmless Chat Files; never personal secrets.
- Loopback 4703 is running and Tailscale HTTPS 8445 is configured. Existing
  443/8443/8444 proxy mappings are unchanged. User confirmed **“It opens”** on
  their phone, explicitly as connectivity only, not visual approval. This host's
  self-TLS timeout on both 8445 and existing 443 remains a local diagnostic limit.

| Served-version field | Status |
|---|---|
| Source version / dirty-tree description | Uncommitted implementation atop preserved dirty baseline; fingerprint identifies served frontend bytes, not a clean Git revision. |
| Frontend content fingerprint (`sha256:…`) | `sha256:950c3438aa9847910394485417cf27e112eb80241ed4be887f4b8265e7fc86bc` |
| Instance id / owned PID | Use `bun tests/mobile-hub-review/manage.ts status` for the current owned process and instance; they change on scoped restart. |
| Evidence manifest hash/snapshot time | Served `/review/evidence/manifest.json` records snapshot time and per-file SHA-256; it is separate from frontend fingerprint and approval. |
| Earlier local HTTP / SSE / WebSocket | Historical two-engine `served-smoke.ts` pass; not a fresh transport matrix for the picker candidate. |
| Remote HTTPS / phone | User confirmed Workspaces opens on the phone on 2026-09-10. No physical interaction/accessibility or visual approval inferred. |
| Earlier pre-correction full matrix | **172 passed**, Chromium/WebKit, before the iOS correction; not a pass for the current candidate. |
| Current candidate verification | **384 tests / 3772 assertions**, both typechecks pass; focused picker **10/10** Chromium/WebKit and reference **2/2** Chromium. Broader current cross-engine integration remains incomplete. |
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

Start/restart default to loopback **4703** and the exact public origin above;
restart requires a verified existing instance. Manager verifies ownership,
startup identity and fingerprint; do not use generic process kills or overwrite
stale runtime records. Reset affects only this synthetic model, not live state.
Tailscale configuration was added after inspecting existing mappings. Restore
only this endpoint after stopping exposure, or remove only it:

```sh
tailscale serve --bg --https=8445 http://127.0.0.1:4703
tailscale serve --https=8445 off
```

Never `tailscale serve reset`; leave existing **4700/443, 4701/8443, 4702/8444**
untouched. See `tests/mobile-hub-review/hosting.md` for exact origin/host checks,
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

> Privacy redaction: concrete private review endpoints have been removed; the placeholders above are not live URLs. Historical measurements and outcomes are unchanged.
