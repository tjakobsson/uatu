// Sidebar pane infrastructure — visibility / collapse / resize / panel
// menu. The pure data shapes (`PaneId`, `PaneState`, `ALL_PANE_DEFS`) live
// in `shell/state.ts`; this module is the DOM-interaction half.

import { paneParticipatesInStack } from "./pane-stack";
import { renderSidebar } from "./shell";
import { onRevealUsagePane } from "../chat/usage-pane";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import {
  ALL_PANE_DEFS,
  SIDEBAR_PANES_KEY,
  appState,
  type PaneId,
  type PaneState,
} from "../shell/state";
import { presentationLocalStorage } from "../shell/presentation-storage";

const panelsToggleElementMaybe = document.querySelector<HTMLButtonElement>("#panels-toggle");
const panelsMenuElementMaybe = document.querySelector<HTMLDivElement>("#panels-menu");

if (!panelsToggleElementMaybe || !panelsMenuElementMaybe) {
  throw new Error("uatu UI failed to initialize (sidebar/panes)");
}

// Locally-scoped non-null aliases. TypeScript's narrowing from the
// throw-if-null guard above doesn't survive into function bodies.
const panelsToggleElement: HTMLButtonElement = panelsToggleElementMaybe;
const panelsMenuElement: HTMLDivElement = panelsMenuElementMaybe;

// Owner mutator for `appState.panes` — the boot path hydrates the persisted
// pane layout through this instead of assigning directly.
export function setPaneState(next: PaneState): void {
  appState.panes = next;
}

export function initSidebarPanes() {
  panelsToggleElement.addEventListener("click", () => {
    const expanded = panelsToggleElement.getAttribute("aria-expanded") === "true";
    panelsToggleElement.setAttribute("aria-expanded", String(!expanded));
    panelsMenuElement.hidden = expanded;
  });

  panelsMenuElement.addEventListener("change", event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const paneId = target.value as PaneId;
    if (!isPaneId(paneId)) {
      return;
    }
    appState.panes[paneId].visible = target.checked;
    if (target.checked) {
      appState.panes[paneId].collapsed = false;
    }
    persistPaneState();
    renderSidebar();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-pane-hide]").forEach(button => {
    button.addEventListener("click", () => {
      const paneId = button.dataset.paneHide as PaneId | undefined;
      if (!paneId || !isPaneId(paneId)) {
        return;
      }
      appState.panes[paneId].visible = false;
      persistPaneState();
      renderSidebar();
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-pane-collapse]").forEach(button => {
    button.addEventListener("click", () => {
      const paneId = button.dataset.paneCollapse as PaneId | undefined;
      if (!paneId || !isPaneId(paneId)) {
        return;
      }
      appState.panes[paneId].collapsed = !appState.panes[paneId].collapsed;
      persistPaneState();
      renderSidebar();
    });
  });

  document.querySelectorAll<HTMLElement>("[data-pane-resizer]").forEach(resizer => {
    resizer.addEventListener("pointerdown", event => {
      const paneId = resizer.dataset.paneResizer as PaneId | undefined;
      const pane = paneId ? document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`) : null;
      if (!paneId || !isPaneId(paneId) || !pane) {
        return;
      }
      event.preventDefault();
      resizer.setPointerCapture(event.pointerId);
      normalizePaneHeightsToStack();
      const startY = event.clientY;
      const startHeight = pane.getBoundingClientRect().height;
      const nextPane = nextVisiblePane(paneId);
      const nextStartHeight = nextPane?.getBoundingClientRect().height ?? 0;
      const totalHeight = startHeight + nextStartHeight;
      const minHeight = 72;

      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientY - startY;
        const maxHeight = nextPane ? totalHeight - minHeight : 520;
        const nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + delta));
        appState.panes[paneId].height = Math.round(nextHeight);
        if (nextPane) {
          const nextPaneId = nextPane.dataset.paneId as PaneId | undefined;
          if (nextPaneId && isPaneId(nextPaneId)) {
            appState.panes[nextPaneId].height = Math.round(totalHeight - nextHeight);
          }
        }
        syncPaneDom();
      };
      const onUp = () => {
        persistPaneState();
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onUp);
        resizer.removeEventListener("pointercancel", onUp);
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
      resizer.addEventListener("pointercancel", onUp);
    });
  });

  // Coarse pointers: the pane HEADER is the touch surface — the 6px resizer
  // strip and the small −/+ buttons are no finger targets. Two gestures,
  // disambiguated by the 8px movement threshold:
  //   drag       → moves the boundary above the pane (the previous visible
  //                pane trades height with this one, exactly what that
  //                pane's own resizer does);
  //   double-tap → toggles the pane's collapse, same as the − / + button.
  // Taps on the header's actual controls are excluded up front; headers
  // carry touch-action: none (styles.css) so neither gesture is swallowed
  // by a scroll gesture.
  const coarsePointer =
    typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  if (coarsePointer) {
    const DOUBLE_TAP_MS = 350;
    const DOUBLE_TAP_SLOP_PX = 24;
    document.querySelectorAll<HTMLElement>(".pane-header").forEach(header => {
      let lastTapAt = 0;
      let lastTapX = 0;
      let lastTapY = 0;
      header.addEventListener("pointerdown", event => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button, select, input, [role='radiogroup']")) {
          return;
        }
        const pane = header.closest<HTMLElement>("[data-pane-id]");
        const paneId = pane?.dataset.paneId as PaneId | undefined;
        if (!pane || !paneId || !isPaneId(paneId)) {
          return;
        }
        // The topmost visible pane has no boundary above it to drag, but
        // its header still takes the double-tap.
        const prevPane = previousVisiblePane(paneId);
        const prevPaneId = prevPane?.dataset.paneId as PaneId | undefined;
        const dragTarget = prevPane && prevPaneId && isPaneId(prevPaneId)
          ? { pane: prevPane, paneId: prevPaneId }
          : null;

        if (dragTarget) {
          normalizePaneHeightsToStack();
        }
        // Capture up front, exactly like the resizer above. Touch gets
        // implicit capture, but a coarse-primary hybrid (touchscreen +
        // mouse) does not: without this the pointer can leave the header
        // before any move clears the threshold, sending the rest of the
        // gesture to another element — the drag never starts and these
        // listeners leak. The threshold below is purely drag-vs-tap.
        try {
          header.setPointerCapture(event.pointerId);
        } catch {
          // NotFoundError when the pointer is already gone (or a synthetic
          // event carries no active pointerId). Losing capture only costs
          // the hybrid-device fix above — the gesture still works — so this
          // must not abort the handler before the listeners below register.
        }
        const startY = event.clientY;
        const prevStartHeight = dragTarget?.pane.getBoundingClientRect().height ?? 0;
        const startHeight = pane.getBoundingClientRect().height;
        const totalHeight = prevStartHeight + startHeight;
        const minHeight = 72;
        const dragThreshold = 8;
        let dragging = false;

        const onMove = (moveEvent: PointerEvent) => {
          if (!dragTarget) {
            return;
          }
          const delta = moveEvent.clientY - startY;
          if (!dragging) {
            if (Math.abs(delta) < dragThreshold) {
              return;
            }
            dragging = true;
          }
          const prevHeight = Math.max(
            minHeight,
            Math.min(totalHeight - minHeight, prevStartHeight + delta),
          );
          appState.panes[dragTarget.paneId].height = Math.round(prevHeight);
          appState.panes[paneId].height = Math.round(totalHeight - prevHeight);
          syncPaneDom();
        };
        const onUp = (upEvent: PointerEvent) => {
          if (dragging) {
            persistPaneState();
          } else {
            // A clean tap. Two of them close together on the same header
            // toggle collapse — the reachable version of the − / + button.
            const now = Date.now();
            const isDoubleTap =
              now - lastTapAt < DOUBLE_TAP_MS &&
              Math.hypot(upEvent.clientX - lastTapX, upEvent.clientY - lastTapY) <
                DOUBLE_TAP_SLOP_PX;
            if (isDoubleTap) {
              lastTapAt = 0;
              appState.panes[paneId].collapsed = !appState.panes[paneId].collapsed;
              persistPaneState();
              renderSidebar();
            } else {
              lastTapAt = now;
              lastTapX = upEvent.clientX;
              lastTapY = upEvent.clientY;
            }
          }
          header.removeEventListener("pointermove", onMove);
          header.removeEventListener("pointerup", onUp);
          header.removeEventListener("pointercancel", onCancel);
        };
        const onCancel = () => {
          if (dragging) {
            persistPaneState();
          }
          header.removeEventListener("pointermove", onMove);
          header.removeEventListener("pointerup", onUp);
          header.removeEventListener("pointercancel", onCancel);
        };
        header.addEventListener("pointermove", onMove);
        header.addEventListener("pointerup", onUp);
        header.addEventListener("pointercancel", onCancel);
      });
    });
  }

  // The chat readout's "Keep in sidebar" pin: reveal the Usage pane the way
  // the panels menu would, leaving every other pane's persisted state alone.
  onRevealUsagePane(() => {
    const pane = appState.panes.usage;
    if (pane.visible && !pane.collapsed) return;
    pane.visible = true;
    pane.collapsed = false;
    persistPaneState();
    renderSidebar();
  });

  syncPaneDom();
  renderPanelsMenu();
}

function nextVisiblePane(paneId: PaneId): HTMLElement | null {
  const index = ALL_PANE_DEFS.findIndex(pane => pane.id === paneId);
  for (const candidate of ALL_PANE_DEFS.slice(index + 1)) {
    const state = appState.panes[candidate.id];
    if (!state.visible || state.collapsed) {
      continue;
    }
    return document.querySelector<HTMLElement>(`[data-pane-id="${candidate.id}"]`);
  }
  return null;
}

function previousVisiblePane(paneId: PaneId): HTMLElement | null {
  const index = ALL_PANE_DEFS.findIndex(pane => pane.id === paneId);
  for (const candidate of ALL_PANE_DEFS.slice(0, Math.max(0, index)).reverse()) {
    const state = appState.panes[candidate.id];
    if (!state.visible || state.collapsed) {
      continue;
    }
    return document.querySelector<HTMLElement>(`[data-pane-id="${candidate.id}"]`);
  }
  return null;
}

// Exported so the Search pane can reveal itself from ⇧⌘F and have that
// stick, without reaching into localStorage on its own.
export function persistPaneState(): void {
  try {
    presentationLocalStorage()?.setItem(SIDEBAR_PANES_KEY, JSON.stringify(appState.panes));
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

export function syncPaneDom() {
  const growPaneId = paneIdToGrow();
  for (const pane of ALL_PANE_DEFS) {
    const element = document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`);
    if (!element) {
      continue;
    }
    const state = appState.panes[pane.id];
    element.hidden = !state.visible;
    element.classList.toggle("is-collapsed", state.collapsed);
    if (state.height && !state.collapsed) {
      element.style.flex = `${pane.id === growPaneId ? 1 : 0} 1 ${state.height}px`;
    } else {
      element.style.removeProperty("flex");
    }
    const button = element.querySelector<HTMLButtonElement>("[data-pane-collapse]");
    if (button) {
      button.textContent = state.collapsed ? "+" : "−";
      button.setAttribute("aria-label", `${state.collapsed ? "Expand" : "Collapse"} ${pane.label}`);
    }
  }
}

function paneIdToGrow(): PaneId | null {
  const filesState = appState.panes.files;
  if (filesState.visible && !filesState.collapsed) {
    return "files";
  }
  const visible = ALL_PANE_DEFS.filter(pane => {
    const state = appState.panes[pane.id];
    return state.visible && !state.collapsed;
  });
  return visible.at(-1)?.id ?? null;
}

let paneNormalizationFrame = 0;

export function schedulePaneHeightNormalization() {
  if (paneNormalizationFrame !== 0) {
    window.cancelAnimationFrame(paneNormalizationFrame);
  }
  paneNormalizationFrame = window.requestAnimationFrame(() => {
    paneNormalizationFrame = 0;
    normalizePaneHeightsToStack();
  });
}

function normalizePaneHeightsToStack() {
  const stack = document.querySelector<HTMLElement>(".pane-stack");
  if (!stack) {
    return;
  }

  const visibleExpanded = ALL_PANE_DEFS
    .map(pane => ({
      id: pane.id,
      element: document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`),
      state: appState.panes[pane.id],
    }))
    .filter((pane): pane is { id: PaneId; element: HTMLElement; state: PaneState[PaneId] } =>
      Boolean(
        pane.element
        && paneParticipatesInStack({
          visible: pane.state.visible,
          collapsed: pane.state.collapsed,
        }),
      ),
    );

  if (visibleExpanded.length === 0) {
    return;
  }

  const collapsedHeight = ALL_PANE_DEFS.reduce((sum, pane) => {
    const state = appState.panes[pane.id];
    if (!state.visible || !state.collapsed) {
      return sum;
    }
    const element = document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`);
    return sum + (element?.getBoundingClientRect().height ?? 0);
  }, 0);
  const availableHeight = Math.max(0, stack.clientHeight - collapsedHeight);
  if (availableHeight <= 0) {
    return;
  }

  const minHeight = Math.min(72, Math.floor(availableHeight / visibleExpanded.length));
  const heights = new Map<PaneId, number>();
  for (const pane of visibleExpanded) {
    heights.set(pane.id, Math.max(minHeight, pane.state.height ?? pane.element.getBoundingClientRect().height));
  }

  const total = Array.from(heights.values()).reduce((sum, height) => sum + height, 0);
  if (total > availableHeight) {
    const scale = availableHeight / total;
    for (const [paneId, height] of heights) {
      heights.set(paneId, Math.max(minHeight, Math.floor(height * scale)));
    }
  }

  let normalizedTotal = Array.from(heights.values()).reduce((sum, height) => sum + height, 0);
  const growPaneId = paneIdToGrow() ?? visibleExpanded.at(-1)?.id;
  if (growPaneId && normalizedTotal < availableHeight) {
    heights.set(growPaneId, (heights.get(growPaneId) ?? minHeight) + (availableHeight - normalizedTotal));
    normalizedTotal = availableHeight;
  }

  for (const pane of visibleExpanded) {
    const height = heights.get(pane.id) ?? minHeight;
    pane.state.height = Math.round(height);
    pane.element.style.flex = `0 0 ${Math.round(height)}px`;
  }
}

export function renderPanelsMenu() {
  panelsMenuElement.innerHTML = ALL_PANE_DEFS.map(pane => {
    const checked = appState.panes[pane.id].visible ? " checked" : "";
    return `
      <label class="panel-option">
        <input type="checkbox" value="${escapeHtmlAttribute(pane.id)}"${checked} />
        <span>${escapeHtml(pane.label)}</span>
      </label>
    `;
  }).join("");
}

function isPaneId(value: string): value is PaneId {
  return ALL_PANE_DEFS.some(pane => pane.id === value);
}
