# Task 7.1 — initial visual discovery, not acceptance

Captured 2026-09-09 using installed Playwright **Chromium and WebKit**, real current
frontend, existing synthetic review server. No live Hub, Tailscale, provider,
shell, package install, server/config/product edit, or approved golden update.
The server uses **port 0** (OS-assigned loopback port), browsers run serially,
and both browsers/server close in `finally`. Nothing uses the other worker's 4703.

## Browse / reproduce

- Open [index.html](index.html): all 16 retained actuals with their original
  reference names. Earlier derived comparisons are available in Git (see below).
- [diff-summary.md](diff-summary.md): numerical pixel comparison for every image.
- [chromium-measurements.json](chromium-measurements.json) and
  [webkit-measurements.json](webkit-measurements.json): computed typography,
  geometry, colors, material and icon counts, plus mutation-check results.
- [geometry-summary.json](geometry-summary.json): selected measurement subset.

```sh
bun tests/mobile-hub-review/visual.e2e.ts
bun openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual/report.ts
```

These are historical capture/report commands, not cleanup verification commands;
running them may overwrite evidence. The report now targets the corrected gallery.
The `.e2e.ts` is a standalone Bun discovery runner, not a snapshot assertion suite;
it programmatically reuses the existing server rather than the fixed-port
Playwright config. Preserve this initial evidence before recapturing after fixes.
No actual image is installed as a golden or asserted to match itself.

The iPhone 13 descriptor is explicitly overridden to **390×844 CSS pixels**;
it is not the descriptor's 390×664 browser viewport. Actuals use `scale: css`.
Original 780×1688 images are resampled to 390×844 using browser Canvas according
to the approved normalization index; originals are untouched. The normalization
is not a claim to know historical browser DPR. Each state originally had five
PNGs: `{chromium,webkit}-{state}-{actual,normalized,side,overlay,diff}.png`.
The approved cleanup removes only the 64 derived PNGs in this directory and
200 in `corrected/` (nonrecursive `*-{normalized,side,overlay,diff}.png`). All
actuals, canonical originals, measurements and latest `review-ready/` derivatives
remain. Earlier composites are recoverable from pre-cleanup Git commit `8fc4811`
at their original paths; this is a normal cleanup, not artifact-history removal.
Historical results and failures below are unchanged, not rebaselined.

States: `hub`, `visited-return`, `settings`, `preview-side-sheet`,
`preview-expanded`, `preview-collapsed`, `terminal-expanded`, `terminal-collapsed`.
The retained anchors are respectively 01, 08, 15, 22, 04, 02, 10, 09. All are
compared unmasked, including icons, material and the actual dimmed Settings.

Fixtures: reset mixed; create two stopped synthetic workspaces through the mock
backend (one running + three ready, matching reference density); delete four
unused synthetic credentials through the mock backend (one SSH row, matching
reference density). No DOM content replacement. Remaining SSH is unprotected,
not the reference's unlocked key; truthful state/text substitution is allowed.
Atlas is actually entered, Terminal actually attached, then Hub/Settings visited.
Workspace Preview has one confirmed file, so absent sibling arrows are correct,
not a missing-icon finding. Workspace interiors remain current, not historical.

## Concrete correction findings for the lead

Reference bounds below are manually read from normalized pixels, approximately
±1px. Actuals are DOM bounds, not inferred from gallery CSS. Font sizes/weights
for actuals are computed; exact historical font CSS cannot be recovered from PNG.

| Priority / surface | Evidence and quantified mismatch | Specific correction recommendation |
|---|---|---|
| **High: WebKit Preview-side field** | Reference white field ≈52px high at y552. Chromium is 52px at y551.69; **WebKit only 23px at y581.36**, value overlaps Side label and native focus ring. Entire sheet starts y471.55 instead of reference y445 (26.55px too low), versus Chromium y441.20. | In `src/hub/mobile/styles.css`, explicitly normalize `.mh-side-field > select` native WebKit appearance (`appearance: none; -webkit-appearance: none`) and supply a local vector chevron. Give the field/select a reliable 52px height/min-height and separate label/value layout. Keep keyboard focus indication; don't hide it to improve screenshots. Recheck WebKit's native control sizing before tuning sheet padding. |
| **High: Preview pill dark perimeter** | Actual pill has obvious dark boundary in both Preview captures. Source confirms `.preview-nav-pill { border: 1px solid #767676; background: ...94%; box-shadow: 0 2px 12px #0003 }`. Reference is luminous translucent material without a dark normal-state perimeter. Actual single-file pill is 87.5×54 at x8. | In `src/preview/file-navigation.css`, replace normal gray perimeter with luminous white rim/subtle inset highlight, lower opacity/shadow density and use soft blur. Preserve opaque/system borders only for forced-colors/reduced-transparency variants. Keep 44px hit targets. Width difference due to one file is allowed. |
| **Medium: workspace selector proportions/type** | Reference expanded dock ≈x12,y780,w366,h54. Actual **x8,y773.44,w374,h62.56** in both engines: 8px wider, 8.56px taller, 6.56px higher. Actual labels visibly heavier/larger than reference. Actual white material is 96% opaque with blur16; reference shows substantially softer translucent treatment. | Tune `.touch-tab-bar` inset to 12px, bottom to 10px, vertical padding so visual dock ≈54px while retaining 44px targets; reduce `.touch-tab-label` size/weight toward reference's ≈11px regular and retain icon-above-label layout. Adjust translucency/rim after geometry. Do not change workspace interior layout. |
| **Medium: Terminal material** | Deep-blue palette and cyan selection are present, but actual rim is a thin flat cyan line; reference has a broader luminous white/cyan rim. Actual dock is same oversized 374×62.56. Actual selected Terminal vector is boxed, reference is unboxed chevron/underscore. | Tune terminal overlay-only rim with a subtle cyan inset highlight + soft outer glow; use the reference terminal outline silhouette for destination icon. Keep current actual xterm/keybar/output untouched. |
| **Medium: Hub vertical drift** | Reference Running group y178,h104; actual **y183.89,h105.13**. Ready group reference y330,h312; actual **y336.56,h315.38**. Bottom ends y651.94 instead of y642 (≈10px late), Add card also ≈11px late. Insets x20,w350 are correct. | Reduce pre-group accumulated spacing about 6px (`.mh-brand`/subtitle rhythm), then trim workspace row content-height about 1.1px (line-height/padding, not interactive targets). Start with brand bottom margin 23→18px and measure rather than shifting whole cards. |
| **Medium: typography optical mismatch** | Actual h1 34px/39.09px weight750; reference title ink ≈Workspaces x20..217, actual x20..224 (≈7px wider) and glyphs visibly tighter/heavier. Actual names are 17px weight650 and paths13px; hierarchy exists but weight/metrics differ visibly. | Review actual system-font resolution and change h1 weight toward700 / letter-spacing toward reference; do not claim exact old tokens. Compare before lowering font size. Keep path human-readable sans-serif. |
| **Medium: Settings auto-hide value wraps** | Reference “7 seconds” is one line. Actual is **two lines**, widening the row vertically; Workspaces group actual h202.52 vs reference≈195, and Account starts≈735 vs724. | `.mh-value` currently can flex-shrink; reserve intrinsic width (`flex-shrink:0`) for short settings values at normal text, keeping max-width/reflow rules for large text. Permit row labels to wrap independently. Do not globally force nowrap at200%. |
| **Low: Return divider placement** | Dock x20,y765,w350,h65 essentially matches reference≈x20,y764,w350,h66. Actual Return segment x25,w171.17(WebKit)/171.5(Chromium), divider near196; reference divider≈192. | Adjust `.mh-return` flex ratio/basis a few pixels rather than making three equal tabs. Preserve two-line muted Return-to / bold workspace hierarchy. |
| **Low: folder outline weight** | Folder silhouettes present but actual folder outline visibly thinner than retained reference in `*-hub-side.png` at CSS size24×26. Ellipsis circle is present, not replaced by text. | Compare path stroke attributes/painted extents against normalized folder (≈22×19px visible); increase folder stroke only as needed, not all icons indiscriminately. |

## Actual passes and limits

- Both engines completed eight captures each with asserted 390×844 viewport,
  four actual Hub rows, actual Preview ready and actual terminal attached.
- Current UatuCode branding retained; cool canvas, white groups, generous outer
  insets, blue vector folder/ellipsis/grid/gear, contextual Settings tiles,
  subordinate metadata and separate green status are present. This is not
  text-only chrome or an iframe/screenshot workspace surface.
- Hub dock computed material: `rgba(255,255,255,.76)`, blur24/saturate1.3,
  luminous inset1.5px and low-alpha shadow. Two-tab and wider Return variants
  exist. Geometry is close; small visual differences remain.
- Sheet really dims Settings at35% black, attaches to bottom, has grabber,
  centered bold header, separator, Cancel and saturated Done. Footer stays near
  y765 in both engines. Chromium field geometry is close; WebKit is a real gap.
- Collapsed navigation's interactive box is44×44; expansion is one row with
  Close, Hub, Files, Preview, Chat, Terminal. Preview pill moves from y711.44
  expanded to y782 collapsed. This discovery does not certify all drag/idle,
  keyboard, 200% text or accessibility behaviors.
- **Mutation sensitivity verified in each engine:** baseline checks all true;
  temporarily hiding all Hub dock SVGs makes `icons:false`; changing h1 to17px
  weight400 makes `hierarchy:false`; removing dock blur/shadow and setting opaque
  white makes `material:false`. Every expected rejection is asserted, recorded,
  then its temporary style removed before subsequent capture. No product source
  mutation. These checks catch gross regressions, not exact reference fidelity.

Full-frame numerical differences are descriptive, not acceptance thresholds:
Hub11.11–11.19% pixels over16; Return11.46–11.51%; Settings9.58–9.91%; sheet
9.71% Chromium vs13.13% WebKit. Whole-frame workspace differences include current
interior/data exceptions, so **must not become a workspace golden tolerance**.
Canvas browser resampling and antialiasing also contribute. Measurements include
laid-out elements in inert/visibility-hidden workspace roots; those entries are
not proof they are painted. Use actual screenshot evidence for visibility.

Remaining review gaps: no dark Hub approval, landscape/320px/200% visual audit,
reduced transparency/forced colors comparison, sibling/retry screenshot matrix,
or user visual/interaction approval. Initial discovery is complete; task7.1
acceptance and CSS corrections remain lead/user-owned.
