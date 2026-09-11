# Final readability follow-up — manual PNG inspection

## Capture provenance

One run, no retries: **six screenshots captured**, then each PNG opened and manually inspected. The successful browser run took **50.368 seconds** (excluding server build). Actual current frontend built by the existing test server, typed synthetic `mixed` fixture plus Atlas's `ssh-open` assignment on `github.com`, ephemeral **port 0**, installed **Chromium 153.0.8010.12**, one fresh light/touch context, **390 × 844 CSS pixels**, device scale 1. Browser and temporary server closed through the runner's cleanup. No interaction with service 4703.

Current frontend health fingerprint:

`sha256:d9d6b47fa2c48dcd28ac9a17ef376705446dc11cb28cd6168da9636fa9d4b4c9`

Original readability PNGs, capture report and REVIEW remain untouched. **c259efb** remains the authoritative historical before checkpoint; no old-source image comparison is claimed. No private attachments, screenshot CSS masks, DOM painting, forced input focus, dependency changes, product edits, or commits. Fresh-context notice preferences do not reset production preferences.

Command:

```sh
READABILITY_OUTPUT=../../openspec/changes/restore-refined-mobile-hub-experience/review-evidence/readability/final/ bun tests/mobile-hub-review/readability-capture.browser.ts
```

## Actual images and visual decisions

| Image | Manual result |
| --- | --- |
| [01-settings-fresh.png](01-settings-fresh.png) | **PASS: first-view warning.** Full amber notice is clearly visible beneath identity and before credentials. Its title and explanatory text are readable. **Capture caveat:** credential readiness rows still say “Loading…” at screenshot time; this is real initial UI, not evidence of settled readiness. Exactly one Devices entry was separately checked, but is below this viewport. |
| [02-credential-purpose.png](02-credential-purpose.png) | **PASS: informational hierarchy.** “USED FOR”, “Git access”, “SSH” read as purpose information. Key protection/runtime/public identifier labels and values are distinct; blue Copy action is distinguishable. Authentication-only purpose remains truthful; assigned Atlas context is visible. |
| [03-workspace-assignment-summary.png](03-workspace-assignment-summary.png) | **PASS: information versus action.** Folder/status and Host/Credential remain read-only labeled facts, with a separate blue Edit authentication action. Warning remains prominent. Lower remove/general-edit actions are outside this viewport, not visually signed off. |
| [04-edit-first-entry.png](04-edit-first-entry.png) | **PASS: calm initial editor.** Heading and Cancel/Review fit, both pickers are closed, selected credential and `github.com` are retained, no popup or text selection is visible. No input/select/textarea owns focus at first entry. This is browser evidence, not a physical software-keyboard test. |
| [05-review-changes.png](05-review-changes.png) | **PASS: unapplied comparison.** Current / After applying are explicit, separate readable metadata rows. `github.com` is normalized in the preview. **Change on apply / Replace credential** is neutral black text on white, with no green success edge and no completed-tense “Replaced” implication. Header Apply and replace remains distinct and unpressed. Commit signing begins below. |
| [06-clone-start-and-empty-host.png](06-clone-start-and-empty-host.png) | **PASS: both fixes visible.** Entire **“Select a credential first”** placeholder fits inside the disabled dashed-outline Host field at 390 px. Start switch is green with thumb right because the draft Boolean is enabled, not because work completed. Direct `/clone` correctly selects **Hub**, not Settings, in bottom navigation. |

## Supplemental checks / metrics

**8 checks passed, 0 failed**, recorded with per-screen geometry/focus/fonts/colors in [capture-report.json](capture-report.json):

- Single Devices entry; credential information has `dt`/`dd`.
- Initial editor does not focus a form control.
- Review shows normalized host and explicit Current / After applying labels.
- Prospective change rows have `mh-info-neutral`, text color `rgb(8, 8, 9)`; no positive information rows in this review.
- Back to edit preserves the exact typed **`  GITHUB.COM  `** draft, including whitespace. No browser `assignWorkspace` request occurred: neither Review nor Back applied changes.
- Start draft checked; Host empty and disabled.
- Visible placeholder is short while accessible description remains **“Choose a Git authentication credential first to edit its host”**. Measured input width **318 CSS px**.

“What happens next” is present with **When credentials are used / A restart may be needed** and **Applying defaults does not unlock credentials or check repository access.** These were inspected from rendered text, but are below the review screenshot: **their visual layout was not inspected in this six-image run**. Likewise the “Keep current” signing row is structurally observed below the captured region; Add host is not exercised by this replacement scenario. Hub selection is both visually visible and recorded as `aria-current="page"`.

## Remaining quality limits

- The two targeted readability issues are resolved in the actual PNGs: placeholder clipping and green/completed-looking proposed replacement.
- The Settings shot captures an honest loading state, so cannot validate settled readiness labels. No recapture or retry-to-green was done.
- Partial content at the lower navigation/content boundary remains visible (e.g. Manage assignments in credential details). These viewport images do not establish an unreachable action, nor certify all scrolled content.
- No 320 px stress shot, dark theme, actual keyboard, physical device, VoiceOver/Dynamic Type, whole-matrix review, Apple certification or golden approval.

**Disposition: PASS for the sampled final readability fixes, with the explicit loading-state and below-viewport inspection gaps above.** Initial evidence is preserved rather than rewritten.
