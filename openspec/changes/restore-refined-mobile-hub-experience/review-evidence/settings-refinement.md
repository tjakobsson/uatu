# Settings convention refinement and cold-entry fix

2026-09-10 — **mock-backed review candidate, awaiting user review**.

The user's screenshots were examples of a broader problem. This pass supersedes
the previous blanket one-handed placement: Settings uses conventional top Back,
compact detail titles and contextual grouped values/actions. Workspace surface
navigation and natural composer controls remain low; actions are not duplicated.

Frontend fingerprint:
`sha256:5f6115996f542903e293e7f6d575b381eef2a7a43c02a3ce20c9752c7862bd41`.

## Changes to review

- No universal Back/More/Test bottom toolbar on Settings details. Add Credential
  returns to its Settings group, Add Workspace to Hub content, and login submit
  to its form. Noninteractive route headings keep screen-reader focus without
  looking like outlined controls; interactive keyboard focus stays visible.
- Default Folder shows the relevant saved/effective folder and explains that it
  applies across this Hub, not the iPhone or one signed-in person. Existing
  workspaces are not moved. **Use Hub home folder** is a normal draft choice,
  committed by Save and discarded by Cancel—not a destructive Clear menu.
- Navigation preferences use short selectable checkmark rows: Left/Right,
  **After 7 seconds / Until I close it**, with Top/Bottom endpoints for placement.
  No native picker nested inside another sheet or invented timer choices.
- Credential details lead with their supported purpose and **Ready on this Hub**
  or the actual prerequisite/problem. Diagnostic counts no longer dominate.
  **Troubleshooting** explains that the checks help diagnose local connection/
  signing setup, not access to a particular remote repository. Every original
  result remains inspectable; anonymous rows are not assigned guessed tool IDs.
- Tools explain what they do. **Recheck installed tools** accurately describes
  the tool-check scope; **Executable location** is a direct contextual row.
  **Use automatic discovery** changes a draft and waits for Save.
- Assignment/device actions avoid one-option intermediate menus. Editing
  workspace credentials still supports independent authentication and signing;
  adding an authentication host cannot alter signing. Replacement is explicit
  at review, and review text uses selected names rather than unexplained IDs.

## Loading bug: cause and repair

The reported arrow-at-top and partial-width navbar had a reproducible cause:
touch markup could paint before its owner initialized geometry/expanded state,
and readiness had controlled idle dismissal rather than presentation.

- Both controls start inert and are withheld until initialization, valid geometry
  and workspace readiness agree. No arbitrary visual delay was introduced.
- Confirmed Hub entry shows **Loading workspace…** and one **Back to Hub**.
  The actual workspace remains measurable but hidden/inert; an unpopulated Files
  view is not presented as a confirmed empty workspace.
- Loading owns interaction: hidden Find/Terminal shortcuts cannot act or steal
  focus. Back abandons foreground intent without Stop, teardown or another boot.
- Late completion leaves Hub/Settings foregrounded. Return reuses the same boot,
  saved Files tab, document/hash and handle placement.
- Authenticated Hub context is known before the first ready selector, even if
  the older discovery probe is delayed. Stale probe 401s cannot revoke a newer
  context. Boot failure returns to Hub; explicit retry can load a fresh document.

## Verification actually performed

Lead's latest commands:

| Command | Result |
| --- | --- |
| `bun test src/hub/mobile tests/mobile-hub-review src/shell/navigation-cold-boot.test.ts src/shell/hub-nav.test.ts src/shell/navigation-preferences.test.ts` | **312 passed, 0 failed; 2605 assertions** |
| `bun run typecheck` | PASS |
| `bunx --no-install tsc --noEmit --pretty false -p tests/mobile-hub-review/tsconfig.json` | PASS |
| `bun test ./tests/mobile-hub-review/coordinator-cold-boot.browser.ts --test-name-pattern 'chromium: actual'` | **1 passed**; real held import/state, loading escape/shortcuts, late readiness, saved Files/hash/placement and full Hub navigation |
| `bunx --no-install playwright test --config tests/mobile-hub-review/settings-conventions.config.ts` | **3 passed**; picker context/draft, grouped Settings/checkmark preferences, Default Folder |
| `bunx --no-install playwright test --config tests/mobile-hub-review/purpose-led-settings.config.ts` | **2 passed**; purpose-led credential with all 14 diagnostics and 9 tool purposes, direct editor and automatic-discovery Cancel/Save |

Earlier new-test setup errors (a nonexistent system Chrome channel and an
incorrect uppercase fixture-string expectation) were corrected to use installed
Chromium and the actual simulated-data contract. They were not product bugs.

**Limits:** WebKit cold-entry verification still failed/timed out before document
parsing in its attempted run. Failure/switch Chromium assertions passed, but one
combined run timed out during shutdown and is not called green. The complete
current two-engine matrix, physical iOS keyboard/VoiceOver and older exact
pre-change interior proof remain open. Older full-suite counts must not be
inherited by this version. No new native-rendering workaround was introduced.

Current screenshots: `settings-refinement/credential-current.png` and
`settings-refinement/tools-current.png`, with SHA-256/provenance in
`settings-refinement/captures.json`. Earlier iOS-UX and reference comparisons are
historical, not the current Settings control placement.

## Review boundary

Reload the locally started reviewer for this version (see `handoff.md`).
Private review access details have been removed.
Simulation login remains **reviewer / review-only**. Existing live Hub, test and
reference endpoints are untouched. No real credentials, Git/clone, provider,
PTY, public API, dependency, commit, spec-sync or archive work is authorized by
this review. Visual and interaction approval remain explicitly pending.
