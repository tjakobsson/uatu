# Responsive/accessibility discovery — task 7.2

> Start with the [current evidence index](../README.md) and [current verification](../verification.md). Status and generated-artifact paths below are historical at pre-cleanup commit `373ef6350032f6a0f2a91c2037ebafb553bc002f`; they do not assert fresh passes or close pending gates.

## Historical final result

**1102 PASS, 0 FAIL, 0 UNTESTED, 1 UNSUPPORTED** in the final complete run.
Installed Chromium **153.0.8010.12**, WebKit **26.6**, Bun **1.4.2**.
[scenarios.md](scenarios.md) is the exact engine/size/theme/text/state table; [historical results.json](https://github.com/addiberra/uatu/blob/373ef6350032f6a0f2a91c2037ebafb553bc002f/openspec/changes/restore-refined-mobile-hub-experience/review-evidence/responsive/results.json)
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

Subsequent authorized cleanup removed 115 history PNG copies whose Git blobs
exactly matched retained current images. See [the duplicate map](../artifact-cleanup.md)
for all old-path → retained-file associations and immutable blob identities.
That was the earlier cleanup's scope. The subsequent compact cleanup moves all
generated JSON and PNG evidence out of the working tree; unchanged originals are
available in the pre-cleanup commit above. Scenario tables remain local.

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

## Historical screenshot inventory (22 unapproved extension images)

- `chromium-320x740-{light,dark}-200-{preference,credential}.png` (4)
- `webkit-320x740-{light,dark}-200-{preference,credential}.png` (4)
- `{chromium,webkit}-320x740-light-200-keyboard-viewport.png` (2)
- `webkit-320x740-light-100-assignment.png` (1)
- `{chromium,webkit}-844x390-{light,dark}-200-onboard.png` (4)
- `{chromium,webkit}-{reduced-motion,forced-colors,contrast}.png` (6)
- `chromium-reduced-transparency.png` (1)

All are outside the initial golden set. The pre-cleanup commit retains unique
earlier screenshots and all failing discovery reports without approval; previously
removed byte-identical PNG copies are documented in the duplicate map above.

## Preserved failure history and ongoing gates

The compact cleanup does not supersede or convert earlier failures. Counts below
were checked against the original JSON rows at the pre-cleanup commit, not rerun.
Each retained scenario table preserves the individual FAIL/UNTESTED rows; full
measurements, pending-request lists and traces remain in the historical JSON.

| Run (2026-09-10 UTC) | PASS | FAIL | UNTESTED | UNSUPPORTED |
| --- | ---: | ---: | ---: | ---: |
| [00:46:29.069](history/2026-09-10T00-46-29-069Z/scenarios.md) | 1022 | 33 | 8 | 0 |
| [Preflight 00:52:25.303](preflight/history/2026-09-10T00-52-25-303Z/scenarios.md) | 50 | 1 | 14 | 1 |
| [Preflight 00:54:04.967](preflight/scenarios.md) | 80 | 0 | 0 | 1 |
| [01:06:33.051](history/2026-09-10T01-06-33-051Z/scenarios.md) | 971 | 4 | 45 | 1 |
| [01:16:49.444](history/2026-09-10T01-16-49-444Z/scenarios.md) | 1025 | 2 | 21 | 1 |
| [01:24:57.679](history/2026-09-10T01-24-57-679Z/scenarios.md) | 1070 | 0 | 0 | 1 |
| [01:31:39.606](history/2026-09-10T01-31-39-606Z/scenarios.md) | 1070 | 0 | 0 | 1 |
| [01:39:02.234](history/2026-09-10T01-39-02-234Z/scenarios.md) | 1070 | 0 | 0 | 1 |
| [01:51:36.896](history/2026-09-10T01-51-36-896Z/scenarios.md) | 1001 | 4 | 46 | 1 |
| [Final 01:58:58.907](scenarios.md) | 1102 | 0 | 0 | 1 |

- Initial failures included **32 WebKit assignment/onboarding target-size rows**
  across sizes/themes/text stress: native selects measured 23 or 43px high, below
  the 44px requirement. The 33rd FAIL was Chromium landscape navigation timeout;
  six downstream rows were UNTESTED. Both engines' reduced transparency were
  initially UNTESTED, before actual Chromium CDP emulation was added and WebKit
  was explicitly classified UNSUPPORTED.
- Later Chromium failures were not confined to the original landscape cell:
  320×740 light 200%, 844×390 light/dark 200%, and 820×1180 light/dark 200%
  encountered missing Hub Open readiness, Add token waits, assignment navigation
  waits, empty Preview content, an onboarding footer wait, or an Open click
  interruption. Downstream coverage remained UNTESTED, not implicitly passed.
  The failed preflight specifically timed out waiting for the synthetic Preview
  document and left 14 downstream rows UNTESTED.
- The [01:51:36.896 landscape Open-click trace](https://github.com/addiberra/uatu/blob/373ef6350032f6a0f2a91c2037ebafb553bc002f/openspec/changes/restore-refined-mobile-hub-experience/review-evidence/responsive/history/2026-09-10T01-51-36-896Z/results.json)
  also explicitly records the Settings button in the Hub dock **intercepting
  pointer events** before a later click attempt and timeout. Preserve this
  actionability/occlusion observation; the history cannot all be reduced to
  network waits, and cleanup does not establish its cause or resolution.
- Three green 1070-row runs were followed by the **1001/4/46/1** run despite
  `closeConnections: true`. Keep-alive is not an established cause; increasing
  waits and the final 1102-row pass do not close transport/harness investigation.
- WebKit reduced-transparency emulation remains UNSUPPORTED. Physical keyboard,
  VoiceOver/screen readers, OS text scaling/accessibility settings, real-device
  safe areas, complete interior regression and human visual/interaction approval
  are not certified by this matrix. No new pass or gate closure is claimed.
