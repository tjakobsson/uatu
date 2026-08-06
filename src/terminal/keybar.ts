// Touch keybar — the terminal keys a software keyboard cannot produce. On
// coarse-pointer devices (iPad and iPhone) there is no Ctrl, no Esc, no
// arrow cluster, and no paging keys, which makes a shell — and every TUI in
// it — undrivable. Sequence keys send raw control sequences straight down
// the focused pane's PTY via TerminalPanelHandle.sendInput, exactly as
// typed input travels. Two action buttons go beyond raw sequences: Paste
// (clipboard read inside the tap gesture) and a single-shot sticky Ctrl
// latch (see sticky-ctrl.ts).
//
// Visibility is CSS-owned (`@media (pointer: coarse)` in styles.css), so
// desktop layouts never see the bar and no JS sniffing is involved.

import type { StickyCtrlController } from "./sticky-ctrl";

export type KeybarKey = {
  // Visible button label.
  label: string;
  // Raw byte sequence written to the PTY.
  sequence: string;
  // Accessible name (labels like "^C" read poorly to screen readers).
  ariaLabel: string;
};

export type KeybarItem =
  | ({ kind: "sequence" } & KeybarKey)
  | { kind: "ctrl"; label: string; ariaLabel: string }
  | { kind: "paste"; label: string; ariaLabel: string };

// Ordered by tap frequency: interaction keys first, paging cluster next,
// process-control tail. The row scrolls horizontally when it overflows.
export const KEYBAR_ITEMS: readonly KeybarItem[] = [
  { kind: "sequence", label: "esc", sequence: "\x1b", ariaLabel: "Escape" },
  { kind: "sequence", label: "tab", sequence: "\t", ariaLabel: "Tab" },
  { kind: "ctrl", label: "ctrl", ariaLabel: "Control modifier" },
  { kind: "sequence", label: "^C", sequence: "\x03", ariaLabel: "Control C" },
  { kind: "paste", label: "paste", ariaLabel: "Paste from clipboard" },
  { kind: "sequence", label: "←", sequence: "\x1b[D", ariaLabel: "Arrow left" },
  { kind: "sequence", label: "↓", sequence: "\x1b[B", ariaLabel: "Arrow down" },
  { kind: "sequence", label: "↑", sequence: "\x1b[A", ariaLabel: "Arrow up" },
  { kind: "sequence", label: "→", sequence: "\x1b[C", ariaLabel: "Arrow right" },
  { kind: "sequence", label: "⇞", sequence: "\x1b[5~", ariaLabel: "Page up" },
  { kind: "sequence", label: "⇟", sequence: "\x1b[6~", ariaLabel: "Page down" },
  { kind: "sequence", label: "home", sequence: "\x1b[H", ariaLabel: "Home" },
  { kind: "sequence", label: "end", sequence: "\x1b[F", ariaLabel: "End" },
  { kind: "sequence", label: "^D", sequence: "\x04", ariaLabel: "Control D" },
  { kind: "sequence", label: "^Z", sequence: "\x1a", ariaLabel: "Control Z" },
];

// Back-compat view of the sequence keys; tests assert the sequences here.
export const KEYBAR_KEYS: readonly KeybarKey[] = KEYBAR_ITEMS.filter(
  (item): item is { kind: "sequence" } & KeybarKey => item.kind === "sequence",
).map(({ kind: _kind, ...key }) => key);

export type KeybarDeps = {
  container: HTMLElement;
  // Sends a sequence to the focused pane; returns false when no pane can
  // receive input (the bar flashes nothing — the tap is simply inert).
  sendToActivePane(sequence: string): boolean;
  // The panel's latch; the ctrl button toggles it and renders armed state.
  stickyCtrl: StickyCtrlController;
  // Injectable clipboard read for tests. Production passes
  // () => navigator.clipboard.readText(). Rejections make the tap inert.
  readClipboardText(): Promise<string>;
};

export function initTerminalKeybar(deps: KeybarDeps): void {
  for (const item of KEYBAR_ITEMS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "terminal-keybar-key";
    button.textContent = item.label;
    button.setAttribute("aria-label", item.ariaLabel);
    if (item.kind === "ctrl") {
      button.setAttribute("aria-pressed", "false");
      button.classList.add("terminal-keybar-ctrl");
      deps.stickyCtrl.onChange(armed => {
        button.setAttribute("aria-pressed", armed ? "true" : "false");
        button.classList.toggle("is-armed", armed);
      });
    }
    // pointerdown instead of click, with preventDefault: the tap must not
    // move focus out of xterm — a focus bounce would dismiss the software
    // keyboard the user is typing on.
    button.addEventListener("pointerdown", event => {
      event.preventDefault();
      switch (item.kind) {
        case "sequence":
          deps.sendToActivePane(item.sequence);
          return;
        case "ctrl":
          deps.stickyCtrl.toggle();
          return;
        case "paste":
          // The read starts inside the user gesture (iOS shows its paste
          // callout); denial or an empty clipboard leaves the tap inert.
          deps.readClipboardText().then(
            text => {
              if (text) deps.sendToActivePane(text);
            },
            () => {
              // Inert by design.
            },
          );
          return;
      }
    });
    deps.container.appendChild(button);
  }
}
