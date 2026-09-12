# Current verification and known issues

**Awaiting user review.** This is an unfinished frontend-first change; tests do
not approve its visual design or authorize live integration, spec sync or archive.

## Candidate scope

The actual mobile Hub supports grouped Settings, full-page tasks, explicit
command hierarchy, read-only folder selection, creation cancellation to Add
Workspace and Devices under Session Security. The reviewer supplies synthetic
management operations and a mixed Markdown/AsciiDoc/text/code/image/binary corpus
to the real workspace clients. Same-document coordination retains one workspace
through ordinary Hub/Settings detours; reload, cross-workspace replacement,
Stop/removal and authentication invalidation remain distinct boundaries.

The new frontend is not yet wired to live Hub management operations. Workspace
interior layouts and controls are not redesigned. Review hosting defaults to
local-only; an optional public origin requires explicit local configuration.

## Current compact-package verification

The gallery contains ten scenes in each of Chromium and WebKit at 390×844 CSS px,
DPR 2, light scheme and reduced motion. The 20 explicit promotion captures passed
in 23.4s. Source: the cleanup working tree based on `373ef63`; product code is
unchanged and the frontend asset fingerprint remains
`sha256:dc2b6253b6434c9bb194ef49e58ccbfff7c2080f64da27acb96199db3177b996`.
No image is an approved golden; normal capture output stays locally ignored.

Current checks for the compact package:

- **448 tests / 5399 assertions passed** in the focused mobile Hub/reviewer,
  Preview, boot/navigation, privacy and preservation-baseline suites.
- Both TypeScript checks, whitespace and strict OpenSpec validation passed.
- **48/48** Chromium/WebKit navigation/flow/preview cases (59.9s).
- **4/4** Chromium/WebKit retained-workspace boundary cases (18.2s).
- **3/3** Chromium design-system interaction/responsive cases (4.0s).
- **22/22** Chromium/WebKit current-gallery and publisher cases (14.8s), including
  loading all 20 PNGs, responsive gallery layout and rejection of raw/history paths.
- Runtime bundle audits for the production entry, mobile coordinator and scoped
  styles passed with no privileged/test modules or fixture markers in those graphs.
- The publisher has exactly 22 selected source files: 20 PNGs and two Markdown
  records. Paths, PNG dimensions, content hashes, inert-text MIME and privacy/access
  boundaries are covered by tests. The canonical reference and baseline fixtures
  are unchanged. No product source or behavioral regression test was removed.

Commands are in [the reviewer guide](../../../../tests/mobile-hub-review/README.md).
The two current records and fresh images replace 618 generated archive files/scripts
in a normal cleanup commit; older files remain in Git history. The existing running
reviewer was not restarted, and this cleanup does not update a remote branch.

## Established functional coverage

The retained detailed findings also record these scoped passes (not additive to
the current checks above):

- 444 unit tests / 5453 assertions across mobile Hub/reviewer, Preview, boot,
  navigation, privacy and preservation-baseline checks; both TypeScript checks.
- 48 Chromium/WebKit flow/preview cases: cancellation/history, nested drafts,
  late reads, Security/Devices, folder selection, mixed-format siblings,
  index resume/Retry and direct image/binary load/reload.
- Nine normal-server Chromium Preview regressions: boundaries, failure/retry,
  duplicate roots, encoded URLs, layout, Chat drafts and terminal continuity.
  That separate harness uses test-owned files and a test PTY; the reviewer is
  synthetic and never uses a live Hub or personal workspace.
- Four Chromium/WebKit retention cases: all four surfaces and exact Chat
  draft/File plus terminal transport through Hub/Settings detours.

Those results are scoped evidence, not a complete current full-repository pass.
See [navigation findings](navigation-recovery/verification.md),
[preview/control findings](preview-refinement/verification.md), and
[privacy findings](privacy-sanitization.md). Raw run reports remain in Git history.

## Open issues and evidence limits

- No approved pixel-golden set or explicit final visual/interaction approval.
- The complete current app/option/scenario matrix remains unfinished. A small
  current gallery is not a substitute for testing unpictured states.
- Exact dirty pre-change all-four-workspace-interior/desktop proof remains
  incomplete. Existing reference and desktop baseline fixtures are retained.
- Historical native browser/HTTP/rendering stalls remain an open investigation.
  The responsive history includes an Open-click timeout where the Settings dock
  button intercepted pointer events. That actionability/occlusion evidence must
  not be flattened into a generic transport-wait explanation.
- Historical matrix sequence includes 1022 pass / 33 fail / 8 untested initially;
  a failed preflight with 50 pass / 1 fail / 14 untested / 1 unsupported; three
  1070-pass runs followed by 1001 pass / 4 fail / 46 untested / 1 unsupported;
  and a final 1102 pass / 0 fail / 0 untested / 1 unsupported. None is a fresh
  pass for every current UI state. Details: [responsive findings](responsive/README.md).
- HTTP connection reuse, font handling and tracing have not been established as
  universal causes of the historical stalls. Targeted newer passes do not waive
  the broader gate or prove all earlier failures share one cause.
- Physical iPhone/VoiceOver/keyboard/OS text scaling and safe-area behavior are
  not certified. WebKit reduced-transparency emulation was unsupported in the
  recorded matrix. Browser text enlargement is not native Dynamic Type.
- Local clone/credential/provider/live-backend correctness and deployment of
  the new mobile frontend require separately authorized integration work.

Pending tasks **7.1, 7.4, 8.3, 9.6, 10.4 and 11.4** remain pending. The retained
diagnostic notes under `tests/mobile-hub-review/evidence/` describe unresolved
investigations; their local trace files are neither deleted nor published here.
