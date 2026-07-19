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

export function currentMermaidThemeInputs(): MermaidThemeInputs {
  return { theme: activeColorScheme() === "dark" ? "dark" : "default" };
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
