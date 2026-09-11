# Readability and explicit controls — current review candidate

2026-09-10. Before this work began, the requested checkpoint was committed and
pushed to the fork:
[`c259efb — chore(mobile): checkpoint refined Hub review frontend`](https://github.com/addiberra/uatu/commit/c259efb).
The branch is `design/hub-mobile-navigation`. Private/runtime data, the separate
worktree, unrelated tooling deletions and raw browser traces were excluded.
This new UX pass remains uncommitted; the checkpoint was not amended.

Current frontend fingerprint:
`sha256:d9d6b47fa2c48dcd28ac9a17ef376705446dc11cb28cd6168da9636fa9d4b4c9`.

## What changed

- **Facts have labels and values.** Purpose, workspace identity, host/credential
  associations, signing, check results and setup outcomes use semantic readonly
  information groups. Values have stronger contrast than labels and explanatory
  notes. Editable fields have their own visible boundaries and disabled treatment.
- **Reviews show changes, not prose walls.** Current and After applying values
  are separated by role and host. “Change on apply” describes a future action;
  it is not styled as already completed. Restart/default-only consequences have
  their own labeled section.
- **Hosts are normalized at Review, not on entry.** Mixed-case/URL spelling is
  normalized for the existing API. Back preserves the typed draft. Adding a new
  host does not remove existing hosts; omitted roles stay unchanged.
- **Devices has one navigation entry**, in Settings. Security retains relevant
  explanatory information but no duplicate Manage devices command. Distinct
  same-name API device records are not removed or merged.
- **The dismissible notice is prominent and contextual.** Its named amber callout
  is between identity and credentials, rather than below the whole Settings page.
  It explains shared credential access plainly and keeps the existing per-user
  dismissal choice. If already dismissed on a device, it stays dismissed there.
- **Boolean choices use green switches.** Native checked semantics, disabled
  state and draft values remain. A moving thumb and accessible switch state
  communicate selection in addition to color. Radio/one-of-many choices were
  not converted into independent switches.
- **Opening an editor does not activate a field.** Focus goes to its heading;
  no automatic picker, keyboard, change event or commit. Saved/default values
  remain accurate. Technical fields disable capitalization/correction as appropriate.
- **Ordinary actions no longer look selected.** Contextual commands do not inherit
  filled primary-button styling; Sign out is no longer red text on blue. Direct
  Clone entry also selects Hub consistently with Add Workspace navigation.

No More menus, Settings drawers or duplicate reachability buttons were added.
Full-page editing, explicit review/commit, secret clearing, task-history fences,
loading navigation and mock-only operations remain in place. Switches do not
initialize Git/start/delete anything before the existing Review/Apply action.

## Guidance and evidence

[Apple guidance revisited](readability-guidance.md) cites Settings, Labels,
Toggles, Text Fields, Entering Data, Feedback and Alerts. This is inspiration and
a web/PWA adaptation, not Apple certification or a native UIKit implementation.

Final manually inspected current captures are in `readability/final/`:

1. `01-settings-fresh.png` — notice placement and information hierarchy.
2. `02-credential-purpose.png` — labeled readonly purposes/facts.
3. `03-workspace-assignment-summary.png` — information separate from actions.
4. `04-edit-first-entry.png` — closed pickers, no automatic field focus.
5. `05-review-changes.png` — Current / After applying and prospective changes.
6. `06-clone-start-and-empty-host.png` — green draft switch and a fitting disabled hint.

All are actual synthetic-frontend Chromium captures at **390×844 CSS px**. No
private user attachments, DOM hiding, before-image parity or approved goldens are
claimed. `final/REVIEW.md` and `final/capture-report.json` retain metrics, source
fingerprint and limits. Initial captures/flags remain in the parent directory.

## Verification performed

| Command/evidence | Observed result |
| --- | --- |
| `bun test src/hub/mobile tests/mobile-hub-review src/shell/navigation-cold-boot.test.ts src/shell/hub-nav.test.ts src/shell/navigation-preferences.test.ts` | **359 passed, 0 failed; 3030 assertions** |
| `bun run typecheck` | PASS |
| `bunx --no-install tsc --noEmit --pretty false -p tests/mobile-hub-review/tsconfig.json` | PASS |
| `newstage12.browser.ts` in the combined native probe run | PASS: canonical Devices navigation, notice/dismissal, heading focus, explicit picker interaction, no opening/review mutations and retained mixed-case draft |
| `bun test ./tests/mobile-hub-review/shared-ux.browser.ts` | PASS: green 51×31 switch, ≥44px row, native checked semantics, draft-only state, reduced motion and forced colors |
| `bun tests/mobile-hub-review/editor-entry-chrome-audit.ts` | `activeTag: H1`, `activeName: null`, `changes: 0`, `commits: 0` |
| Final readability capture | **8 supplemental checks passed, 0 failed; 6 actual PNGs manually inspected** |

The switch's first immediate-color assertion caught a normal 150ms transition;
the corrected assertion waits for the unchanged intended green/translated-thumb
endpoint. An early audit configuration requested nonexistent system Chrome and
an unsupported Bun build option; it was corrected to installed Chromium, with
no dependency installation. These are not disguised product failures.

**Limits:** fresh Settings includes genuine Loading readiness labels in its
capture. Some longer information is below the nested scroll viewport; the
“What happens next” text was asserted but its below-fold visual layout is not
signed off. No current full WebKit matrix or physical keyboard/VoiceOver check
was completed. Existing cross-engine, golden and historical-interior gates remain
open; previous full-suite counts are not inherited.

## Review

Refresh <[PRIVATE_REVIEW_ORIGIN_REDACTED]/>. Simulation
login remains **reviewer / review-only**. The controller and evidence remain
separate from the product viewport. No live Hub/backend integration, production
operations, dependency installation, spec sync or archive was performed.

> Privacy redaction: concrete private review endpoints have been removed; the placeholders above are not live URLs. Historical measurements and outcomes are unchanged.
