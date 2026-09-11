# Frontend acceptance record

**AWAITING USER REVIEW — no human approval recorded.** Prepared 2026-09-10.
Passing tests, reference normalization approval and approved additive frontend
contracts do not approve the served visual/interaction design. No exceptions or
omissions listed here have been accepted by the user.

## Current candidate — preview examples and recognizable Hub controls

**Latest refinement:** [preview-refinement/verification.md](preview-refinement/verification.md).
The user approved the scope after clarifying workspace interiors, not the finished
visual result. Added synthetic Markdown/AsciiDoc examples use the actual previews;
shared Hub button hierarchy and composed empty states leave workspace interior
layouts, navigation chrome and Hub/workspace transition/retention unchanged.

**Previous refinement:** [folder-picker/verification.md](folder-picker/verification.md).
Full-page Cancel/current folder/Choose separates remote-folder selection from
Add Workspace → Manage folders. Focused picker tests pass in both engines;
the current full-app matrix and physical-device/approval gates remain open.

**Current shared-system consolidation:** [design-system.md](design-system.md).
The user approved creating the small reusable Web design system; this does not
approve every rendered state. Product modules/tokens now provide the shared
patterns, and `/review/design-system` is a separate local-only reference.

**Current readability refinement:** [readability-update.md](readability-update.md).
The user requested the pre-work checkpoint be committed/pushed; `c259efb` was
pushed to the fork before the new work. Structured information, canonical Devices
navigation, prominent notice, green Boolean switches and deliberate field entry
refine the same full-page model. No visual/interaction approval is inferred.

**The previous Settings/cold-entry presentation is superseded:** the user rejected
drawers and More menus and explicitly chose full-page editors. Current scope
and verification are in [page-based-settings.md](page-based-settings.md).
The choice approves that interaction model, not the finished visual result.

Subsequent feedback rejected blanket bottom placement in Settings and asked for
understandable diagnostic purpose plus a loading-chrome fix. The screenshots
were examples, not an exhaustive fix list. [settings-refinement.md](settings-refinement.md)
records the new candidate, targeted passing checks and remaining WebKit/full
matrix limits. This request for corrections is not visual approval. Earlier
optical measurements/captures below remain historical unless explicitly retested.

## Previous corrective candidate — publication authorized, not approved

The user requested iOS-guided UX corrections and single-home lower-screen actions,
then explicitly chose **“Update review now”** with full browser verification
incomplete. This authorizes only the isolated review refresh. Read
[ios-ux-correction.md](ios-ux-correction.md) for changes and current evidence.
The earlier green matrix and visual captures below remain historical evidence;
they do not certify this corrected version. Task 9.6 is still open.

| Decision / version | Record |
|---|---|
| Candidate product URL | `[PRIVATE_REVIEW_ORIGIN_REDACTED]/` — user confirmed phone access |
| Source version / dirty-tree description | Uncommitted frontend implementation over preserved dirty baseline; no clean-Git or released-version claim. |
| Served frontend content fingerprint | `sha256:49845329baf12c14a8da54b584cfb43c3f6c8152189a10adda6c0dfcbbd7c239` — preview examples and Hub controls |
| Evidence snapshot identity | `/review/evidence/manifest.json` supplies snapshot time and individual SHA-256 values, separate from frontend fingerprint. |
| Remote access / handoff delivery timestamp | URLs delivered 2026-09-10. Local two-engine smoke passed; user answered “It opens” to the explicitly connectivity-only phone question. No design approval inferred. |
| Reviewer / approval timestamp | AWAITING USER |
| Explicit visual approval for this version | AWAITING USER |
| Explicit interaction approval for this version | AWAITING USER |
| Approved screenshot golden set | NONE; task 7.1 remains unchecked |
| Accepted exceptions (enumerate individually) | NONE; user must explicitly accept or request correction |
| Live integration / rollout / spec sync / archive authorization | NOT GRANTED by this frontend review |

## Required review decisions

| Scope presented | Evidence / open decision | User decision |
|---|---|---|
| Pictured Hub/Settings/docks/selector/Preview pill | `visual/review-ready/`: 50 comparisons + 6 extensions; current branding and synthetic data stated | Awaiting |
| Optical deviations | Settings group +7.52px, minor dock/icon/font/material differences, visible WebKit focus ring | Awaiting, not tolerated by default |
| Unpictured H01–W03 states | Complete `scenario-guide.md` inventory: grouped identity/credential/tool/assignment/device/security details, task sheets, browse/create/clone/recovery and accessibility states | Awaiting; design grammar is not prior approval |
| High-risk interactions | Stop versus Forget, key/token delete/disable/projected dependencies, current-session revoke/sign-out, import clearing, Git-init consent, clone attempt uncertainty/partial outcomes | Awaiting; synthetic semantics only |
| Same-workspace continuity | Exact File/draft and real scroll/client ownership through Hub/Settings, background streams, history/input/motion and stale generations | Awaiting |
| Cross-workspace boundary | Any known registered running id; new document with own protocols/personal state, no second resident workspace or survival promise across reload | Awaiting |
| Accessibility/responsive | 1102 pass / 0 fail / 0 untested / 1 unsupported WebKit reduced transparency; scoped text/focus/viewport stress, not physical keyboard or Dynamic Type | Awaiting; unsupported/physical checks not silently waived |
| Non-redesign evidence limitations | Current Preview exact in both engines, upper Terminal comparison, desktop tiny differences and stopped exact; Settings/Add data mismatch, no exact dirty pre-change four-interior proof, browser inset not SwiftUI | Open proof gap (7.4), not accepted omission |
| Wider workspace fixture coverage | Search/diff/extensive corpus, other provider features and full terminal edge-case matrix not completely verified; no archive/steer/terminal-rename client API invented, unknown contracts 501 | Open coverage boundary, not live capability certification |
| Harness observations | Historical Return pointer interception and HTTP/SSE stalls retained; newer targeted regressions pass without asserting universal root cause | Awaiting review of stated limitations |

## Procedure

Local readiness, served version, final rerun and URL delivery are recorded.
Remote/phone readiness is confirmed. The user then explicitly states approve/reject/request changes for
that version and names each accepted exception. Record their words and date;
do not infer approval from silence, test results or merely opening the URL.
Changed served bytes require a new fingerprint and clear review-version scope.

Until then leave **8.3 unchecked**. Tasks 7.1, 7.4, 9.6, 10.4 and 11.4 retain their
separate pending criteria. Even frontend approval is a stop: seek separate live
integration authorization, with production-facing delta specs still unmerged.

> Privacy redaction: concrete private review endpoints have been removed; the placeholders above are not live URLs. Historical measurements and outcomes are unchanged.
