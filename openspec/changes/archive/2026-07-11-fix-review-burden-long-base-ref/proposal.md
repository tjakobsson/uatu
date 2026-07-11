## Why

The Change Overview's review-burden meter assumes its precise compare-target anchor fits on one line. A long configured `review.baseRef` can overflow the narrow sidebar or crowd out the burden level and score, making the readout difficult to understand and use.

## What Changes

- Make the review-burden meter accommodate long compare-target refs within its available width.
- Keep the "Review burden" label, burden level, numeric score, and complete precise anchor readable at narrow sidebar widths.
- Add regression coverage using a long configured base ref.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `change-review-load`: Require the precise review-burden anchor to render without horizontal overflow or obscuring the burden level and score when the resolved ref is long.

## Impact

- Change Overview markup and styling in `src/sidebar/change-overview.ts` and `src/styles.css`.
- Browser-level regression coverage in `tests/e2e/change-overview.e2e.ts` or the related compare-target suite.
- No API, configuration, scoring, dependency, or compatibility changes.
