# Responsive/accessibility discovery — task 7.2

## Current result

**1102 PASS, 0 FAIL, 0 UNTESTED, 1 UNSUPPORTED** in the final complete run.
Installed Chromium **153.0.8010.12**, WebKit **26.6**, Bun **1.4.2**.
`scenarios.md` is the exact engine/size/theme/text/state table; `results.json`
contains measurements, browser/source provenance and media API evidence.
This is discovery evidence, not approved screenshot goldens or human acceptance.

Run `bun tests/mobile-hub-review/responsive.e2e.ts` with a **20-minute outer
timeout**. It launches a test-only child server on an OS-assigned loopback port,
uses synthetic HTTP/SSE protocols, and closes contexts, browsers and the child
server. No installations, privileged operations or product edits by this worker.

## Previously failing WebKit selects — verified corrected

The lead's native-appearance correction is verified in every matrix cell.
At 320×740 ordinary text, assignment Authentication and Signing selects now
measure **248×44px**, `appearance: none`, formerly **248×23px**.
Preference-sheet selects remain **52px** high at ordinary text. Enlarged forms,
reviews, errors, footer reachability and focus trapping pass.
`webkit-320x740-light-100-assignment.png` explicitly pictures the corrected case.

## Chromium timeout investigation — limitations remain

The exact previously interrupted **844×390 dark 200%** journey passes completely
in the final run, including assignments and all onboarding/recovery states.
Earlier complete runs and failed preflights are retained under `history/` and
`preflight/history/`, with their original FAIL/UNTESTED rows. The initial report
is preserved under `history/2026-09-10T00-46-29-069Z/`.

Observed failures were transient readiness/HTTP/navigation waits, not failed
select/reflow geometry: pending requests varied among synthetic document,
credential facts, personal state and a script asset. The previous landscape
failure waited for `load` while a script request remained pending. An independent
request probe could receive a response while the browser still awaited its own
request. Moving the server into a separate process did **not** eliminate stalls.
Opting out of connection reuse produced three consecutive green full matrices,
but another run later had transient readiness/action failures. Therefore
**HTTP keep-alive is not a proven root cause, and no product transport fix is
claimed**. This is a remaining harness/transport investigation limitation, not
a reason to bless previous failures.

The final runner uses `Connection: close` for matrix browser HTTP requests,
30-second readiness/action waits and 60-second navigations. Assertions still
require actual visible content, full geometry and reachable controls; there is
no retry-to-green or forced click. Accessibility discovery does not assert a
response-time SLA. `RESPONSIVE_CLOSE_CONNECTIONS=0` restores persistent
connections; `RESPONSIVE_SAME_PROCESS=1` restores the original in-process server;
`RESPONSIVE_PREFLIGHT=1` runs the two originally failing matrix cells separately.
The server's existing idle SSE timeout warning occurred intermittently; this
runner does not alter the server heartbeat contract.

## Coverage and honest limits

- 32 complete touch combinations: Chromium/WebKit × 320×740, 390×844,
  844×390, 820×1180 × light/dark × 100%/200% scoped computed-font stress.
- Login rejection/recovery → Hub → real Preview → Settings → preference sheet
  → Return; token form and synthetic token error; assignment review/back;
  onboarding registration failure and retained-folder recovery.
- Interactive geometry uses label hit areas for checkboxes; footer scroll
  reachability; 18 forward Tab presses per sheet; document overflow and scoped
  control horizontal bounds. This is not a complete WCAG audit.
- 200% follows the reference's Hub/overlay text stress policy, **not OS Dynamic
  Type or browser zoom**. Preview root font isolation passes; complete
  Files/Chat/Terminal interior regression is outside this runner's claim.
- Keyboard evidence is focus plus viewport-height reduction and explicit input
  scroll reachability between sheet header/footer. It is **not a physical mobile
  keyboard**, native keyboard auto-scroll, hardware safe-area test or keyboard
  visualViewport API emulation.
- Reduced motion, forced colors and increased contrast are independently
  emulated and confirmed by actual `matchMedia` in both engines. Layout captures
  do not establish animation timing or measured color-contrast ratios.
- Chromium reduced transparency is actually emulated through CDP
  `Emulation.setEmulatedMedia`; `matchMedia` matches and dock blur is `none`.
  **WebKit reduced transparency is UNSUPPORTED** by the available Playwright
  emulation API (no WebKit CDP session); no fake state is substituted.
- Physical screen readers and OS accessibility settings remain outside this
  automated scenario table. Human visual/interaction approval is still needed.

## Current screenshot inventory (22 unapproved extension images)

- `chromium-320x740-{light,dark}-200-{preference,credential}.png` (4)
- `webkit-320x740-{light,dark}-200-{preference,credential}.png` (4)
- `{chromium,webkit}-320x740-light-200-keyboard-viewport.png` (2)
- `webkit-320x740-light-100-assignment.png` (1)
- `{chromium,webkit}-844x390-{light,dark}-200-onboard.png` (4)
- `{chromium,webkit}-{reduced-motion,forced-colors,contrast}.png` (6)
- `chromium-reduced-transparency.png` (1)

All are outside the initial golden set. Historical directories intentionally
retain the earlier screenshots and failing discovery reports without approval.
