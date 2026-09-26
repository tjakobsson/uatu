// The inline Single / Side by side / Stacked chooser that sits above
// `#preview` inside `.preview-shell`. Kept free of `appState` and module-level
// DOM lookups so the mount-in-place contract can be unit tested; `layout.ts`
// supplies the elements, the current layout, and the click handler.
//
// The toolbar is created once and then only *updated* on later renders. Every
// document render (a layout switch completing, a live reload of the open file)
// calls `ensureLayoutToolbar`. When that used to remove and rebuild the
// toolbar, a render landing between a click's mousedown and mouseup left the
// two events on different buttons, the browser fired no click, and the user's
// layout choice was silently dropped.

import type { ViewLayout } from "../shared/types";

export const LAYOUT_TOOLBAR_SEGMENTS: ReadonlyArray<{ value: ViewLayout; label: string; title: string }> = [
  { value: "single", label: "Single", title: "Single pane" },
  { value: "split-h", label: "Side by side", title: "Side-by-side split" },
  { value: "split-v", label: "Stacked", title: "Stacked (top / bottom) split" },
];

// Build the chooser: a small segmented pill with text labels and an
// "is-active" segment, mirroring the .uatu-diff-toolbar pattern.
export function renderLayoutToolbar(
  doc: Document,
  current: ViewLayout,
  onSelect: (next: ViewLayout) => void,
): HTMLElement {
  const toolbar = doc.createElement("div");
  toolbar.className = "uatu-layout-toolbar";
  toolbar.setAttribute("role", "radiogroup");
  toolbar.setAttribute("aria-label", "Layout");

  for (const segment of LAYOUT_TOOLBAR_SEGMENTS) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "uatu-layout-toolbar-segment";
    button.setAttribute("role", "radio");
    button.setAttribute("data-layout-value", segment.value);
    button.title = segment.title;
    button.textContent = segment.label;
    button.addEventListener("click", () => onSelect(segment.value));
    toolbar.appendChild(button);
  }

  syncLayoutToolbar(toolbar, current);
  return toolbar;
}

// Reflect `current` on an existing toolbar's segments without touching the
// elements themselves.
export function syncLayoutToolbar(toolbar: HTMLElement, current: ViewLayout): void {
  for (const button of toolbar.querySelectorAll<HTMLElement>(".uatu-layout-toolbar-segment")) {
    const isActive = button.getAttribute("data-layout-value") === current;
    button.setAttribute("aria-checked", String(isActive));
    button.classList.toggle("is-active", isActive);
  }
}

// Ensure the toolbar exists (or doesn't) as the sibling directly above
// `preview`. An existing toolbar is updated in place, never replaced.
export function ensureLayoutToolbar(
  shell: HTMLElement,
  preview: HTMLElement,
  show: boolean,
  current: ViewLayout,
  onSelect: (next: ViewLayout) => void,
): void {
  const existing = shell.querySelector<HTMLElement>(".uatu-layout-toolbar");
  if (!show) {
    existing?.remove();
    return;
  }
  if (existing) {
    syncLayoutToolbar(existing, current);
    if (existing.nextElementSibling !== preview) {
      shell.insertBefore(existing, preview);
    }
    return;
  }
  shell.insertBefore(renderLayoutToolbar(shell.ownerDocument, current, onSelect), preview);
}
