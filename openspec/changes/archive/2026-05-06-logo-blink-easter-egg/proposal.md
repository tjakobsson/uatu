## Why

The brand logo in the sidebar is a static image. The full SVG actually contains an "eye" group that can be animated to blink, which fits the project's name (Uatu, the Watcher). Surfacing this as a hover-only easter egg adds a small moment of delight without distracting users during normal use.

## What Changes

- Render the brand logo as inline SVG (or otherwise expose its DOM) so a CSS hover state can drive an animation on its `#eye` group.
- Add a blink animation that plays only while the cursor hovers the logo: a quick eyelid-close-and-open, repeating roughly every 10 seconds for as long as the hover continues.
- Respect `prefers-reduced-motion: reduce` — the logo stays still on hover for users who opt out of animation.
- Update the logo asset (`src/assets/uatu-logo.svg`) to wrap the two eye paths in a `<g id="eye">` so the animation has a stable target.

## Capabilities

### New Capabilities
- `brand-logo`: Defines how the sidebar brand logo is rendered and the hover-only blink easter egg behavior.

### Modified Capabilities
<!-- None — no existing spec covers brand chrome. -->

## Impact

- `src/index.html` — replaces the `<img class="brand-logo">` with inline SVG markup (or equivalent inline-loading approach).
- `src/styles.css` — new keyframes + `:hover`-scoped animation rule, plus a `prefers-reduced-motion` guard.
- `src/app.ts` — `initBrandLogo()` is removed or replaced once the SVG no longer needs JS-driven `src` assignment.
- `src/assets/uatu-logo.svg` — adds an `id="eye"` group around the two eye paths; visual rendering unchanged when not hovered.
- No backend, API, or data-format impact. No new dependencies.
