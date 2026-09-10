# Isolation evidence (tasks 7.3 / 7.4)

Test-owned evidence only. No production Hub, CLI, backend, credential tool,
provider or PTY is started. Scripts write only here, never retained goldens.
Run from repository root with existing Bun/Playwright installations.

## Verified on 2026-09-10

- **Bundle isolation:** Bun 1.4.2 builds the unchanged entry selection
  `src/index.html` (no review-entry plugin), reusable mobile coordinator and both
  mobile CSS entries. External source maps inventory the emitted runtime modules;
  forbidden test/fixture/server/privileged modules and known synthetic/controller
  output markers fail the audit. Type-only server DTO imports do not count as
  runtime imports. `bundle-audit.json` retains module lists, output hashes/sizes,
  source/font/retained-desktop-image hashes. Build outputs stay in memory; only
  JSON evidence is written. This is the browser production graph, not a compiled
  CLI binary or a claim that the unintegrated coordinator ships today.
- **Actual desktop Hub:** `isolation-browser.ts` imports only the read-only page
  generator and serves its original HTML through Playwright request fulfillment
  at `http://isolation.invalid`. No listener, production Hub or backend is used.
  Login, dashboard, Settings, Add workspace and stopped page are captured at
  1440×1000, DPR 1, light, fine pointer, in Chromium 153.0.8010.12 and WebKit 26.6.
  The actual bundled mono font is fulfilled from an exact approved asset path.
  Unknown reads and all mutations fail, with zero unexpected reads, mutation
  attempts or page errors in the final run.
- **Native inset behavior:** every page in both engines increases computed main
  top padding by exactly 72 CSS px when the existing native contract
  `--titlebar-inset:72px` is applied. `*-native-*.png` records the result. No new
  coordinator root or foreground attribute appears in desktop Hub documents.
- **Full-document navigation/event separation:** actual desktop Dashboard →
  Settings anchor navigation replaces the document/window sentinel, and a
  deliberately installed old-document keyboard listener cannot fire while
  typing in the Settings form. No workspace find bar/root appears, and no
  background workspace operation is emitted. This verifies this navigation
  boundary, not exhaustive enumeration of every possible global listener.
- **Workspace interior isolation:** `isolation-interiors.ts` builds current
  standalone original-entry and integrated review-entry pages separately, serves
  both via existing synthetic protocol doubles on ephemeral loopback ports,
  and closes both servers in `finally`. At 390×844/DPR 1/light/reduced motion,
  actual Preview interior text/DOM/style/geometry and pixels are **exactly equal
  (0 differing pixels)** in both engines. Four interior and four full viewport
  PNGs expose rather than mask the intentional handle/selector/pill overlay
  differences. No interior CSS is changed for the comparison.
- **Retained references unchanged:** audit recomputes the baseline's canonical
  reference and archive aggregates and asserts exact equality. The 52 reference
  files (including both `main-*-interior.png` signatures) retain aggregate
  `38940ab1a56a7195f574b1dd3a124d463946ff864ed513384849a13f4bfea6b0`;
  the 25 archived files retain
  `123a7512ad3b3b5b0043d298c7d9500f70a9ece30e48e9d160603281e5f7de60`.

## Pre-change desktop comparison (not golden updates)

Original `tests/e2e/hub-mobile-baselines/*.png` files are never written. Pixel
comparison is unmasked RGB equality after browser PNG decode; no tolerance,
resizing or replacement baseline is applied. Differing dimensions are explicitly
reported as non-comparable, not cropped to manufacture a pass.

| Page | Chromium versus retained Chromium | Interpretation |
|---|---|---|
| Login | 46 / 1,440,000 pixels differ, maximum channel delta 5 | Near-identical, not byte/pixel equality |
| Dashboard A running/B stopped | 56 / 1,440,000 differ, maximum channel delta 5 | Near-identical, not byte/pixel equality |
| Stopped A | **0 differing pixels** | Exact capture equality |
| Settings | retained 1440×1340, actual 1440×1125 | Synthetic catalog/device/tool omissions; no parity claim |
| Add workspace | retained 1440×1084, actual 1440×1093 | Synthetic folder/credential data differs; no parity claim |

Dashboard names, displayed temporary path, assignment labels, and version text
are transcribed from the retained screenshot as display-only strings. Neither
that folder nor its credentials are accessed. Two stable synthetic ids are used.
Settings uses an empty credential/tool/device catalog; Add workspace uses an
empty `/synthetic/home` listing. These substitutions are explicit gaps, not
unavoidable platform limitations: fuller safe DTO recreation could close them.
SSH-expanded Settings is not recaptured.

The same repo mono font is used, with no font/CSS injection or font substitution;
system sans rendering remains platform/engine-dependent. The small Chromium
differences are reported, not attributed conclusively to antialiasing. WebKit
images are also compared to the **Chromium** retained images for inspection only:
login 4,469, dashboard 17,766, stopped 5,056 differing pixels; no pre-change WebKit
golden exists. Full numeric results and generated HTML/style signatures are in
`desktop-results.json`.

## Important limits / tasks remain partially open

1. **Cannot certify original desktop generator/CSS bytes against the dirty-tree
   baseline.** `baseline.json` captures one aggregate for 1,632 repository files,
   not per-file hashes or source snapshots. That aggregate now differs because
   implementation changed other files. Its recorded HEAD predates existing dirty
   changes to `pages.ts`, so `git show HEAD:src/hub/pages.ts` is not the requested
   baseline either. Current generator/style/source hashes are recorded but are
   not retroactively blessed as pre-change hashes. This worker made no product
   edits. Retained Chromium pixels provide much stronger observed desktop parity
   than an unsupported unchanged-bytes claim.
2. Current standalone versus integrated comparison covers **Preview document
   interior**, not Files/Chat/Terminal interior pixel equivalence. Existing
   pre-change workspace PNGs have other corpus, metadata, version and runtime
   state; their signatures are retained, not passed off as matched current
   synthetic renders. The full current workspace screenshots are available to
   inspect intentional overlays. Pre-change desktop A/B interior pixel parity
   and complete synthetic four-surface comparison remain gaps.
3. `--titlebar-inset` is the actual web contract, but the SwiftUI wrapper,
   Keychain/cookie integration, native titlebar events and actual native process
   are not launched or certified. No physical-device/live-service claim.
4. Source-map inventory describes **emitted runtime** modules. It is not a
   static proof that no unused/dead import ever exists. CSS entry inventory names
   the entry (Bun emits no CSS source map here); built CSS text is marker-audited.
   Minification is disabled for audit readability; original entry selection,
   dependency resolution and browser build target remain production ones.

## Commands and results

All commands ran with already-installed dependencies; no tool installs, commits,
live production services, Tailscale changes, providers or PTYs.

```sh
bun tests/mobile-hub-review/isolation-audit.ts
# PASS; bundle-audit.json
bun tests/mobile-hub-review/isolation-browser.ts
# PASS behavioral assertions; desktop-results.json and 20 captures
bun tests/mobile-hub-review/isolation-interiors.ts
# PASS exact current interior comparisons; interior-results.json and 8 captures
bun tests/mobile-hub-review/compatibility.ts
# PASS Chromium/WebKit × original-entry standalone desktop/touch (4 cases)

bun test src/shared/app-url-discipline.test.ts src/hub/pages.test.ts src/hub/mobile-presentation.test.ts src/hub/return-navigation.test.ts src/shell/hub-nav.test.ts src/shell/presentation-storage.test.ts src/preview/file-siblings.test.ts src/preview/load-generation.test.ts src/hub/mobile/coordinator-context.test.ts src/hub/mobile/coordinator.test.ts src/hub/mobile/frontend.test.ts src/hub/mobile/flows.test.ts
# 205 pass, 0 fail, 1420 assertions, 17 files, 710ms

bunx --no-install tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --types bun-types --lib ESNext,DOM,DOM.Iterable src/styles.d.ts src/assets.d.ts tests/mobile-hub-review/isolation-audit.ts tests/mobile-hub-review/isolation-browser.ts tests/mobile-hub-review/isolation-interiors.ts
# PASS
bunx --no-install tsc --noEmit
# PASS product type check
```

Development corrections: first audit attempted Bun's broad `onLoad` observer,
which triggered a Bun 1.4.2 internal bounds panic; final audit has no plugins and
uses source maps. Initial read-only browse mock used `entries` instead of `dirs`,
and initially lacked manifest fulfillment; corrected to the actual page contract
before final passing captures. The first ad-hoc type command omitted the repo
SVG declaration; final command includes `src/assets.d.ts`. No product fixes were
made to accommodate these harness issues.
