## Context

The brand logo lives in the sidebar header (`src/index.html` line 15) as `<img class="brand-logo" data-src="/assets/uatu-logo.svg">`. `initBrandLogo()` in `src/app.ts` swaps `data-src` onto `src` at startup. The asset itself (`src/assets/uatu-logo.svg`) is a flat SVG with three paths and no animation hooks.

The user supplied a reference (`/Users/tobias/Downloads/preview.html`) that demonstrates the desired blink: the two eye paths are wrapped in a `<g id="eye">` and animated via a CSS `@keyframes blink` keyed off `transform: scaleY(...)` with `transform-box: view-box; transform-origin: 404px 415px;` so the eyelid closes around the pupil center. A `prefers-reduced-motion` rule disables it.

The relevant constraint: a CSS `:hover` selector on the host page **cannot** reach inside an `<img>`-loaded SVG, because the SVG is rendered as an opaque image. To make the eye blink only on hover, the SVG's DOM must be in the same document as the hover selector.

## Goals / Non-Goals

**Goals:**
- Eye blinks on hover, repeating every ~10 s for as long as the cursor is over the logo.
- Animation stops cleanly when the cursor leaves (no half-blinked frame stuck on screen).
- Honors `prefers-reduced-motion: reduce`.
- Keep the asset file (`uatu-logo.svg`) usable as a standalone image elsewhere — the `id="eye"` group is purely additive.
- Preserve current accessibility: the logo is decorative (`aria-hidden="true"`, empty `alt`) and should remain so.

**Non-Goals:**
- No keyboard / focus trigger. The logo is decorative and not interactive — the easter egg is for mouse users only. Touch devices that don't synthesize hover get the static logo, which is fine.
- No tooltip, no click handler, no analytics — it's an undecorated easter egg.
- No animation on initial load or any state other than hover.
- No theming / dark-mode-specific tweaks beyond what the existing logo already does.

## Decisions

### Decision 1: Inline the SVG in `index.html` rather than load it via JS

The reference HTML inlines the SVG directly. We will do the same: paste the SVG contents into `index.html` in place of the `<img>`, give it `class="brand-logo"`, and wrap the two eye paths in `<g id="eye">`. CSS selectors in `styles.css` can then target `.brand-logo:hover #eye`.

**Alternatives considered:**
- **Fetch + `innerHTML` at startup.** Works, but adds a network round-trip and a flash of missing logo on first paint, and keeps `initBrandLogo()` in `app.ts` for no real benefit.
- **`<object data="...svg">`.** The SVG document is same-origin so its DOM is reachable, but `:hover` on the host still doesn't cascade in. We'd need to inject a `<style>` into the SVG document via JS — strictly worse than inlining.
- **Animate via JS on `mouseenter` / `mouseleave`.** More moving parts; CSS is the natural fit for a periodic looped animation.

The SVG is ~5 KB of path data, served once with the HTML. Inlining is cheaper than the current `<img>` request anyway.

### Decision 2: Drive the blink with `animation-play-state` rather than only attaching the animation on hover

We declare the animation on `#eye` always, but set `animation-play-state: paused` by default and `running` on `.brand-logo:hover`. This means the blink keyframe sequence is always primed and the cursor entering the logo simply unpauses it.

The reference HTML uses an always-running 10s animation. That works for a demo page where the logo is always visible, but it means the blink has a random phase relative to the user's hover — sometimes hovering for 8 seconds shows nothing. We accept that: the easter egg is "stay on the logo for a moment." That's fine, and matches the reference's feel. Pausing on mouse-out (rather than removing the animation entirely) keeps the eye open at rest and avoids re-starting the keyframe phase mid-blink, which would cause a visible flash.

**Alternative considered:** Apply `animation: blink 10s infinite` only inside the `:hover` rule. This re-creates the animation on every hover-in, restarting at 0% (eye open). Reasonable, but means a user who hovers, leaves at 9 s, and returns gets the next blink delayed by another 10 s rather than ~1 s. Pausing feels more "alive."

### Decision 3: Use the reference's keyframe shape verbatim

```css
@keyframes blink {
  0%, 96%, 100% { transform: scaleY(1); }
  97%, 98%      { transform: scaleY(0.06); }
  99%           { transform: scaleY(1); }
}
```

With `animation: blink 10s infinite` this produces a ~200 ms eye-closure once per 10 s cycle — the timing the user already approved by sharing the reference. `transform-box: view-box` plus `transform-origin: 404px 415px` keeps the squash centered on the pupil.

### Decision 4: Remove `initBrandLogo()` from `app.ts`

Once the SVG is inlined, the `data-src` → `src` indirection is dead code. Removing it (rather than leaving it as a no-op) keeps the startup path honest.

## Risks / Trade-offs

- **Inlining adds ~5 KB to `index.html`.** → Negligible; we save the separate asset request. The `/assets/uatu-logo.svg` file still ships for any external consumers (e.g., favicons, docs).
- **`prefers-reduced-motion` only suppresses the animation, not the hover affordance.** → Acceptable: the logo simply stays static, which is the correct behavior.
- **Hover doesn't exist on touch.** → Acceptable: easter egg, not core UX.
- **Keyframe phase is unsynchronized with hover.** → Acknowledged in Decision 2; matches the reference's feel.
- **The SVG markup is now duplicated between `index.html` and `src/assets/uatu-logo.svg`.** → True. The asset file is the source of truth for any external use; the inline copy is the source of truth for the in-app rendering. Drift risk is low (we rarely change the logo), and the spec requires the `id="eye"` group to exist in both so a future refresh doesn't silently break the easter egg.
