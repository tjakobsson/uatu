# Approved-scope fresh/reset handle calibration

> Start with the [current evidence index](../README.md) and [current verification](../verification.md). Status and generated-artifact paths below are historical at pre-cleanup commit `373ef6350032f6a0f2a91c2037ebafb553bc002f`; they do not assert fresh passes or close pending gates.

This follow-up intentionally changes the **fresh and explicit-reset default**
only. It does not claim the old0.72 and new≈0.7373 values are equivalent, change
the placement mapping, retune saved placements, migrate storage or add fields.
The earlier motion audit/`*-handle.json` remain historical evidence.

## Change

`DEFAULT_NAVIGATION_PLACEMENT` in the existing browser preference owner provides
`side: left` and `position: 73.73 / 100`. The percentage expression ensures native
range input parsing and Home produce the same JavaScript double. This is≈0.7373;
the existing persisted field remains an ordinary number with unchanged meaning.

At390×844, using the unchanged44px target and8px clamped-travel edge inset:

`visual face top = 8 + (844 - 16 - 44) × 0.7373 + 2 = 588.0432px`.

The reference face begins around588px. Previously, a fresh0.72 value placed it
at574.48px. **An explicitly saved0.72 still produces574.48px**, on either side.

The Home shortcut and Hub sheet's Reset handler now consume that one shared
placement value. Reset remains a draft until Done; Cancel leaves saved placement
untouched. Both the Hub and workspace handle ranges initialize with `step=any`,
avoiding native whole-percent rounding of current fractional values.

The Hub sheet captures the native initial control value and commits only changed
placement fields. No-op Done does not rewrite storage at all; a side-only edit
does not convert the untouched position through a percentage round trip. This
preserves exact saved doubles, not merely visually equivalent rounded positions.

No other frontend flow or CSS was changed. The applicable touch-navigation specs
require clamped placement, persistence and keyboard reset but prescribe no numeric
default. The old0.72 occurrences in the prior evidence are observations, not a
fixed numeric spec requirement.

## Verification scope

- Fresh/default face placement at390×844, with default side still Left.
- New default at320×740 and844×390;44px targets and viewport bounds retained.
- Saved Left/Right0.72 placement remains at the old calculated pixels at all three
  sizes, survives reload, is not rewritten on read/resize, and survives Reset/Cancel.
- Unit tests also retain exact stored0,0.1,0.721234,0.7373,0.98 and1 ratios,
  scope promotion, external storage updates and storage-denial behavior.
- Home and Reset/Done share the exact default; other preference fields and the
  four-field serialized shape remain unchanged. No navigation preferences are
  sent through Hub operations or personal-workspace backend patches.
- Keyboard movement still clamps at both ends in short landscape.

New evidence files are `*-handle-default.json`, `*-handle-default-image.png`,
`*-handle-saved-left.json` and `*-handle-saved-right.json`. They intentionally do
not overwrite the old-default `*-handle.json` records or reference PNGs.

```sh
bun test src/shell/navigation-preferences.test.ts src/hub/mobile/frontend.test.ts
UATU_MOTION_EVIDENCE=1 bunx --no-install playwright test --config playwright.mobile-hub-review.config.ts motion.e2e.ts
bunx --no-install tsc --noEmit
bunx --no-install tsc --noEmit -p tests/mobile-hub-review/tsconfig.json
```

Synthetic frontend verification only; no live backend/preferences API, physical
device approval, dependencies, migration, commits or task-checkbox edits.

## Final recorded results

- Focused units:109 passed,495 expectations across7 files.
- Full motion/placement suite:22 passed,11 per engine. The calibrated face top
  measured588.03125px in both Chromium and WebKit. Saved0.72 positions retained
  their previous coordinates and raw stored JSON.
- `git diff --check`:pass. Review listener stopped after verification.
- Repository `bun run typecheck`:pass. Review-runtime type checking:pass after
  including the existing `src/assets.d.ts` in the review test configuration.
  No product asset declaration or SVG workaround was added.

The approved ownership extension resolved the previous whole-percent range
initialization issue. Browser regressions verify exact raw stored JSON (including
whitespace) for saved0.723456,0.72 and0.7373 through open/Done in both sheets. A
fresh calibrated default remains unpersisted through no-op Done, and side-only
edits retain the untouched ratio exactly. No remaining authorization is needed
for this current-value/no-op fix.
