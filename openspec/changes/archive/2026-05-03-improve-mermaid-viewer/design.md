## Context

Mermaid diagrams currently flow through `src/preview.ts`:

1. `replaceMermaidCodeBlocks` rewrites `<pre><code class="language-mermaid">…</code></pre>` to `<div class="mermaid">…</div>` server-side.
2. `renderMermaidDiagrams` lazy-loads `mermaid.min.js` (served as a static asset by `cli.ts` / `e2e-server.ts`), initializes once with `{ startOnLoad: false, securityLevel: "strict", theme: "default" }`, then calls `mermaid.run({ nodes })`.
3. Mermaid replaces each div's content with an `<svg>` whose `style="max-width: <Npx>"` is computed from the diagram's intrinsic size.
4. `src/styles.css` styles `.preview .mermaid` with `display: grid; justify-content: center; overflow-x: auto; padding: 1rem 0;` — i.e. center the SVG and allow horizontal scroll if it overflows.
5. On every file change, `src/app.ts` replaces `previewElement.innerHTML` and calls `renderMermaidDiagrams` again, so all diagram state is rebuilt from scratch.

Two pain points fall out:

- **Sizing (general, not type-specific)**: Mermaid's inline `max-width` pins every SVG to its intrinsic pixel width — the width Mermaid computes from the diagram's element layout. That width is consistently narrower than the preview pane across diagram types: flowcharts, sequence diagrams, class diagrams, C4. The result is the same shape of problem in every case — a diagram that occupies a fraction of the available column and is harder to read than the screen real estate would allow. C4 is the most extreme example because its intrinsic widths are particularly small, but it is one symptom of a generic Mermaid sizing default, not a C4-specific bug.
- **No interaction**: there is no zoom, pan, or fullscreen affordance. The browser's page zoom is the only fallback and is unwieldy.

A third constraint is incoming: theme support. The hard-coded `theme: "default"` will not survive once the app supports non-light themes. This change introduces the seam now so the future theme switch is a small follow-up rather than another viewer rewrite.

## Goals / Non-Goals

**Goals:**

- Diagrams fill the available preview width responsively, regardless of diagram type or intrinsic size.
- Users can open any diagram in a fullscreen modal with wheel-zoom, drag-pan, and reset.
- The viewer is keyboard-accessible: Enter/Space opens, Esc closes, focus returns to the trigger, and `+ / - / 0 / f` work inside the modal.
- Mermaid initialization accepts `theme` and `themeVariables` so a future theme system can swap visuals without touching the viewer module.
- e2e coverage proves the new behavior: inline fit-to-width, click-to-modal, Esc-to-close, wheel-changes-transform.

**Non-Goals:**

- Implementing dark theme or any non-light theme. Only the seam is added; the active theme stays the existing light look.
- Preserving zoom/pan state across file edits. If the watched file changes while the modal is open, behavior is "modal closes" — simpler and rarely an issue.
- A "view source" panel in the modal. Interesting future feature, but out of scope.
- Per-diagram size knobs in the markdown source. Auto-fit is the only mode.
- Pinch zoom and touch gesture support beyond what Pointer Events give us for free. This is a desktop-first tool today.

## Decisions

### 1. Strip Mermaid's inline `max-width` rather than fight it from CSS

After `mermaid.run({ nodes })` resolves, walk the rendered SVGs and apply:

```ts
svg.style.removeProperty("max-width");
svg.removeAttribute("width");
svg.removeAttribute("height");
svg.style.width = "100%";
svg.style.height = "auto";
```

The `viewBox` attribute Mermaid emits is preserved, so aspect ratio stays correct and the diagram scales uniformly.

**Alternatives considered:**
- *Override with CSS using `!important`*: works for `max-width` but leaves the inline `width`/`height` attributes on the SVG, which still influence layout in some browsers. Less reliable.
- *Wrap each SVG in a percentage-width container*: moves the problem rather than fixing it. The inner SVG still respects its inline `max-width`.
- *Patch Mermaid*: out of proportion to the problem.

### 2. Custom pan/zoom in ~100 lines, no third-party library

A new module `src/mermaid-viewer.ts` implements:

- `openModal(svgClone: SVGElement, title?: string): void`
- A single `<dialog>` element mounted once at app start (idempotent).
- Pan: pointerdown → set `dragging = true`, pointermove → `tx += dx; ty += dy`, pointerup → release.
- Zoom: wheel event → compute new scale, adjust `tx, ty` so the cursor stays anchored to its world point.
- Apply transform via `transform: translate(tx, ty) scale(s)` on a wrapper `<div>` containing the SVG.
- Toolbar `[+] [−] [⟲] [⛶]` plus close `[×]`. Keyboard: `+`, `-`, `0`, `f`, `Esc`.

**Alternatives considered:**

| | Custom (~100 LOC) | `panzoom` (~10 KB) | `svg-pan-zoom` (~30 KB) |
|---|---|---|---|
| Bundle | 0 KB ext | +10 KB | +30 KB |
| Wheel-zoom-at-cursor | yes | yes | yes |
| Touch / pinch | basic | good | good |
| Theme + focus integration | fully ours | requires hooks | requires hooks |
| Maintenance | ours | external | external |

UX/DX-first leans custom: full control over the zoom curve, focus return, theme integration, and how the viewer behaves on file re-render. The code is small, well-bounded, and testable. We can swap to a library later if pinch-zoom or touch becomes a real complaint.

### 3. Native `<dialog>` element with `.showModal()`

Reasons:
- Browser handles backdrop, focus trap, Esc-to-close, return focus.
- No portal/teardown bookkeeping.
- No new dependency.

The dialog is created once on first use and reused for every diagram. The SVG cloned into it is replaced each open.

### 4. Clone the rendered SVG instead of re-running Mermaid

When a trigger is clicked, the modal calls `triggerEl.querySelector('svg').cloneNode(true)` and inserts the clone into its viewport. Benefits:

- Instant — no Mermaid invocation per open.
- Insulates the modal from any state Mermaid attached to the live SVG (event handlers, IDs).
- Lets us modify the clone freely (strip stray IDs to avoid `aria` collisions) without affecting the inline view.

Cost: if we ever want a "view source" toggle, we will need to also stash the original Mermaid source on the trigger. We will accept that follow-up cost when we have the use case.

### 5. Theme seam: accept `theme` and `themeVariables` at render time

Replace the hard-coded:

```ts
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
```

with a function:

```ts
type MermaidThemeInputs = {
  theme: "default" | "dark" | "neutral" | "forest" | "base";
  themeVariables?: Record<string, string>;
};

renderMermaidDiagrams(container, themeInputs?: MermaidThemeInputs)
```

`renderMermaidDiagrams` calls `mermaid.initialize(...)` whenever `themeInputs` differs from the last call (tracked in module state), then re-runs against the visible nodes. The default for now matches today: `{ theme: "default" }`. The future theme switch wires its current theme into this call.

**Alternatives considered:**
- *Initialize once, ignore theme*: blocks theme support entirely.
- *Initialize per render*: wasteful and known to log warnings from Mermaid.
- *CSS-only theming via filters/inversion*: produces ugly colors, breaks legibility.

### 6. Re-render handling: close the modal, do not try to follow

When `previewElement.innerHTML` is replaced after a file change:

- The trigger that opened the modal no longer exists in the DOM.
- The modal is mounted outside `previewElement` so it survives, but its state (the SVG clone) is now stale.
- We register a `mutationobserver`-free check: when a file change event fires (existing event in `app.ts`), close the modal if it is open.

This is simpler than re-finding "the corresponding diagram in the new render" and avoids the corner case where the diagram was deleted from the source.

### 7. Trigger affordance: full-surface button, hover-revealed expand badge

The `.mermaid` div becomes (or contains) a `<button>` element wrapping the SVG, styled as `appearance: none; cursor: zoom-in;` with a `⛶` badge in the top-right that fades in on hover/focus. Click anywhere on the diagram opens the modal. Keyboard: `Tab` lands on the button, `Enter`/`Space` opens.

**Alternatives considered:**
- *Button only on the badge*: smaller hit target, easy to miss.
- *No visible affordance*: violates discoverability.
- *Always-visible toolbar*: noisy when a doc has many diagrams.

## Risks / Trade-offs

- **[SVG attribute stripping is brittle if Mermaid changes format]** → Mitigation: keep the strip logic narrow (only `max-width`, `width`, `height`), preserve `viewBox`, add an e2e assertion that the SVG fills the container so a regression surfaces.
- **[Custom pan/zoom may feel less polished than a library]** → Mitigation: tune the wheel-zoom curve (logarithmic, e.g. `scale *= exp(-deltaY * 0.001)`) and clamp scale to `[0.2, 8]`. Keep the module open to library replacement if real users complain.
- **[`<dialog>.showModal()` cross-browser quirks]** → Modern browsers (Chromium, WebKit, Firefox) all ship it. The CLI targets local dev and we already run Playwright/Chromium. If a browser misbehaves we can fall back to a plain overlay div.
- **[Diagram clone losing event handlers]** → We do not depend on Mermaid's interactive features (clickable nodes are not in scope). Cloning is a stripped, presentational copy.
- **[Theme re-init flicker]** → `mermaid.initialize` does not re-render existing nodes. We re-run against the visible `.mermaid` nodes after init. There may be a brief flash; acceptable for a theme switch which is a deliberate user action.
- **[Modal closes on every file save]** → Acceptable per Decision 6. If users find this disruptive we can add a "stay open if same diagram still present" path later.
