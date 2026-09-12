# Focused folder picker workflow verification

> Start with the [current evidence index](../README.md) and [current verification](../verification.md). Status and generated-artifact paths below are historical at pre-cleanup commit `373ef6350032f6a0f2a91c2037ebafb553bc002f`; they do not assert fresh passes or close pending gates.

2026-09-11. Browser workflows use a disposable synthetic review server on
**4727**. Publication uses only the separately owned synthetic reviewer on
**4703 / HTTPS 8445**. No live backend, providers, PTYs, dependency installation,
commits, or forced clicks.

## Candidate and review path

- Full-page **Cancel / current folder / Choose** with a fixed header and one
  scrolling body. Folder rows navigate; Choose alone selects the verified path.
- Default Folder and Create Workspace retain drafts; Existing Folder selects
  before configuration. **Add Workspace → Manage folders** owns maintenance,
  not the picker. The picker backend capability is restricted to `browseFolders`.
- Interactive production-module example: `/review/design-system` →
  **Choose Hub folder**. Guide: `/review/design-system/guide`.
- Frontend: `sha256:950c3438aa9847910394485417cf27e112eb80241ed4be887f4b8265e7fc86bc`.
- Independent reference: `sha256:411392257fd588f01fc0ca38555e8798c64b8790e3b3e3c65ffd2614ad6bacb0`.

These identify built bytes, not a clean Git revision or visual approval. Existing
full-app verification, physical-device and human-approval gates remain open.

## Design sources and claim boundary

Apple's [directory access](https://developer.apple.com/documentation/uikit/providing-access-to-directories)
and [document picker](https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller)
documentation describes explicit completion/cancellation and file-provider URLs.
Its [lists](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables)
and [toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
guidance supports clear hierarchy and controls; earlier research is retained in
`../ios-hig-research.md`. The exact fixed header, Choose label and separation of
navigation from selecting the current directory are Uatu Web design decisions,
not claimed Apple mandates. A device file-provider URL is not a remote Hub path;
this interface does not invoke a native iPhone filesystem picker.

## Final browser run

`bunx --no-install playwright test --config tests/mobile-hub-review/focused-picker.config.ts`

**10 passed, 20.5 seconds:** five cases in installed Chromium and WebKit.
No native browser gap or retry was necessary in the final run. These are
desktop-hosted browser engines with iPhone viewport emulation, not physical
iOS Safari/device testing.

- Default Folder: nested child navigation is not selection; Parent navigates
  up; Choose returns the verified canonical path; only parent Save sends
  exactly one `setDefaultFolder` with `['/synthetic/group']`.
- Loading: Choose disabled and Cancel enabled. Denied read: Retry preserves
  truthful failure, last-valid returns to the prior folder, Cancel restores
  the Default Folder draft without writes.
- Create Workspace: typed name/display name/Git consent survive Cancel and
  parent selection. Existing folder first selects then opens configuration.
  Manage folders has a separate `detail=folders` route and all six direct
  operations remain present. Navigation/configuration does not start anything.
- Long listing: 305-character synthetic path, 24 child folders; actual product
  CSS at 390×844, 320×568, and 844×390. Header geometry remains unchanged when
  the body scrolls; Cancel and Choose stay in viewport and at least 44×44;
  body path remains complete without horizontal clipping, h1 title carries
  the complete path. Hub navigation is absent in the picker.
- Existing legacy folder-picker test now checks Cancel and accessible Parent
  semantics while preserving its typed-draft and target-size assertions.

`browser-results.json` is the native Playwright JSON report. Its attachments
contain the captured read-only request probes (base64 JSON bodies), including
the exact Save payload and explicitly separated fixture-write count. Fixture
folder creation is test setup, before browser request probing. Error/cancel
and Create/Existing/management probes assert an empty mutation log; long-list
probing asserts the fixture log remains unchanged.

PNG files are unaltered screenshots from the served app: short normal, empty,
error, and normal/scrolled long listings in all three viewports for both engines.
No CSS substitution or DOM hiding was used. The WebKit 320 normal capture was
also visually inspected: header leaf truncates, full body path wraps, parent
leaf wraps, and Cancel/Choose are legible.

## Final lead reconciliation

- `bun test src/hub/mobile tests/mobile-hub-review src/shell/navigation-cold-boot.test.ts src/shell/hub-nav.test.ts src/shell/navigation-preferences.test.ts`:
  **384 passed, 0 failed, 3772 assertions**, including the curated evidence map.
- `bun run typecheck` and
  `bunx --no-install tsc --noEmit --pretty false -p tests/mobile-hub-review/tsconfig.json`:
  **passed**.
- `bunx --no-install playwright test --config tests/mobile-hub-review/design-system.config.ts`:
  **2 passed, 4.2 seconds**, Chromium production-picker example and reference
  lifecycle/responsive checks. This supersedes the earlier reference page-setup
  timeout, not the broader incomplete application matrix.
- Focused layout coverage previously passed **48 combinations** using the actual
  task owner/styles, including light/dark/forced colors and 200% text. These are
  layout checks, not pixel goldens or physical Dynamic Type certification.
- Corrected the two stale presentation assertions below and made the catalog
  adapter compatible with the picker's close-only task surface. No extra backend
  capability was granted. The final browser JSON path is resolved from the config
  module, avoiding a misleading duplicate tree under `tests/mobile-hub-review/`.

### Earlier worker checks (superseded, retained for provenance)

- `bun test src/hub/mobile/folder-picker.test.ts src/hub/mobile/folder-picker-styles.test.ts src/hub/mobile/flows.test.ts`:
  **86 passed, 2 failed**. Both failures are stale presentation expectations
  outside this worker's ownership: `flows.test.ts:402` expects `Up to /projects`
  but receives `projects`; `folder-picker.test.ts:43` expects `/` for root h1 but
  receives `Hub folders`. Product accessible Parent semantics are verified in
  the browser. These tests were not edited by this worker.
- `bun run typecheck`: **passed**.
- `bunx tsc --noEmit -p tests/mobile-hub-review/tsconfig.json`: **failed** at
  `design-system.ts:43`, missing `TaskPort.error`, outside owned files.

## Findings and limits

No concrete product bug was found in these focused browser workflows. The first
browser run exposed two test-author assumptions, corrected before the final
run: mixed fixture's group has no child unless explicitly created; Add Workspace
rows have subtitle-inclusive accessible names. No product changes were required.

Clone/onboarding retained-path recovery, mutation execution inside Manage
Folders, actual root `/` browsing, stale native responses, and physical iOS
keyboard/gesture behavior are not independently covered by these five cases.
The final green unit suite exercises broader lifecycle behavior; it does not
substitute for those additional browser/physical-device cases or human approval.
