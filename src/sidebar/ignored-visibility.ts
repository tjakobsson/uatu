import { appState } from "../shell/state";
import { applyShowIgnored } from "../shell/ignored-visibility";

const checkbox = document.querySelector<HTMLInputElement>("#files-show-ignored")!;

// Boot hydration and sidebar updates share the same checkbox synchronization.
export function syncIgnoredVisibilityControl(): void {
  checkbox.checked = appState.showIgnored;
}

export function initIgnoredVisibilityControl(): void {
  const options = checkbox.closest<HTMLElement>("[popover]")!;
  const trigger = document.querySelector<HTMLButtonElement>(".files-options-trigger")!;
  const dismiss = (restoreFocus = false) => {
    options.hidePopover();
    if (restoreFocus) trigger.focus();
  };
  checkbox.addEventListener("change", () => {
    applyShowIgnored(checkbox.checked);
    dismiss(true);
  });
  const position = () => {
    if (!options.matches(":popover-open")) return;
    const bounds = trigger.getBoundingClientRect();
    options.style.left = `${Math.max(8, Math.min(bounds.right - options.offsetWidth, window.innerWidth - options.offsetWidth - 8))}px`;
    options.style.top = `${Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - options.offsetHeight - 8))}px`;
  };
  options.addEventListener("beforetoggle", () => queueMicrotask(position));
  options.addEventListener("toggle", () => {
    trigger.setAttribute("aria-expanded", String(options.matches(":popover-open")));
    position();
  });
  window.addEventListener("resize", position);
  syncIgnoredVisibilityControl();
}
