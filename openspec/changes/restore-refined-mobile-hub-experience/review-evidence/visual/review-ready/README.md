# Review-ready visual recapture — manual approval awaiting

> Start with the [current evidence index](../../README.md) and [current verification](../../verification.md). Status and generated-artifact paths below are historical at pre-cleanup commit `373ef6350032f6a0f2a91c2037ebafb553bc002f`; they do not assert fresh passes or close pending gates.

**Final successful capture:** 2026-09-10, Chromium153.0.8010.12 and WebKit26.6,
Bun1.4.2. This directory contains **50 full-frame reference comparisons and six
accessibility-extension captures** of the actual frontend. It is evidence for
user review, **not approved goldens or a claim of exact visual acceptance**.

## Evidence entry points

- [historical index.html](https://github.com/addiberra/uatu/blob/373ef6350032f6a0f2a91c2037ebafb553bc002f/openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual/review-ready/index.html): all25 compared states per engine, original left /
  actual right, links to50% overlays and full absolute-RGB differences. Previous
  corrected / final actual pairs are available without modifying earlier images.
- [diff-summary.md](diff-summary.md):50 numerical comparisons with exact anchors.
- [summary.json](https://github.com/addiberra/uatu/blob/373ef6350032f6a0f2a91c2037ebafb553bc002f/openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual/review-ready/summary.json): selected geometry, errors, checks and provenance.
- [chromium-measurements.json](https://github.com/addiberra/uatu/blob/373ef6350032f6a0f2a91c2037ebafb553bc002f/openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual/review-ready/chromium-measurements.json) and
  [webkit-measurements.json](https://github.com/addiberra/uatu/blob/373ef6350032f6a0f2a91c2037ebafb553bc002f/openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual/review-ready/webkit-measurements.json): complete computed data,
  source hashes, explicit credential facts and mutation-check outcomes.
- [preservation.json](https://github.com/addiberra/uatu/blob/373ef6350032f6a0f2a91c2037ebafb553bc002f/openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual/review-ready/preservation.json): historical verification of **400 files
  unchanged before/after the capture**, including original references and
  initial/corrected visual reports/images. It is not a current-file inventory:
  the later approved cleanup removes 264 older derived PNGs and updates those
  galleries. Earlier composites remain recoverable from pre-cleanup Git commit
  `8fc4811` at their original paths. The manifest and recorded hashes are preserved
  unchanged, not rebaselined; all actuals, canonical originals, measurements and
  this latest gallery's derivatives remain.
- [current-interior-comparison.json](https://github.com/addiberra/uatu/blob/373ef6350032f6a0f2a91c2037ebafb553bc002f/openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual/review-ready/current-interior-comparison.json): independent
  comparison to the initial current Preview/Terminal captures, not historical
  prototype interiors.

## Final observed results

| Check | Chromium | WebKit |
|---|---|---|
| Reference-associated states captured/compared |25|25|
| Unpictured accessibility captures |3|3|
| Hub geometry/type/vector/material checks |Pass|Pass|
|52px Side field, label/value separation, sheet anchoring |Pass|Pass|
|366×54 selector, every destination/Close target≥44×44 |Pass|Pass|
| Fresh handle face at reference y≈588; left/right edge attachment |Pass|Pass|
| Pill clearance, translucent normal rim/material |Pass|Pass|
| First/last disabled, single-file arrows hidden, right/left placement |Pass|Pass|
| Separate timeout/index-error alert, Files usable, no false boundary |Pass|Pass|
| Explicit synthetic timeout/index retry |Recovered|Recovered|
| Deliberate missing-icon / flattened-heading / missing-material regression |All3 rejected|All3 rejected|
| JavaScript page errors |0|0|
| Unexpected HTTP errors / missing synthetic contracts |0 /0|0 /0|
| Expected injected HTTP error |One503 index failure|One503 index failure|
| Final run recorded Return pointer deviations |0|0|

The final successful run used ordinary pointer activation after the settled
Return reveal; neither engine used the runner's explicitly reported fallback.
Earlier intermittent Return observations are disclosed below, not erased by the
successful run. No forced click, screenshot overlay over product UI or DOM mask
was used.

### Key measured geometry (CSS px)

Reference values below are approximate manually read PNG coordinates, not
recovered prototype stylesheet tokens.

| Surface | Reference≈ | Final Chromium / WebKit |
|---|---|---|
| Hub Running group y,height |178,104|178.89,104.13, both|
| Hub Ready group y,height |330,312|330.56,312.38, both|
| Page heading |very large bold system sans|34px, weight700, line39.1px|
| Settings identity y |122|122.09, both|
| Side sheet y |445|444.20 /445.55|
| Side field y,height |552,52|551.69,52 /552.36,52|
| Workspace selector x,y,width,height |12,780,366,54|12,780,366,54, both|
| Selector surface buttons |at least44px targets|≈60.4×44, both; Close≥44×44|
| Handle visual face y |588|588.03, both|
| Handle face / interactive box |compact edge face,≥44px target|26×40 face inside44×44 target|
| Preview pill expanded y,height |714,54|714,54, both|
| Preview pill collapsed bottom clearance |10|10, both|
| Hub dock x,y,width,height |20,764,350,66|20,765,350,65, both|

The previously reported default handle vertical discrepancy is resolved in the
current source: the new assertion checks the **visual face** at588px, while its
larger hitbox begins586.03px. No accessibility exception was needed to shrink
interactive controls below44px.

Normal workspace glass is76% white, blur24/saturate1.3 with luminous rim;
Terminal is84% deep blue with cyan highlight and pale cyan selection. Outline
icons are present, including the unboxed Terminal symbol. Increased contrast
and forced colors use opaque/system alternatives instead of changing the normal
reference treatment. The enlarged sheet keeps label/value separate and both
footer actions within390×844.

### Eight core full-frame pixel comparisons

Pixels with any RGB channel difference>16, after approved CSS normalization:

| State | Chromium | WebKit |
|---|---:|---:|
| Hub /01 |8.04%|8.13%|
| Visited Return Hub /08 |8.27%|8.35%|
| Settings /15 |7.15%|7.50%|
| Preview-side sheet /22 |7.78%|8.49%|
| Preview expanded /04 |11.78%|11.91%|
| Preview collapsed /02 |11.49%|11.62%|
| Terminal expanded /10 |5.58%|5.59%|
| Terminal collapsed /09 |4.36%|4.38%|

These percentages describe differences, **not accepted tolerances**. Branding,
synthetic strings and current interiors contribute. Pixel differences are never
made green by replacing the reference with the actual capture. See all50 rows
in `diff-summary.md`.

The independent upper390×650 **current-interior** comparison finds zero pixels
with channel delta>16 in Preview and Terminal for both engines. WebKit is exactly
equal; Chromium has small nonzero mean RGB errors (Preview≈0.000509,
Terminal≈0.022529/255), so this report does **not** claim all four are pixel
identical. The full reference screenshots remain unmasked.

## Coverage inventory and substitutions

Each engine has the same25 compared states:

1. Hub, Preview expanded, Preview collapsed, Terminal expanded, Terminal
   collapsed, Terminal collapsed on right, Terminal expanded after moving handle
   right, visited Return Hub, Settings, Preview-side sheet.
2. Single-file right pill; first/middle/last sibling on right; expanded
   right-side controls (exact reference23 composition); last sibling on left;
   document timeout; index error.
3. Files collapsed; Chat expanded/collapsed; dark Preview expanded/collapsed;
   dark Terminal expanded/collapsed.

Each engine also captures increased-contrast Preview, forced-colors Preview and
enlarged Hub/Side sheet. These are explicitly unpictured extensions at this
viewport, not pre-approved reference states.

**Credential density is corrected at the service seam:** all original synthetic
credentials are deleted via backend operations. `generateSsh` creates a short
**“Review identity”**, then the existing test-owned `setKeyState` control supplies
the known **unprotected** state. `readCredentialFacts` is asserted to return
`protection:{status:"known",value:"unprotected"}` and
`lock:{status:"known",value:"unlocked"}`. The actual overview row is asserted to
show **Unlocked**. The source's new fact-driven summary—not name parsing or a
painted label—renders it. The shorter synthetic name substitutes for archived
“GitHub personal” while preserving one-row density. No key tool or real key
generation is invoked; the supplied string is disposable synthetic test data.

Hub uses one running +three stopped workspaces, created/read through the mock
backend. Current UatuCode branding is retained. Other labels, paths, branch facts
and identity strings are clearly synthetic. Sibling fixtures extend only the
test-owned corpus and bounded synthetic personal-state model with SECOND.md /
THIRD.md; current clients render protocol-compatible document responses.

The archived boundary/error images picture SVG interiors. Here they are current
Markdown interiors; this is an explicit current-interior/data substitution, not
a reason to replace current product content with the old artwork. Right-side
single/boundary/handle adaptations retain the original left-side reference
unmirrored and are named as adaptations; reference23 provides the pictured
expanded right-side comparison. Their≈20–22% full-frame differences must not
become an accepted golden threshold.

## Comparison and regression discipline

- iPhone13 descriptor is explicitly overridden to **390×844**, not390×664;
  actual screenshots use CSS scale. Original780×1688 images normalize2→1 using
  Canvas under the approved policy. Historical browser DPR remains unknown.
- For this review-ready capture, full originals, normalized originals, actuals, side-by-sides,50% overlays and
  absolute RGB diffs are retained. No masks hide vectors, material, dim hierarchy
  or focus rings. Original SHA-256 accompanies each comparison.
- Computed geometry tolerances:1.5px for manually read Hub/sheet coordinates,
 0.1px for fixed selector dimensions,0.1px for52px field height. These gates
  reject regressions but do not establish precise historical typography tokens.
- Existing mutation checks temporarily remove all dock SVGs, reduce heading to
 17px/weight400, or remove glass blur/shadow and make it opaque. Each specific
  check fails in both engines; temporary styles are removed before later captures.
- Root/font readiness and real client readiness are awaited. Captures concern
  settled states, not the240ms reveal midpoint. They do not certify motion
  interruption or no-focus-steal behavior under every timing.
- The existing synthetic SSE has Bun's10s idle limit and no heartbeat. The final
  runner requests a fresh, monotonically newer synthetic snapshot through the
  real online/recovery owner before normal Preview captures, and asserts no
  error alert before/after the screenshot. This prevents silently mislabeling
  an accidental idle failure as a normal boundary image. Intentional error/
  timeout captures are excluded from that refresh. Clock advancement triggers
  the real10s client timeout without a10s server wall-clock wait.

## Remaining deviations and observations requiring review

1. **Settings row rhythm remains different:** Workspace group height202.52px
   versus reference≈195 (**+7.52px**), Account begins≈729.81–730.48 versus≈724.
   “7 seconds” is correctly one line; the remaining row/line-height rhythm is
   still an optical deviation awaiting user review—not zeroed by a broad test.
2. **Small optical differences:** Hub dock differs≈1px in top/height; icon stroke,
   glyph metrics and remaining text density differ. Current names/logo are
   authorized substitutions, not blanket permission for arbitrary geometry.
3. **Accessible focus is visible:** WebKit's autofocused Side select retains its
   blue focus ring, absent from the unfocused reference. Normal and doubled-font
   label/value separation and reachable footer are verified. No focus masking.
4. **Intermittent post-Return pointer interception was seen during exploratory
   runs**, with `.xterm-screen` intercepting Preview after settled geometry.
   A diagnostic image is retained and linked in the gallery. Final records show
   `interactionDeviations:[]` in both engines and no fallback use. This successful
   run does not explain away the earlier observation; the lead should retain it
   as a targeted interaction/motion stability review item. The runner records a
   deviation and fresh-load continuation if it recurs, rather than forcing a
   click or falsely calling that retained pointer path passed.
5. **Harness transport limit:** exploratory runs also exposed SSE idle failures
   and whole-page load waits. The final runner waits DOM readiness plus actual
   client states and uses explicit fresh snapshots as above. Final console
   still included expected request cancellations from stream replacement and
   an idle warning; there were no unexpected HTTP statuses, page errors or
   missing contracts in final JSON. This is not live-backend stream validation.
6. Full320px/landscape/tablet/safe-area/keyboard/physical-device, rapid reversal,
   attention/drag/idle/Keep Open, dark Hub and desktop/native acceptance remain
   outside this recapture. **Human visual/interaction approval remains pending.**

## Reproduce / verification

```sh
bun tests/mobile-hub-review/visual.e2e.ts
bun openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual/review-ready/report.ts
bun run typecheck
bunx --no-install tsc --noEmit -p tests/mobile-hub-review/tsconfig.json
bun test tests/mobile-hub-review/visual-css.test.ts src/hub/mobile/frontend.test.ts src/hub/mobile/credential-facts.test.ts
git diff --check
```

- Final visual command: **completed both engines**,25 comparisons +3 extensions
  each; all stated computed and deliberate-mutation gates passed. Earlier
  exploratory failures are separately disclosed above.
- Both typechecks: **PASS**. The previous clone attempt-identity type error is
  no longer present in the current source.
- Focused tests: **48 pass,0 fail,357 expectations across3 files**.
- `git diff --check`: **PASS**.
- Historical capture-time evidence verification: **400 files unchanged** (not
  a claim that all files remain after the later cleanup).

This worker edited only `visual.e2e.ts`, `visual-checks.ts` and new files under
`visual/review-ready/`. No product/CSS/config/task changes, dependency installation,
Tailscale, live Hub, executable shell/provider, real credentials or commits.
The existing test server uses **port0**, engines run serially, browsers/server
close in `finally`; no review process is intentionally left running.
