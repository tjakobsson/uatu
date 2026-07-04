// Boot-time wiring for the embedded terminal panel. Extracted from app.ts
// so the panel controller lives next to the rest of the terminal feature
// (client mount, pane-state persistence, server protocol). The function
// owns the closure that mutates panel state — every UI handler funnels
// through its named methods so persistence and refit happen consistently.

import { mountTerminalPanel, type TerminalPanelHandle } from "./client";
import { formatSessionAge, pickerCandidates } from "./picker";
import type { TerminalSessionInfo } from "./server";
import {
  TERMINAL_MAX_PANES,
  TERMINAL_RIGHT_DOCK_VIEWPORT_MIN,
  clampTerminalHeight as clampTerminalHeightShared,
  clampTerminalWidth as clampTerminalWidthShared,
  readTerminalPanelState,
  readTerminalVisiblePreference as readTerminalVisiblePreferenceShared,
  resolveBootPaneRecords,
  writeOwnPaneRecords,
  writeTerminalPanelState,
  writeTerminalVisiblePreference as writeTerminalVisiblePreferenceShared,
  type StorageLike,
  type TerminalDisplayMode,
  type TerminalDock,
  type TerminalPanelState,
  type TerminalPaneRecord,
} from "./pane-state";

const TERMINAL_TOKEN_KEY_LOCAL = "uatu:terminal-token";

let terminalSetupRan = false;

const sessionStorageRef: StorageLike = window.sessionStorage;
const localStorageRef: StorageLike = window.localStorage;

function readTerminalVisiblePreference(): boolean {
  return readTerminalVisiblePreferenceShared(sessionStorageRef);
}

function writeTerminalVisiblePreference(visible: boolean): void {
  writeTerminalVisiblePreferenceShared(sessionStorageRef, visible);
}

function clampTerminalHeight(value: number): number {
  return clampTerminalHeightShared(value, window.innerHeight);
}

function clampTerminalWidth(value: number): number {
  return clampTerminalWidthShared(value, window.innerWidth);
}

type TerminalPaneEntry = {
  record: TerminalPaneRecord;
  handle: TerminalPanelHandle;
  element: HTMLElement;
  hostElement: HTMLElement;
  closeButton: HTMLButtonElement;
};

// `setupTerminalPanel` runs once at boot when the backend is enabled. It
// builds the controller closure and wires every header button + the sidebar
// toggle + keyboard shortcuts + the close-confirmation modal. The controller
// is the only thing that mutates panel state; UI handlers all funnel through
// its named methods so persistence and refit happen consistently.
export function setupTerminalPanel(enabled: boolean, config?: { fontFamily?: string; fontSize?: number }) {
  if (terminalSetupRan) return;
  terminalSetupRan = true;

  if (!enabled) return;

  const panel = document.getElementById("terminal-panel");
  const panesContainer = document.getElementById("terminal-panes");
  const resizer = document.getElementById("terminal-resizer");
  const toggle = document.getElementById("terminal-toggle");
  const sidebarRow = document.querySelector<HTMLElement>(".sidebar-terminal-row");
  const splitButton = document.getElementById("terminal-split");
  const dockButton = document.getElementById("terminal-dock-toggle");
  const minimizeButton = document.getElementById("terminal-minimize");
  const fullscreenButton = document.getElementById("terminal-fullscreen");
  const closeButton = document.getElementById("terminal-close");
  const modal = document.getElementById("terminal-confirm");
  const modalCancel = document.getElementById("terminal-confirm-cancel");
  const modalAccept = document.getElementById("terminal-confirm-accept");
  if (
    !panel ||
    !panesContainer ||
    !resizer ||
    !toggle ||
    !sidebarRow ||
    !splitButton ||
    !dockButton ||
    !minimizeButton ||
    !fullscreenButton ||
    !closeButton ||
    !modal ||
    !modalCancel ||
    !modalAccept
  ) {
    return;
  }

  // Sidebar control becomes visible once we know the backend is on.
  sidebarRow.removeAttribute("hidden");

  const panes = new Map<string, TerminalPaneEntry>();
  let activePaneId: string | null = null;
  let state: TerminalPanelState = readTerminalPanelState(localStorageRef);

  // Pane records are per-window (sessionStorage); the localStorage state's
  // `panes` doubles as shared restart hints. A reloading window reclaims its
  // own sessions; a fresh window adopts the hints. `hintOwner` tracks whether
  // this window may publish its records as the hints — demoted permanently
  // on the first lost sessionId collision (see handlePaneCollision).
  const bootRecords = resolveBootPaneRecords(sessionStorageRef, state);
  let hintOwner = bootRecords.hintOwner;
  state = { ...state, panes: bootRecords.panes };

  // Height/width restore: write the persisted value to the CSS var so the
  // first paint matches the user's last layout.
  document.documentElement.style.setProperty(
    "--terminal-panel-height",
    `${clampTerminalHeight(state.bottomHeight)}px`,
  );
  document.documentElement.style.setProperty(
    "--terminal-panel-width",
    `${clampTerminalWidth(state.rightWidth)}px`,
  );

  function persistState() {
    state = {
      ...state,
      panes: Array.from(panes.values()).map(entry => entry.record),
    };
    // This window's records always go to its own store.
    writeOwnPaneRecords(sessionStorageRef, { panes: state.panes, hintOwner });
    if (hintOwner) {
      writeTerminalPanelState(localStorageRef, state);
    } else {
      // Collision loser: publish layout preferences but preserve the
      // claimant window's pane hints — overwriting them would orphan its
      // still-running shells on its next reload.
      const currentHints = readTerminalPanelState(localStorageRef, {
        writeOnMigrate: false,
      }).panes;
      writeTerminalPanelState(localStorageRef, { ...state, panes: currentHints });
    }
  }

  function getToken(): string | null {
    try {
      return window.sessionStorage.getItem(TERMINAL_TOKEN_KEY_LOCAL);
    } catch {
      return null;
    }
  }

  // Right-dock auto-fallback: at narrow viewports we force bottom-dock, but
  // keep the user's stored preference so widening the viewport snaps it back.
  function effectiveDock(): TerminalDock {
    if (state.dock === "right" && window.innerWidth < TERMINAL_RIGHT_DOCK_VIEWPORT_MIN) {
      return "bottom";
    }
    return state.dock;
  }

  function applyDockToDom() {
    const dock = effectiveDock();
    panel!.setAttribute("data-dock", dock);
    // Split orientation flips with the dock axis: bottom-dock splits side-by-
    // side (panes share full height); right-dock stacks panes (share full
    // width). Driven via a data attribute so CSS handles the flexbox swap.
    panesContainer!.setAttribute("data-orientation", dock === "bottom" ? "horizontal" : "vertical");
    resizer!.setAttribute("data-orientation", dock === "bottom" ? "horizontal" : "vertical");
    // Update dock toggle's affordance to indicate the OPPOSITE dock (where
    // clicking will move the panel to). The icon itself swaps via CSS keyed
    // off [data-dock]; we sync the accessible label here.
    const target = dock === "bottom" ? "right" : "bottom";
    dockButton!.setAttribute("aria-label", `Dock to ${target}`);
    dockButton!.setAttribute("title", `Dock to ${target}`);
  }

  function applyDisplayModeToDom() {
    panel!.setAttribute("data-display", state.displayMode);
    minimizeButton!.setAttribute(
      "aria-pressed",
      state.displayMode === "minimized" ? "true" : "false",
    );
    fullscreenButton!.setAttribute(
      "aria-pressed",
      state.displayMode === "fullscreen" ? "true" : "false",
    );
    // Sync the accessible labels with the action the button now performs;
    // the visible icon swaps via CSS keyed off [data-display].
    if (state.displayMode === "minimized") {
      minimizeButton!.setAttribute("aria-label", "Restore terminal");
      minimizeButton!.setAttribute("title", "Restore terminal");
    } else {
      minimizeButton!.setAttribute("aria-label", "Minimize terminal");
      minimizeButton!.setAttribute("title", "Minimize terminal");
    }
    if (state.displayMode === "fullscreen") {
      fullscreenButton!.setAttribute("aria-label", "Exit fullscreen");
      fullscreenButton!.setAttribute("title", "Exit fullscreen");
    } else {
      fullscreenButton!.setAttribute("aria-label", "Enter fullscreen");
      fullscreenButton!.setAttribute("title", "Enter fullscreen");
    }
  }

  function fitAll() {
    for (const entry of panes.values()) {
      try {
        entry.handle.fit();
      } catch {
        // Ignored: hidden / zero-rect panes throw from FitAddon.
      }
    }
  }

  function paneCount(): number {
    return panes.size;
  }

  function refreshSplitControl() {
    if (paneCount() >= TERMINAL_MAX_PANES) {
      splitButton!.setAttribute("disabled", "");
    } else {
      splitButton!.removeAttribute("disabled");
    }
  }

  function setActivePane(id: string | null) {
    activePaneId = id;
    let activeEntry: TerminalPaneEntry | null = null;
    for (const entry of panes.values()) {
      if (entry.record.id === id) {
        entry.element.setAttribute("data-active", "true");
        activeEntry = entry;
      } else {
        entry.element.removeAttribute("data-active");
      }
    }
    // Move keyboard focus into the active pane's xterm so the user can
    // type immediately after a split, restore, or close. requestAnimationFrame
    // gives xterm.js a tick to finish opening when this runs in the same
    // frame as `addPane()`.
    if (activeEntry) {
      const entry = activeEntry;
      requestAnimationFrame(() => {
        try {
          entry.handle.focus();
        } catch {
          // Pane was torn down between the frame schedule and now.
        }
      });
    }
  }

  function buildPaneElement(
    record: TerminalPaneRecord,
    // `collisionRecovery: false` on replacement panes built by
    // handlePaneCollision, so a server that keeps refusing upgrades for
    // non-auth reasons (e.g. terminal disabled) cannot drive an endless
    // rebuild loop: one recovery per pane. `takeover` when the pane binds
    // to a session currently attached in another window (picker attach).
    options: { collisionRecovery?: boolean; takeover?: boolean } = {},
  ): TerminalPaneEntry {
    const collisionRecovery = options.collisionRecovery !== false;
    const element = document.createElement("div");
    element.className = "terminal-pane";
    element.dataset.sessionId = record.id;

    const host = document.createElement("div");
    host.className = "terminal-pane-host";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "terminal-pane-close";
    close.setAttribute("aria-label", "Close pane");
    close.setAttribute("title", "Close pane");
    close.textContent = "×";

    element.append(host, close);

    // Click anywhere in the pane (other than the close button) makes it
    // active so a subsequent split / keyboard input goes to the right place.
    element.addEventListener("pointerdown", event => {
      if (event.target === close) return;
      setActivePane(record.id);
    });

    const handle = mountTerminalPanel({
      container: host,
      getToken,
      sessionId: record.id,
      fontFamily: config?.fontFamily,
      fontSize: config?.fontSize,
      // Server-initiated disconnect (shell exited via `exit`, server
      // gone, network drop) → tear the dead pane down automatically.
      // No confirmation modal — there's nothing left to confirm losing.
      onClose: () => {
        if (panes.has(record.id)) removePane(record.id);
      },
      // Pre-open failure with valid credentials = another window holds this
      // persisted sessionId. Rebuild with a fresh id instead of showing the
      // (wrong) paste-token form.
      onCollision: collisionRecovery ? () => handlePaneCollision(record.id) : undefined,
      takeover: options.takeover === true,
    });

    const entry: TerminalPaneEntry = { record, handle, element, hostElement: host, closeButton: close };

    close.addEventListener("click", () => {
      requestClosePane(record.id);
    });

    return entry;
  }

  function rebuildPanesContainer() {
    // Render order: by record.createdAt ascending. Inserts the inter-pane
    // resizer between siblings so the user can adjust the split ratio.
    const ordered = Array.from(panes.values()).sort(
      (a, b) => a.record.createdAt - b.record.createdAt,
    );
    panesContainer!.replaceChildren();
    ordered.forEach((entry, index) => {
      panesContainer!.appendChild(entry.element);
      if (index < ordered.length - 1) {
        const innerResizer = document.createElement("div");
        innerResizer.className = "terminal-pane-resizer";
        innerResizer.setAttribute("role", "separator");
        innerResizer.setAttribute("aria-label", "Resize split");
        wireSplitResizer(innerResizer, ordered[index]!.element, ordered[index + 1]!.element);
        panesContainer!.appendChild(innerResizer);
      }
    });
    // The last pane is the absorber: it always carries `flex: 1 1 0` so
    // any space freed by closing a sibling (or container growth) gets
    // filled instead of leaving a gap. Without this, after a resize the
    // surviving panes still hold their `flex: 0 1 <px>` from drag and the
    // panel under-fills its container — which is the symptom of the
    // close-after-resize bug.
    if (ordered.length > 0) {
      ordered[ordered.length - 1]!.element.style.flex = "1 1 0";
    }
    refreshSplitControl();
  }

  // Drag handler for the resizer between two split panes. Locks both
  // adjacent panes with `flex: 0 1 <px>` so flexbox stops redistributing
  // free space across them — without this, every other pane's flex-grow:1
  // pulls width away from the dragged pair and the resizer drifts away
  // from the pointer. The last pane in the container always stays
  // growable so the panel never shows a gap.
  function wireSplitResizer(
    handle: HTMLElement,
    first: HTMLElement,
    second: HTMLElement,
  ) {
    handle.addEventListener("pointerdown", event => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const horizontal = panesContainer!.getAttribute("data-orientation") !== "vertical";
      const start = horizontal ? event.clientX : event.clientY;
      // Snapshot every pane's current size and freeze the ones NOT being
      // dragged. Without this freeze, panes that still have the default
      // `flex: 1 1 0` participate in flexbox redistribution and shrink/grow
      // alongside the dragged pair — visible as: dragging the last
      // resizer (e.g. B-C in 3-pane A B C) also resizes A, because A and
      // the absorber share the leftover space proportionally to their
      // grow factors.
      const allPanes = Array.from(
        panesContainer!.querySelectorAll(".terminal-pane"),
      ) as HTMLElement[];
      const absorber = allPanes[allPanes.length - 1] ?? null;
      for (const pane of allPanes) {
        if (pane === first || pane === second || pane === absorber) continue;
        const rect = pane.getBoundingClientRect();
        const size = horizontal ? rect.width : rect.height;
        pane.style.flex = `0 1 ${size}px`;
      }
      // Re-measure on pointerdown so we always work from current sizes,
      // even if a sibling resizer already locked some panes.
      const firstRect = first.getBoundingClientRect();
      const secondRect = second.getBoundingClientRect();
      const startFirst = horizontal ? firstRect.width : firstRect.height;
      const startSecond = horizontal ? secondRect.width : secondRect.height;
      const total = startFirst + startSecond;
      const minPx = 80;
      document.body.classList.add("is-resizing-terminal");

      function applySizes(nextFirst: number, nextSecond: number) {
        first.style.flex = `0 1 ${nextFirst}px`;
        // Keep the absorber (last pane) growable so the panel never shows a
        // gap when sibling panes' locked bases sum to less than the
        // container. When the absorber itself IS the second pane, the math
        // still works because every other pane is now locked, so the
        // absorber's actual size lands at exactly the expected nextSecond.
        if (second === absorber) {
          second.style.flex = "1 1 0";
        } else {
          second.style.flex = `0 1 ${nextSecond}px`;
        }
      }

      function onMove(ev: PointerEvent) {
        const now = horizontal ? ev.clientX : ev.clientY;
        const delta = now - start;
        const nextFirst = Math.max(minPx, Math.min(total - minPx, startFirst + delta));
        const nextSecond = total - nextFirst;
        applySizes(nextFirst, nextSecond);
        fitAll();
      }
      function onUp(ev: PointerEvent) {
        try {
          handle.releasePointerCapture(ev.pointerId);
        } catch {
          // Pointer already released.
        }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.classList.remove("is-resizing-terminal");
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }

  function addPane(
    record?: Partial<TerminalPaneRecord>,
    options: { takeover?: boolean } = {},
  ): TerminalPaneEntry | null {
    if (panes.size >= TERMINAL_MAX_PANES) return null;
    const id = record?.id ?? crypto.randomUUID();
    const createdAt = record?.createdAt ?? Date.now();
    const fullRecord: TerminalPaneRecord = { id, createdAt };
    const entry = buildPaneElement(fullRecord, { takeover: options.takeover });
    panes.set(id, entry);
    rebuildPanesContainer();
    entry.handle.attach();
    setActivePane(id);
    persistState();
    requestAnimationFrame(() => fitAll());
    return entry;
  }

  async function fetchSessionInventory(): Promise<TerminalSessionInfo[]> {
    try {
      const token = getToken();
      const url = token
        ? `/api/terminal/sessions?t=${encodeURIComponent(token)}`
        : "/api/terminal/sessions";
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) return [];
      const body = (await response.json()) as { sessions?: TerminalSessionInfo[] };
      return Array.isArray(body.sessions) ? body.sessions : [];
    } catch {
      return [];
    }
  }

  async function killSessionRemote(id: string): Promise<boolean> {
    try {
      const token = getToken();
      const url = token
        ? `/api/terminal/sessions/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`
        : `/api/terminal/sessions/${encodeURIComponent(id)}`;
      const response = await fetch(url, { method: "DELETE" });
      return response.status === 204;
    } catch {
      return false;
    }
  }

  // Pane-spawn with the session picker in front: when live sessions exist
  // that this window isn't showing, offer attach / kill / new-shell instead
  // of silently minting a fresh PTY — silent spawning is how orphaned
  // sessions became invisible. Empty (filtered) inventory falls straight
  // through to a fresh pane, keeping the zero-friction default.
  async function addPaneInteractive(): Promise<void> {
    if (panes.size >= TERMINAL_MAX_PANES) return;
    const candidates = pickerCandidates(await fetchSessionInventory(), panes.keys());
    // The await yields: bail if the panel closed or filled up meanwhile.
    if (panel!.hasAttribute("hidden") || panes.size >= TERMINAL_MAX_PANES) return;
    if (candidates.length === 0) {
      addPane();
      return;
    }
    renderSessionPicker(candidates);
  }

  function renderSessionPicker(candidates: TerminalSessionInfo[]) {
    const wrap = document.createElement("div");
    wrap.className = "terminal-pane terminal-picker";
    const heading = document.createElement("p");
    heading.className = "terminal-picker-heading";
    heading.textContent = "Running sessions";
    const list = document.createElement("div");
    list.className = "terminal-picker-list";

    const dismiss = () => wrap.remove();

    for (const session of candidates) {
      const row = document.createElement("div");
      row.className = "terminal-picker-row";

      const label = document.createElement("span");
      label.className = "terminal-picker-label";
      label.textContent = session.label;
      const meta = document.createElement("span");
      meta.className = "terminal-picker-meta";
      meta.textContent = `${session.attached ? "attached elsewhere" : "detached"} · ${formatSessionAge(session.createdAt, Date.now())}`;

      const attach = document.createElement("button");
      attach.type = "button";
      attach.className = "terminal-picker-attach";
      attach.textContent = session.attached ? "Take over" : "Attach";
      attach.addEventListener("click", () => {
        dismiss();
        addPane({ id: session.id, createdAt: Date.now() }, { takeover: session.attached });
      });

      const kill = document.createElement("button");
      kill.type = "button";
      kill.className = "terminal-picker-kill";
      kill.textContent = "Kill";
      kill.setAttribute("aria-label", `Kill session ${session.label}`);
      kill.addEventListener("click", () => {
        kill.disabled = true;
        void killSessionRemote(session.id).then(ok => {
          if (ok) {
            row.remove();
            if (list.childElementCount === 0) {
              // Nothing left to offer — fall through to a fresh shell.
              dismiss();
              addPane();
            }
          } else {
            kill.disabled = false;
          }
        });
      });

      row.append(label, meta, attach, kill);
      list.append(row);
    }

    const fresh = document.createElement("button");
    fresh.type = "button";
    fresh.className = "terminal-picker-fresh";
    fresh.textContent = "New shell";
    fresh.addEventListener("click", () => {
      dismiss();
      addPane();
    });

    wrap.append(heading, list, fresh);
    panesContainer!.appendChild(wrap);
    requestAnimationFrame(() => fresh.focus());
  }

  function removePane(id: string) {
    const entry = panes.get(id);
    if (!entry) return;

    // Pick the successor BEFORE removing so we know the visual neighbor.
    // Prefer the next pane (right of bottom-dock, below in right-dock); if
    // closing the last pane, fall back to its predecessor.
    let successorId: string | null = null;
    if (activePaneId === id) {
      const ordered = Array.from(panes.values()).sort(
        (a, b) => a.record.createdAt - b.record.createdAt,
      );
      const closedIndex = ordered.findIndex(e => e.record.id === id);
      const successor = ordered[closedIndex + 1] ?? ordered[closedIndex - 1] ?? null;
      successorId = successor ? successor.record.id : null;
    }

    try {
      entry.handle.detach();
    } catch {
      // Already detached.
    }
    panes.delete(id);
    rebuildPanesContainer();
    if (activePaneId === id) {
      setActivePane(successorId);
    }
    persistState();
    if (panes.size === 0) {
      setVisible(false);
    } else {
      requestAnimationFrame(() => fitAll());
    }
  }

  let modalAcceptHandler: (() => void) | null = null;
  let modalPreviousFocus: HTMLElement | null = null;
  const modalTitleEl = document.getElementById("terminal-confirm-title");
  const modalBodyEl = document.getElementById("terminal-confirm-body");

  // Modal copy varies with how many sessions the user is about to lose:
  // closing one of several panes is a smaller action than closing the
  // whole panel.
  const MODAL_COPY = {
    pane: {
      title: "Close pane?",
      body: "You'll lose this terminal session and any running processes.",
    },
    panel: {
      title: "Close terminal?",
      body: "You'll lose every shell session in this panel and any running processes.",
    },
  } as const;

  function openConfirmModal(scope: "pane" | "panel", onAccept: () => void) {
    const copy = MODAL_COPY[scope];
    if (modalTitleEl) modalTitleEl.textContent = copy.title;
    if (modalBodyEl) modalBodyEl.textContent = copy.body;
    modalPreviousFocus = (document.activeElement as HTMLElement) ?? null;
    modalAcceptHandler = onAccept;
    modal!.removeAttribute("hidden");
    requestAnimationFrame(() => (modalCancel as HTMLButtonElement).focus());
  }

  function closeConfirmModal(accepted: boolean) {
    modal!.setAttribute("hidden", "");
    const handler = modalAcceptHandler;
    modalAcceptHandler = null;
    if (modalPreviousFocus && document.contains(modalPreviousFocus)) {
      modalPreviousFocus.focus();
    }
    modalPreviousFocus = null;
    if (accepted && handler) handler();
  }

  // A pane's WebSocket upgrade was refused while this window's credentials
  // are valid: another window holds the pane's persisted sessionId. Swap in
  // a rebuilt pane with a fresh id — the other window keeps the session, and
  // this window stops publishing reattach hints so it can never clobber the
  // claimant's.
  function handlePaneCollision(id: string) {
    const entry = panes.get(id);
    if (!entry) return;
    hintOwner = false;
    try {
      entry.handle.detach();
    } catch {
      // Mount already tore itself down.
    }
    panes.delete(id);
    const fresh = buildPaneElement(
      { id: crypto.randomUUID(), createdAt: entry.record.createdAt },
      { collisionRecovery: false },
    );
    panes.set(fresh.record.id, fresh);
    rebuildPanesContainer();
    fresh.handle.attach();
    if (activePaneId === id || activePaneId === null) {
      setActivePane(fresh.record.id);
    }
    persistState();
    requestAnimationFrame(() => fitAll());
  }

  function requestClosePane(id: string) {
    const entry = panes.get(id);
    if (!entry) return;
    if (!entry.handle.isAttached()) {
      // The shell already exited (or the pane never attached). No session
      // to lose, so close silently.
      removePane(id);
      return;
    }
    openConfirmModal("pane", () => {
      // The user accepted losing the session: terminate() closes with the
      // user-terminate code so the server kills the PTY — a plain detach
      // would leave the shell running forever with its pane record gone.
      const current = panes.get(id);
      try {
        current?.handle.terminate();
      } catch {
        // Already torn down.
      }
      removePane(id);
    });
  }

  // Header × — destructive close: terminates every session AND clears the
  // persisted pane list so the next visibility toggle starts fresh. Must
  // terminate (not detach): the pane records are wiped below, so a detached
  // PTY would keep running with no way to ever reattach to it. The keyboard
  // toggle path (setVisible(false) without persist mutation) is intentionally
  // non-destructive: it's symmetric with hide, and the user can re-toggle to
  // reattach to the still-live PTYs.
  function closeAllPanes() {
    for (const id of Array.from(panes.keys())) {
      const entry = panes.get(id);
      if (entry) {
        try {
          entry.handle.terminate();
        } catch {
          // Already torn down.
        }
      }
      panes.delete(id);
    }
    panesContainer!.replaceChildren();
    activePaneId = null;
    // persistState() reads from the panes Map (now empty) so state.panes
    // becomes [], wiping the reattach hints.
    persistState();
    setVisible(false);
  }

  function setVisible(visible: boolean, persist = true) {
    if (visible) {
      panel!.removeAttribute("hidden");
      resizer!.removeAttribute("hidden");
      toggle!.setAttribute("aria-pressed", "true");
      // Restore display mode and dock from persisted state on each show.
      applyDockToDom();
      applyDisplayModeToDom();
      // First show with no panes: spawn one. If the persisted pane list has
      // entries (reload / browser-restart restore path), reuse those
      // sessionIds so the server can hand back the still-live PTYs.
      if (panes.size === 0) {
        if (state.panes.length > 0) {
          for (const record of state.panes.slice(0, TERMINAL_MAX_PANES)) {
            addPane(record);
          }
        } else {
          // Nothing to restore: offer existing sessions (orphans, other
          // windows' shells) before minting a fresh one.
          void addPaneInteractive();
        }
      }
      requestAnimationFrame(() => fitAll());
    } else {
      panel!.setAttribute("hidden", "");
      resizer!.setAttribute("hidden", "");
      toggle!.setAttribute("aria-pressed", "false");
      // Detach every pane on hide. The PTYs keep running server-side, so a
      // re-show reattaches to the same sessions — hiding is never destructive.
      for (const entry of panes.values()) {
        try {
          entry.handle.detach();
        } catch {
          // Already detached.
        }
      }
      panes.clear();
      panesContainer!.replaceChildren();
      activePaneId = null;
    }
    if (persist) writeTerminalVisiblePreference(visible);
  }

  function toggleVisible() {
    const visible = !panel!.hasAttribute("hidden");
    setVisible(!visible);
  }

  function setDock(next: TerminalDock) {
    state = { ...state, dock: next };
    persistState();
    applyDockToDom();
    // Reset any per-pane flex inline style from a previous split so panes
    // share equally after re-orientation — pixel widths set against the
    // horizontal axis don't translate to the vertical axis (and vice
    // versa). The user can re-resize after.
    for (const entry of panes.values()) {
      entry.element.style.flex = "";
      entry.element.style.flexBasis = "";
    }
    requestAnimationFrame(() => fitAll());
  }

  function setDisplayMode(next: TerminalDisplayMode) {
    state = { ...state, displayMode: next };
    persistState();
    applyDisplayModeToDom();
    if (next === "minimized") {
      // Don't dispose xterm — the PTY stays attached so output that arrives
      // while minimized renders into scrollback as soon as we restore.
      return;
    }
    // Restoring (normal | fullscreen) needs xterm to re-fit because the
    // body's rect just changed.
    requestAnimationFrame(() => fitAll());
  }

  function splitActive() {
    if (panes.size >= TERMINAL_MAX_PANES) return;
    // Explicit new-pane action: same picker-first flow as the first open, so
    // orphaned or other-window sessions are reachable from any window.
    void addPaneInteractive();
  }

  // ------------- Wiring -------------

  toggle.addEventListener("click", toggleVisible);
  closeButton.addEventListener("click", () => {
    if (panes.size === 0) {
      setVisible(false);
      return;
    }
    // Closing the panel via the panel-level × is treated as closing every
    // pane; if any are attached, confirm once.
    const anyAttached = Array.from(panes.values()).some(p => p.handle.isAttached());
    if (!anyAttached) {
      closeAllPanes();
      return;
    }
    openConfirmModal("panel", () => closeAllPanes());
  });

  splitButton.addEventListener("click", () => splitActive());
  dockButton.addEventListener("click", () => {
    setDock(state.dock === "bottom" ? "right" : "bottom");
  });
  minimizeButton.addEventListener("click", () => {
    setDisplayMode(state.displayMode === "minimized" ? "normal" : "minimized");
  });
  fullscreenButton.addEventListener("click", () => {
    setDisplayMode(state.displayMode === "fullscreen" ? "normal" : "fullscreen");
  });
  modalCancel.addEventListener("click", () => closeConfirmModal(false));
  modalAccept.addEventListener("click", () => closeConfirmModal(true));
  modal.addEventListener("click", event => {
    // Backdrop click cancels (treated as "no").
    if (event.target === modal) closeConfirmModal(false);
  });

  // Keyboard shortcuts. Capture phase so xterm.js — which attaches its own
  // keydown listener on the helper-textarea inside each pane and may
  // stopPropagation on certain keys — can't shadow our panel-level
  // shortcuts. Don't shadow normal backtick typing inside the terminal —
  // only intercept when a modifier is held; for non-shortcut keys we
  // simply return without preventDefault so xterm still receives them.
  document.addEventListener(
    "keydown",
    event => {
      if (event.altKey) return;
      if (event.key === "`" || event.key === "´") {
        if (!event.ctrlKey && !event.metaKey) return;
        if (event.shiftKey) {
          // Cmd/Ctrl+Shift+` → split.
          if (panel!.hasAttribute("hidden")) return;
          event.preventDefault();
          event.stopPropagation();
          splitActive();
          return;
        }
        // Cmd/Ctrl+` → toggle.
        event.preventDefault();
        event.stopPropagation();
        toggleVisible();
        return;
      }
      // Esc cancels the confirm modal if open; otherwise exits fullscreen.
      // No panel-focus check — when the panel is in fullscreen it's filling
      // the main area and the user expects Esc to escape it regardless of
      // exact focus.
      if (event.key === "Escape") {
        if (!modal!.hasAttribute("hidden")) {
          event.preventDefault();
          event.stopPropagation();
          closeConfirmModal(false);
          return;
        }
        if (state.displayMode === "fullscreen") {
          event.preventDefault();
          event.stopPropagation();
          setDisplayMode("normal");
        }
      }
    },
    true,
  );

  // Drag-to-resize for the panel itself. Orientation depends on the dock:
  // bottom = vertical drag (height), right = horizontal drag (width).
  resizer.addEventListener("pointerdown", event => {
    event.preventDefault();
    // setPointerCapture so a drag that escapes the 4px resizer (or leaves
    // the browser window momentarily) keeps receiving move/up events on
    // this element. Without it, an interrupted drag could leave
    // `is-resizing-terminal` stuck on <body> with the cursor and event
    // routing in a "still resizing" state.
    resizer.setPointerCapture(event.pointerId);
    const dock = effectiveDock();
    document.body.classList.add("is-resizing-terminal");
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = panel!.getBoundingClientRect();
    const startHeight = rect.height;
    const startWidth = rect.width;

    function onMove(ev: PointerEvent) {
      if (dock === "bottom") {
        const delta = startY - ev.clientY;
        const next = clampTerminalHeight(startHeight + delta);
        document.documentElement.style.setProperty("--terminal-panel-height", `${next}px`);
      } else {
        const delta = startX - ev.clientX;
        const next = clampTerminalWidth(startWidth + delta);
        document.documentElement.style.setProperty("--terminal-panel-width", `${next}px`);
      }
      fitAll();
    }

    function onUp(ev: PointerEvent) {
      try {
        resizer.releasePointerCapture(ev.pointerId);
      } catch {
        // Pointer already released.
      }
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-terminal");
      const finalRect = panel!.getBoundingClientRect();
      if (dock === "bottom") {
        state = { ...state, bottomHeight: Math.round(finalRect.height) };
      } else {
        state = { ...state, rightWidth: Math.round(finalRect.width) };
      }
      persistState();
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });

  // Re-evaluate the right-dock fallback on viewport changes so users who
  // narrow the window mid-session don't get stuck with an unusable layout.
  window.addEventListener("resize", () => {
    applyDockToDom();
    fitAll();
  });

  // First paint: apply persisted dock + display mode even before any panes
  // exist so the panel chrome is correctly oriented when shown.
  applyDockToDom();
  applyDisplayModeToDom();

  // Restore visibility from the previous session in this tab.
  if (readTerminalVisiblePreference()) {
    setVisible(true, false);
  }
}
