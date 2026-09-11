# Corrected Hub / workspace chrome — awaiting visual approval

Implementation and browser verification recorded 2026-09-09. This is the actual
frontend with synthetic services, **not a new approved golden set**, a live Hub
validation, or completion of the human acceptance gate. Initial discovery actuals
and measurements remain in the parent directory. Earlier derived PNGs from both
galleries were removed in the approved cleanup and are recoverable at their
original paths in pre-cleanup Git commit `8fc4811`. Canonical originals, all
actuals and latest `review-ready/` derivatives remain; historical results and
failures below have not been rebaselined.

## Start here

- [Actual gallery](index.html): **25 reference-associated actuals per engine**, plus
  three explicitly unpictured accessibility captures per engine. Each compared
  actual names its canonical original reference; older composites are in Git.
  The original eight states also have initial-actual / corrected-actual pairs.
- [Pixel summary](diff-summary.md), [selected geometry](geometry-summary.json).
- [Chromium measurements](chromium-measurements.json) and
  [WebKit measurements](webkit-measurements.json): full computed metrics,
  assertions, mutation sensitivity, browser versions and relevant source hashes.
- [Current-interior before/after comparison](current-interior-comparison.json).
- [Retained initial discovery](../README.md).

## What changed (owned files only)

`src/hub/mobile/styles.css`:

- Normalize the real Side select's WebKit appearance; draw local-vector
  up/down chevrons with CSS masking. Field is52px in both browsers, with separate
  label/value space. Em-based spacing grows with enlarged text; focus stays visible.
- Match sheet top≈445px by tuning header spacing, not hardcoding sheet height.
- Reduce brand gap5px and row padding1px; h1 weight750→700; strengthen folder
  stroke. Running/Ready groups now align within≈1px of the reference.
- Reserve short Settings values' intrinsic width without global `nowrap`:
  “7 seconds” stays one line normally and can wrap at enlarged sizes.
- Bring Return divider toward reference by adjusting its wider segment ratio.

`src/styles.css` navigation section + navigation SVGs in `src/index.html`:

- Expanded selector366×54 at(12,780); equal destination segments,11px regular
  labels,20px local outline icons. **Every interactive destination/Close target
  remains at least44×44**, including the narrower Close button.
- Soft76% white glass, blur24/saturate1.3, luminous rim and low-alpha shadow.
  Terminal uses84% deep-blue glass, cyan rim/highlight and pale cyan selection.
- Preview now has browser-window silhouette, Terminal an unboxed chevron/
  underscore, handle a local SVG rather than a text glyph.
- The handle's44×44 hitbox stays edge-attached; its26×40 visual face is aligned
  to the actual edge on both sides. Attention and placement logic are untouched.
- Opaque/outlined contrast and system forced-color alternatives are explicit.

`src/preview/file-navigation.css`:

- Remove the dark normal-state perimeter; use white luminous rim,76% material,
  blur24 and soft shadow. Preserve explicit high-contrast/system borders.
- 13px Files label, vector-like CSS chevrons, pale disabled boundary arrows,
  thin divider; all actual buttons still at least44px.
- 12px side inset; collapsed pill bottom10px, expanded pill12px above selector.
- Error card remains separately warm outlined above the pill; Retry stays44px.

No frontend/coordinator/flow/tab-bar logic, server, configuration, desktop Hub
rules, workspace interior rules, dependencies, tasks or planning artifacts edited.
The existing navigation owner still supplies visual-viewport/keyboard coordinates;
CSS adds the optical inset without overwriting its inline offsets.

## Measured normal-state corrections

Reference coordinates are manually read from approved390×844 normalized PNGs
(roughly±1px), not inferred from gallery CSS. Actual values are computed DOM bounds.

| Element | Reference≈ | Initial actual | Corrected Chromium / WebKit |
|---|---|---|---|
| Running group y / height |178 /104|183.89 /105.13|178.89 /104.13, both|
| Ready group y / height |330 /312|336.56 /315.38|330.56 /312.38, both|
| Settings identity y |122|127.09|122.09, both|
| Side sheet top |445|441.20 /471.55|444.20 /445.55|
| Side field y / height |552 /52|551.69 /52;581.36 /23|551.69 /52;552.36 /52|
| Workspace selector x,y,w,h |12,780,366,54|8,773.44,374,62.56|12,780,366,54, both|
| Preview pill expanded y / height |714 /54|711.44 /54|714 /54, both|
| Preview pill collapsed y / height |780 /54|782 /54|780 /54, both|
| Hub dock x,y,w,h |20,764,350,66|20,765,350,65|unchanged; within1px|
| Return divider x |192|≈196|≈192.5–192.9|

Computed tests use reference-derived geometry tolerances (1.5px for Hub/sheet,
0.1px for fixed normal selector dimensions),52px field height, no label/value
overlap, typography, SVG presence, glass/rim colors and blur, and44px minimum
targets. They **do not** accept a pixel-error threshold as visual approval.

### Pixel evidence improved, but isn't a golden pass

Percentage of full-frame pixels with any RGB channel delta>16:

| State | Initial Chromium / WebKit | Corrected Chromium / WebKit |
|---|---:|---:|
| Hub |11.11% /11.19%|8.04% /8.13%|
| Return Hub |11.46% /11.51%|8.27% /8.35%|
| Settings |9.58% /9.91%|7.31% /7.65%|
| Side sheet |9.71% /13.13%|7.94% /8.64%|
| Preview expanded |12.83% /12.96%|11.78% /11.91%|
| Terminal expanded |7.31% /7.37%|5.58% /5.59%|

The main current Preview and Terminal interiors (upper390×650 of expanded
captures) are **pixel-identical to initial current captures in both engines**:
zero RGB error, zero differing pixels. This is a separate before/after check,
not permission to mask the full-frame reference comparisons. No historical
interior crop was installed as a current workspace golden.

## Actual state and regression coverage

Every engine captured these reference-associated states:

- Hub, visited Return, Settings, Preview-side sheet.
- Preview expanded/collapsed; Files collapsed; Chat expanded/collapsed.
- Terminal expanded/collapsed, right-edge collapsed and expanded after moving
  the handle right; dark Preview and dark Terminal expanded/collapsed.
- Single-file pill on right; first/middle/last sibling on right; last sibling
  on left; right-side raised pill with expanded selector (reference23).
- Index error and real client document timeout, separately outlined Retry,
  usable Files, no false first/last boundary; both explicit retries recovered.

Additional actual captures: increased contrast Preview, forced-colors Preview,
and enlarged Hub/sheet at390×844. Both engines emulated forced colors. Checks
confirm opaque/no-blur contrast material, system-border/no-shadow forced colors,
no enlarged-value overflow, separated enlarged Side label/value,≥100px enlarged
field, and footer actions within the viewport. Font enlargement doubles a
snapshot of Hub/chrome computed font sizes, **not current workspace interiors**;
the test resets the snapshot before creating a new sheet to avoid double-scaling
inherited fonts. This is not a claim to have tested physical-device font settings.

All three deliberate mutations are rejected in **each** browser:

1. Hide all Hub dock SVGs → icon check fails.
2. Change heading to17px/weight400 → hierarchy check fails.
3. Remove blur/shadow and make dock opaque → material check fails.

Temporary mutation styles are removed before subsequent captures. No production
source is mutated by a test; no icons, material, focus ring or dimmed context is
masked. `visual-checks.ts` contains the normal-state computed regression gates;
`visual-css.test.ts` adds focused source/CSS guards for the native control,
scalable spacing, normal/contrast material, vectors and zero permanent gutter.

## Fixture / comparison boundaries

- Explicit iPhone13 viewport override390×844, **not descriptor default390×664**;
  device descriptor DPR3 with actual `scale: css`. Retained780×1688 originals
  are Canvas-normalized2→1 according to the approved index. No claim of recovered
  historical DPR. Original SHA-256s are recorded per comparison.
- Mock mixed state is adjusted through its backend to one running + three
  stopped workspaces and one unprotected SSH credential. UatuCode branding,
  synthetic labels/paths, truthful credential state and current content are
  explicit substitutions, not reasons to hide layout mismatch.
- Later sibling scenarios extend the test-owned in-memory corpus with
  SECOND.md / THIRD.md and protocol-compatible document responses. They retain
  the real SSE transport and use the existing bounded synthetic personal-state
  model with the added paths. No host docs are read/written. Fixtures and
  generated timestamps are restored after each engine.
- Recovery snapshots increment the deterministic synthetic `generatedAt` so
  the normal freshness owner receives a genuinely newer snapshot. A frozen
  timestamp had correctly prevented stale state from acting as recovery during
  development; that was a fixture issue, not a product fix.
- A held third-document response plus Playwright's browser clock triggers the
  real10s client timeout. We do not wait10 wall-clock seconds because the
  existing synthetic SSE stream has no heartbeat against Bun's10s idle default.
  A fresh synthetic snapshot/online transition reopens the stream after the long
  Hub detour. Occasional Bun idle warnings in exploratory runs are a harness
  limitation, not evidence of a live stream failure. The final capture command
  completed; its only HTTP error diagnostics were the two deliberate503s.
- The archived boundary/error files show SVG image interiors; these tests use
  current Markdown interiors to exercise the same overlay states. Right-side
  single/boundary/handle adaptations compare to the retained left-side image
  without secretly mirroring it; they are labeled adaptations, not exact
  photographed compositions. Reference23 provides the exact expanded right-side
  composition. Whole-frame boundary diffs≈20–22% include these interior/data/
  placement differences and **must not become accepted pixel tolerances**.

## Verification commands and results

Historical commands/results follow. Do not rerun capture/report commands merely
to verify cleanup: they write evidence, including pixel/geometry summaries.

```sh
bun tests/mobile-hub-review/visual.e2e.ts
bun openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual/report.ts
bun openspec/changes/restore-refined-mobile-hub-experience/review-evidence/visual/interior-check.ts
bun test tests/mobile-hub-review/visual-css.test.ts src/preview/file-siblings.test.ts src/preview/load-generation.test.ts src/shared/app-url-discipline.test.ts
bun test src/hub/mobile/frontend.test.ts src/hub/mobile/coordinator-context.test.ts src/hub/mobile/coordinator.test.ts tests/mobile-hub-review/server.test.ts tests/mobile-hub-review/protocols.test.ts tests/mobile-hub-review/transport.test.ts
bun run typecheck
bunx --no-install tsc --noEmit -p tests/mobile-hub-review/tsconfig.json
git diff --check
```

- Visual runner: **PASS**,25 comparisons +3 extension actuals per engine;
  computed geometry/material/target/boundary/error/recovery gates and mutation
  sensitivity passed. **56 actual captures** total.
- Report and current-interior comparison: **PASS**, zero interior pixel deltas.
- First focused unit command: **17 pass,0 fail,44 expectations,6 files**.
- Hub/harness unit command: **35 pass,0 fail,388 expectations,6 files**.
- Both typecheck commands: **BLOCKED by the same unowned error** at
  `src/hub/mobile/clone-flow.ts:99`: `CloneIntent` lacks required `attemptId`
  for `CloneSubmissionIntent`. No diagnostics in this worker's files. The flow
  owner must reconcile that concurrent contract change; it was not patched here.
- `git diff --check`: **PASS**.

Runner is standalone Bun using the existing review server at **port0**, serial
Chromium/WebKit and `finally` cleanup. No4703 conflict, services left running,
Tailscale, installs, production server, PTY/provider, real credentials or commits.

## Ready for review vs remaining gaps

**Ready for focused user review:** corrected normal Hub hierarchy/spacing,
WebKit/Chromium52px Side field and sheet geometry, short Settings value layout,
Return proportion,366×54 accessible selector, pill material/placement,
Terminal palette/vector, left/right and boundary/error chrome, and the pictured
current-interior preservation evidence. No numeric target-size exception was
needed to achieve the54px selector: its targets are44px inside a10px material rim.

**Not acceptance-complete:**

1. Default handle y remains572.47, versus archived≈588 (≈15.5px higher).
   The existing placement owner/default ratio is outside this worker's logic
   scope. Edge alignment,44px target and right movement are verified. Changing
   visual margins to fake the vertical position would break drag/clamp semantics;
   the lead should ask the placement owner to tune it or explicitly review the
   current default as an exception.
2. Settings Workspace group remains≈202.5px vs reference≈195; Account begins
   ≈730 vs724. Values no longer wrap unnecessarily, but remaining row rhythm/
   subtitle line metrics need optical review before exact-fidelity approval.
3. System font rendering, short fixture text and some icon optical weights still
   differ from the photographed source. Reference deltas are documented, not
   blessed. Normal WebKit field autofocus retains a visible accessibility focus
   ring absent from the reference.
4. Full320px/landscape/tablet/keyboard/pinch/safe-area and physical-device matrix,
   attention/drag/idle/Keep Open behavior, dark Hub, other task sheets and complete
   desktop/native screenshots are not certified by this CSS work. Existing
   interaction logic was preserved; the full task6.1/7.2 inventory is lead-owned.
5. Typecheck must become green after the clone-flow owner adds attempt identity.
   The user must still explicitly approve visual and interaction behavior. No
   live integration, task checkbox, archive or golden promotion is authorized.
