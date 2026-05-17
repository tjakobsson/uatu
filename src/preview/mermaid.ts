// Mermaid trigger click handling and theme selection for the preview body.
// Extracted from `app.ts` so the Mermaid-viewer integration lives next to
// the rest of the preview/ rendering pipeline.

import { ensureMermaidViewer } from "./mermaid-viewer";
import type { MermaidThemeInputs } from "../render/preview";

const previewElementMaybe = document.querySelector<HTMLElement>("#preview");

if (!previewElementMaybe) {
  throw new Error("uatu UI failed to initialize (preview/mermaid)");
}

const previewElement: HTMLElement = previewElementMaybe;

export function currentMermaidThemeInputs(): MermaidThemeInputs {
  // The active UI theme is light today. When the theme system lands, this
  // returns the inputs that match the active theme so diagrams stay coherent.
  return { theme: "default" };
}

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
