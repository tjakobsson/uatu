# Responsive/accessibility discovery — task 7.2

Run `bun tests/mobile-hub-review/responsive.e2e.ts` with a **20 minute** outer
timeout. The standalone runner launches the installed Chromium and WebKit,
uses one OS-assigned loopback port, synthetic protocols only, and closes its
contexts, browsers and server. No installations or product modifications.
These images are unapproved extensions, not goldens.

Latest complete run: **1022 PASS, 33 FAIL, 8 UNTESTED** assertion/scenario rows.
`scenarios.md` is the exact per-engine/size/theme/text/state table;
`results.json` contains geometry, errors and escaped-focus details.

## Lead action required

**WebKit native select targets remain under 44px** in assignment and onboarding
forms, across every size/theme/text combination. At 320×740, ordinary text,
Authentication and Signing selects measure **248×23px**. Inspect
`src/hub/mobile/styles.css`, `.mh-field select` and the actual native select
appearance/min-height interaction. The preference-sheet select is separately
styled and passes. These are failures, not accepted deviations.

One Chromium 844×390 dark 200% journey timed out loading
`/settings?detail=assignments` after 30s. Its six remaining assignment/onboarding
states are explicitly UNTESTED; this is a navigation/harness interruption, not
evidence of six UI failures. Other matrix entries exercised those flows.
The server occasionally reports its existing 10s idle-request timeout.

## Coverage and limits

- Touch contexts: 320×740, 390×844, 844×390 and 820×1180; light/dark;
  100% and scoped 200% computed-font stress.
- Login rejection/recovery → Hub → real Preview → Settings → preference sheet
  → Return; token form, synthetic token error, assignment review/back,
  onboarding registration failure and retained-folder recovery.
- Interactive geometry includes label hit areas for checkboxes; footer scroll
  reachability; 18 forward Tab presses per sheet; document overflow and scoped
  control horizontal bounds. This is not a complete WCAG audit.
- 200% uses the reference's Hub/overlay font stress policy, **not native OS
  Dynamic Type or browser zoom**. Preview root font isolation is asserted;
  this does not constitute a complete Files/Chat/Terminal interior regression.
- Keyboard evidence is browser focus plus reduced viewport height, **not a
  physical mobile keyboard**, safe-area hardware test or visualViewport API
  keyboard emulator.
- Reduced motion, forced colors and increased contrast APIs were checked via
  actual `matchMedia` and captured independently. Their layout snapshots do
  not prove motion timing or color contrast ratios (motion has separate evidence).
- Reduced transparency is explicitly UNTESTED: Playwright `emulateMedia` has
  no such option. No claim that it was emulated. Physical screen-reader and
  OS accessibility settings remain untested.
- Selected screenshots show unpictured narrow enlarged preference/token forms,
  enlarged landscape onboarding, and media variants. No initial golden changed.

Task 7.2 is **not complete** while the select target failures and the interrupted
matrix cell remain unresolved; human visual/interaction approval is still needed.
