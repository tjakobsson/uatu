// Mermaid trigger click handling and theme selection for the preview body.
// Extracted from `app.ts` so the Mermaid-viewer integration lives next to
// the rest of the preview/ rendering pipeline.

import { ensureMermaidViewer } from "./mermaid-viewer";
import { rerenderMermaidDiagrams, type MermaidThemeInputs } from "../render/preview";
import { activeColorScheme, onColorSchemeChange } from "../shell/theme";

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
    darkMode: "true",
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
