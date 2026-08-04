// Touch keybar — the terminal keys a software keyboard cannot produce. On
// coarse-pointer devices (iPad foremost) there is no Ctrl, no Esc, and no
// arrow cluster, which makes a shell — and every TUI in it — undrivable.
// The bar sends the raw control sequences straight down the focused pane's
// PTY via TerminalPanelHandle.sendInput, exactly as typed input travels.
//
// Visibility is CSS-owned (`@media (pointer: coarse)` in styles.css), so
// desktop layouts never see the bar and no JS sniffing is involved.

export type KeybarKey = {
  // Visible button label.
  label: string;
  // Raw byte sequence written to the PTY.
  sequence: string;
  // Accessible name (labels like "^C" read poorly to screen readers).
  ariaLabel: string;
};

export const KEYBAR_KEYS: readonly KeybarKey[] = [
  { label: "esc", sequence: "\x1b", ariaLabel: "Escape" },
  { label: "tab", sequence: "\t", ariaLabel: "Tab" },
  { label: "^C", sequence: "\x03", ariaLabel: "Control C" },
  { label: "^D", sequence: "\x04", ariaLabel: "Control D" },
  { label: "^Z", sequence: "\x1a", ariaLabel: "Control Z" },
  { label: "←", sequence: "\x1b[D", ariaLabel: "Arrow left" },
  { label: "↓", sequence: "\x1b[B", ariaLabel: "Arrow down" },
  { label: "↑", sequence: "\x1b[A", ariaLabel: "Arrow up" },
  { label: "→", sequence: "\x1b[C", ariaLabel: "Arrow right" },
];

export type KeybarDeps = {
  container: HTMLElement;
  // Sends a sequence to the focused pane; returns false when no pane can
  // receive input (the bar flashes nothing — the tap is simply inert).
  sendToActivePane(sequence: string): boolean;
};

export function initTerminalKeybar(deps: KeybarDeps): void {
  for (const key of KEYBAR_KEYS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "terminal-keybar-key";
    button.textContent = key.label;
    button.setAttribute("aria-label", key.ariaLabel);
    // pointerdown instead of click, with preventDefault: the tap must not
    // move focus out of xterm — a focus bounce would dismiss the software
    // keyboard the user is typing on.
    button.addEventListener("pointerdown", event => {
      event.preventDefault();
      deps.sendToActivePane(key.sequence);
    });
    deps.container.appendChild(button);
  }
}
