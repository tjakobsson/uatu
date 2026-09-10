# Task 8.3 — why 19 mobile/ipad/touch-scroll tests fail

Evidence for the non-regression comparison task 8.3 still owes. The three
screenshots are Playwright's own failure captures from the real failing tests,
renamed. Regenerate them with a config that forces screenshots on:

    # scratch config: re-export the repo config with `use.screenshot: "on"`
    bunx playwright test -c <that-config> --output=test-results/8.3-diagnosis \
      --reporter=line \
      -g "boot lands on Preview with the tab bar visible|tree state is continuous across tab switches|activating the Terminal tab lands in true fullscreen"

then copy each `test-failed-1.png` to the friendly names below.

All three failures share one root cause: the tests encode the **superseded
full-bleed tab bar**, while this change ships a floating, auto-hiding pill.
None of them is a product regression. Each needs a decision, not a relaxed
assertion.

## 1-bar-is-inset-pill-not-full-bleed.png

`mobile.e2e.ts:130` — `expect(barBox.width).toBeGreaterThanOrEqual(389)`; got 374.

The bar is now an inset pill (390px viewport − 8px insets = 374) with rounded
corners and a separate actions row ("Preferences") above the four surface tabs.
`:133` additionally demands exactly 4 buttons in the bar; the new bar also
carries Close, Preferences and, under a Hub, a Hub link. The new Preview
overlay (Back to Files / Previous / Next) is visible above it.

## 2-bar-auto-hidden-to-handle.png

`mobile.e2e.ts:197` — times out on `locator('#touch-tab-preview')`.

The bar has auto-hidden after its idle interval; only the small chevron handle
remains on the left edge. Tabs are unreachable until the handle is clicked, and
tests written against an always-present bar never reopen it.

Note for whoever fixes these: a closed bar fades to `opacity: 0` rather than
unmounting, and Playwright still reports it visible. Gate a reopen on
`data-open="true"`, not `isVisible()` — otherwise the reopen silently does
nothing and the tab click is intercepted by whatever sits above it.

## 3-bar-overlays-instead-of-reserving-gutter.png

`mobile.e2e.ts:291` —
`expect(panel.y + panel.height).toBeLessThanOrEqual(barBox.y + 1)`;
expected <= 726.44, got 844.

The old bar reserved a bottom gutter that surfaces sat above. The new bar
floats over the surface, so the Terminal fills the whole 844px viewport. This
is intentional: this change's own `navigation-overlay.e2e.ts:27` asserts
"no reserved gutter".

## The decision each failure needs

For every one: is the new behavior correct — in which case update the assertion
to the new design — or did the redesign genuinely lose something the assertion
was protecting, in which case fix the product? The case to hunt for is the
latter: a surface whose content is now permanently obscured by the floating bar
with no way to scroll it into view.
