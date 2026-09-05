let pending: (() => void) | null = null;
let observer: MutationObserver | null = null;
let materialized = false;

/** Defer the first hidden preview. Mounted previews retain live navigation updates. */
export function deferHiddenPreview(presentCurrent: () => void): boolean {
  const root = document.documentElement;
  const hidden = root.getAttribute("data-ui-mode") === "touch" && root.getAttribute("data-active-tab") !== "preview";
  if (!hidden) { pending = null; materialized = true; return false; }
  if (materialized) return false;
  pending = presentCurrent;
  if (!observer) {
    observer = new MutationObserver(() => {
      if (root.getAttribute("data-ui-mode") === "touch" && root.getAttribute("data-active-tab") !== "preview") return;
      const present = pending;
      pending = null;
      present?.();
    });
    observer.observe(root, { attributes: true, attributeFilter: ["data-ui-mode", "data-active-tab"] });
  }
  return true;
}
