// Mermaid trigger click handling and theme selection for the preview body.
// Extracted from `app.ts` so the Mermaid-viewer integration lives next to
// the rest of the preview/ rendering pipeline.

import { ensureMermaidViewer } from "./mermaid-viewer";
import {
  reobserveMermaidDiagrams,
  rerenderMermaidDiagrams,
  type MermaidThemeInputs,
} from "../render/preview";
import { activeColorScheme, onColorSchemeChange } from "../shell/theme";
import { onUiModeChange } from "../shell/ui-mode";

const previewElementMaybe = document.querySelector<HTMLElement>("#preview");

if (!previewElementMaybe) {
  throw new Error("uatu UI failed to initialize (preview/mermaid)");
}

const previewElement: HTMLElement = previewElementMaybe;

// Mermaid's stock "dark" theme is nearly grayscale. The "base" theme with
// explicit variables echoes the light default's lavender/amber hues on
// GitHub-dark surfaces, so diagrams keep their color identity in dark
// (the rest of the palette is derived by mermaid from these seeds).
const DARK_THEME_INPUTS: MermaidThemeInputs = {
  theme: "base",
  themeVariables: {
    darkMode: true,
    background: "#0d1117",
    textColor: "#e6edf3",
    lineColor: "#8b949e",
    primaryColor: "#2a3457",
    primaryTextColor: "#e6edf3",
    primaryBorderColor: "#8b95e0",
    secondaryColor: "#3b3325",
    tertiaryColor: "#161b22",
    clusterBkg: "#161b22",
    clusterBorder: "#30363d",
    edgeLabelBackground: "#161b22",
  },
};

export function currentMermaidThemeInputs(): MermaidThemeInputs {
  return activeColorScheme() === "dark" ? DARK_THEME_INPUTS : { theme: "default" };
}

// An OS scheme flip mid-session re-renders the visible preview's diagrams
// so they match the restyled page (system-theme spec, "Scheme changes
// apply live"). The render-side cache is keyed by theme inputs, so
// flipping back reuses earlier SVGs.
onColorSchemeChange(() => {
  void rerenderMermaidDiagrams(currentMermaidThemeInputs());
});

// Scrolling moves between the preview shell and the page without any document
// remount, and an IntersectionObserver's root is fixed at construction — the
// live observer stays bound to whatever region was effective at mount. Rebuild
// it, for the diagrams that have not rendered yet.
//
// Two events move it, and both must be handled: switching UI mode swaps the
// scroller outright, and crossing the ≤900px stacked breakpoint by resizing or
// rotating in desktop mode does the same with no mode change to subscribe to.
// This is the same pair `outline.ts` subscribes to, for the same reason and
// with the same no-op-unless-changed guard inside.
//
// Not `rerenderMermaidDiagrams`: that path is for a theme change and resets
// every diagram to its source to force a re-render. Nothing about the theme
// changed here, so already-rendered diagrams would flash for no gain.
//
// Deferred by a frame because the mode switch restyles the layout in the same
// task, and the resolver reads computed styles — asking before the cascade has
// settled would resolve against the outgoing layout. `setUiMode` fires its own
// resize on the next frame for the same reason.
onUiModeChange(() => {
  requestAnimationFrame(() => reobserveMermaidDiagrams());
});

window.addEventListener("resize", () => reobserveMermaidDiagrams(), { passive: true });

export function handleMermaidTriggerClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const trigger = target.closest<HTMLButtonElement>("button.mermaid-trigger");
  if (!trigger || !previewElement.contains(trigger)) {
    return;
  }
  const svg = trigger.querySelector<SVGElement>("svg");
  if (!svg) {
    return;
  }
  event.preventDefault();
  ensureMermaidViewer().open({ svg, returnFocusTo: trigger });
}

export function installMermaidTriggerHandler(): void {
  previewElement.addEventListener("click", handleMermaidTriggerClick);
}
