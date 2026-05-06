## 1. Asset preparation

- [x] 1.1 In `src/assets/uatu-logo.svg`, wrap the two eye paths (`#path1` and `#path2`) in `<g id="eye">…</g>`. Visual rendering must be unchanged when no animation is applied.

## 2. Inline the logo in the sidebar

- [x] 2.1 In `src/index.html`, replace the `<img class="brand-logo" … data-src="/assets/uatu-logo.svg">` element with the inline SVG markup. Keep `class="brand-logo"`, `aria-hidden="true"`, `width="56"`, `height="56"`, and a `viewBox="0 0 804 818"`. Wrap the eye paths in `<g id="eye">`.
- [x] 2.2 In `src/app.ts`, remove `initBrandLogo()` and its call site (the `data-src`/`src` swap is no longer needed).

## 3. CSS animation

- [x] 3.1 In `src/styles.css`, add `@keyframes blink` matching the reference (eye open at 0%/96%/100%, squashed at 97–98%, open again at 99%).
- [x] 3.2 Add a rule for `.brand-logo #eye` that declares `transform-box: view-box`, `transform-origin: 404px 415px`, `animation: blink 10s infinite`, and `animation-play-state: paused`.
- [x] 3.3 Add `.brand-logo:hover #eye { animation-play-state: running; }`.
- [x] 3.4 Add a `@media (prefers-reduced-motion: reduce)` block that sets `animation: none` on `.brand-logo #eye` so hover never animates for reduced-motion users.

## 4. Verify

- [x] 4.0 Do **not** mention this feature in `README.md`, `CHANGELOG`, or any user-facing docs — it is an undocumented easter egg.
- [x] 4.1 Run the app locally; confirm the logo renders identically when not hovered.
- [x] 4.2 Hover the logo; confirm the eye blinks once roughly every 10 seconds and stops cleanly when the cursor leaves.
- [x] 4.3 Toggle "Reduce motion" in the OS (or DevTools rendering panel); confirm hover no longer animates.
- [x] 4.4 Run `bun run typecheck` (or project equivalent) and the existing test suite to confirm removing `initBrandLogo()` did not break anything.
- [x] 4.5 Run `openspec validate logo-blink-easter-egg --strict` and confirm it passes.
