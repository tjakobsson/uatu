## Context

The burden meter currently lays out the headline, level badge, precise anchor, and numeric score in one flex row. The anchor is also forced to `white-space: nowrap`, so a long configured `review.baseRef` has no place to go within the narrow and resizable Change Overview sidebar.

The anchor is intentionally precise and portable under the existing `change-review-load` contract. Hiding it, replacing it with a generic label, or relying only on the separate Base fact would weaken that contract.

## Goals / Non-Goals

**Goals:**

- Preserve a stable first row containing the review-burden headline, level badge, and numeric score.
- Give the complete precise anchor a dedicated line that can wrap within the meter.
- Prevent the meter from creating horizontal overflow at narrow sidebar widths.
- Cover the failure with a browser-level layout regression test.

**Non-Goals:**

- Change base-ref resolution, compare-target behavior, burden scoring, or configuration.
- Shorten, normalize, or otherwise alter the resolved ref displayed to the user.
- Redesign the rest of the Change Overview pane.

## Decisions

### Use a two-row meter layout

The headline and level remain grouped with the score on the first row, while the anchor occupies a second row across the available meter width. This keeps the score visually stable and gives an unbounded ref a predictable place to wrap.

A single wrapping inline row was considered, but its wrap point depends on the combined widths of every item and can leave the score or level in an isolated, confusing position.

### Preserve and wrap the complete anchor

The anchor will use overflow wrapping rather than ellipsis. Git refs can share long prefixes, so truncation may hide the distinguishing part of the configured ref. A tooltip-only recovery path would also make the precise value less accessible on touch devices.

### Verify rendered geometry in E2E coverage

The regression test will configure a deliberately long valid base ref, constrain the sidebar to a narrow width, and verify that the meter does not overflow horizontally while the headline, level, score, and complete anchor remain rendered. Geometry coverage is appropriate because string assertions alone cannot detect the layout failure.

## Risks / Trade-offs

- [Long refs increase the meter height] -> Allow the pane to grow vertically; retaining the complete anchor is more valuable than forcing a fixed-height card.
- [Browser geometry assertions can be brittle] -> Assert containment and visibility relationships rather than exact pixels or line heights.
- [Arbitrary wrapping can split ref segments] -> Prefer natural wrapping opportunities while retaining an anywhere fallback for a single unbroken segment.
