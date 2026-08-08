// Touch keybar — the terminal keys a software keyboard cannot produce. On
// coarse-pointer devices (iPad and iPhone) there is no Ctrl, no Esc, no
// arrow cluster, and no paging keys, which makes a shell — and every TUI in
// it — undrivable. Sequence keys send raw control sequences straight down
// the focused pane's PTY via TerminalPanelHandle.sendInput, exactly as
// typed input travels. Two action buttons go beyond raw sequences: Paste
// (clipboard read from semantic button activation) and a single-shot sticky Ctrl
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
  | { kind: "paste"; label: string; ariaLabel: string }
  | { kind: "select"; label: string; ariaLabel: string }
  | { kind: "switch"; label: string; ariaLabel: string };

// Ordered by tap frequency: interaction keys first, paging cluster next,
// process-control tail. The row scrolls horizontally when it overflows.
// The switch action leads the row and is styled apart from the key pills —
// it's navigation between terminals, not a key, and the frequency ordering
// below only ranks keys against each other.
export const KEYBAR_ITEMS: readonly KeybarItem[] = [
  { kind: "switch", label: "⇄", ariaLabel: "Switch terminal" },
  { kind: "sequence", label: "esc", sequence: "\x1b", ariaLabel: "Escape" },
  { kind: "sequence", label: "tab", sequence: "\t", ariaLabel: "Tab" },
  { kind: "ctrl", label: "ctrl", ariaLabel: "Control modifier" },
  { kind: "sequence", label: "^C", sequence: "\x03", ariaLabel: "Control C" },
  { kind: "paste", label: "paste", ariaLabel: "Paste from clipboard" },
  { kind: "select", label: "select", ariaLabel: "Select terminal text" },
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

export function selectionSheetKeyRoute(
  selectionSheetOpen: boolean,
  sequence: string,
): "send" | "dismiss" | "block" {
  if (!selectionSheetOpen) return "send";
  return sequence === "\x1b" ? "dismiss" : "block";
}

export type KeybarDeps = {
  container: HTMLElement;
  // Sends a sequence to the focused pane; returns false when no pane can
  // receive input (the bar flashes nothing — the tap is simply inert).
  sendToActivePane(sequence: string): boolean;
  // Pastes clipboard text through the focused pane's xterm instance.
  pasteToActivePane(text: string): boolean;
  // Opens a stable, native-selectable snapshot over the focused pane.
  showSelectionSheet(): boolean;
  dismissSelectionSheet(): boolean;
  isSelectionSheetOpen(): boolean;
  // The terminal switcher: touch mode shows one pane at a time, so this is
  // how the user reaches the others. Toggled from the row; the sheet takes
  // focus while open, which is the one place a keybar press is allowed to
  // move focus out of the terminal.
  openSwitcher(): boolean;
  dismissSwitcher(): boolean;
  isSwitcherOpen(): boolean;
  // The panel's latch; the ctrl button toggles it and renders armed state.
  stickyCtrl: StickyCtrlController;
  // Injectable clipboard read for tests. Production passes the Clipboard
  // API when available. Every failure form makes the activation inert.
  readClipboardText?: () => Promise<string>;
};

export function initTerminalKeybar(deps: KeybarDeps): void {
  let selectButton: HTMLButtonElement | null = null;
  let switchButton: HTMLButtonElement | null = null;
  const renderedItems: Array<{ button: HTMLButtonElement; item: KeybarItem }> = [];
  const syncSwitchButton = () => {
    switchButton?.setAttribute("aria-expanded", deps.isSwitcherOpen() ? "true" : "false");
  };
  const syncSelectButton = () => {
    if (!selectButton) return;
    const open = deps.isSelectionSheetOpen();
    selectButton.textContent = open ? "done" : "select";
    selectButton.setAttribute("aria-label", open ? "Done selecting terminal text" : "Select terminal text");
    selectButton.setAttribute("aria-pressed", open ? "true" : "false");
    selectButton.classList.toggle("is-selection-done", open);
    deps.container.dataset.selectionMode = open ? "true" : "false";
    for (const { button, item } of renderedItems) {
      const isEscape = item.kind === "sequence" && item.sequence === "\x1b";
      const availableInSelectionMode = item.kind === "select" || isEscape;
      button.disabled = open && !availableInSelectionMode;
    }
    if (open) selectButton.scrollIntoView?.({ block: "nearest", inline: "center" });
  };

  for (const item of KEYBAR_ITEMS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "terminal-keybar-key";
    button.textContent = item.label;
    button.setAttribute("aria-label", item.ariaLabel);
    renderedItems.push({ button, item });
    if (item.kind === "ctrl") {
      button.setAttribute("aria-pressed", "false");
      button.classList.add("terminal-keybar-ctrl");
      deps.stickyCtrl.onChange(armed => {
        button.setAttribute("aria-pressed", armed ? "true" : "false");
        button.classList.toggle("is-armed", armed);
      });
    }
    if (item.kind === "select") {
      selectButton = button;
      syncSelectButton();
    }
    if (item.kind === "switch") {
      switchButton = button;
      button.classList.add("terminal-keybar-switch");
      button.setAttribute("aria-haspopup", "dialog");
      syncSwitchButton();
    }
    // Keep focus in xterm on press so the software keyboard stays open.
    button.addEventListener("pointerdown", event => {
      event.preventDefault();
      switch (item.kind) {
        case "sequence":
          deps.sendToActivePane(item.sequence);
          if (item.sequence === "\x1b") syncSelectButton();
          return;
        case "ctrl":
          deps.stickyCtrl.toggle();
          return;
        case "paste":
        case "select":
        case "switch":
          return;
      }
    });
    if (item.kind === "paste") {
      // Non-mouse pointers gain transient user activation on release. Native
      // button click also covers Enter and Space without a second action path.
      button.addEventListener("click", () => {
        try {
          deps.readClipboardText?.().then(
            text => {
              if (text) deps.pasteToActivePane(text);
            },
            () => {
              // Inert by design.
            },
          );
        } catch {
          // Missing or synchronously failing clipboard access is inert too.
        }
      });
    }
    if (item.kind === "select") {
      button.addEventListener("click", () => {
        if (deps.isSelectionSheetOpen()) {
          deps.dismissSelectionSheet();
        } else {
          deps.showSelectionSheet();
        }
        syncSelectButton();
      });
    }
    if (item.kind === "switch") {
      // Toggle, never stack: a second activation closes the sheet rather than
      // rendering another one over it. Click (not pointerdown) keeps the
      // action keyboard-operable, same as Paste.
      button.addEventListener("click", () => {
        if (deps.isSwitcherOpen()) {
          deps.dismissSwitcher();
        } else {
          deps.openSwitcher();
        }
        syncSwitchButton();
      });
    }
    deps.container.appendChild(button);
  }
  deps.container.ownerDocument.addEventListener("uatu:terminal-selection-change", syncSelectButton);
  deps.container.ownerDocument.addEventListener("uatu:terminal-switcher-change", syncSwitchButton);
  syncSelectButton();
  syncSwitchButton();
}
