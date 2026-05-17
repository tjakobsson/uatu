// Sidebar pane infrastructure — visibility / collapse / resize / panel
// menu. Extracted from `app.ts` so the sidebar's runtime pane lifecycle
// lives next to the rest of the sidebar feature folder. The pure data
// shapes (`PaneId`, `PaneState`, `PANE_DEFS_BY_MODE`, etc.) continue to
// live in `shell/state.ts`; this module is the DOM-interaction half.

import { renderSidebar } from "./shell";
import { escapeHtml, escapeHtmlAttribute } from "../shared/html";
import type { Mode } from "../shared/types";
import {
  ALL_PANE_DEFS,
  appState,
  paneDefsForMode,
  paneStorageKeyForMode,
  type PaneId,
  type PaneState,
} from "../shell/state";

const panelsToggleElementMaybe = document.querySelector<HTMLButtonElement>("#panels-toggle");
const panelsMenuElementMaybe = document.querySelector<HTMLDivElement>("#panels-menu");

if (!panelsToggleElementMaybe || !panelsMenuElementMaybe) {
  throw new Error("uatu UI failed to initialize (sidebar/panes)");
}

// Locally-scoped non-null aliases. TypeScript's narrowing from the
// throw-if-null guard above doesn't survive into function bodies.
const panelsToggleElement: HTMLButtonElement = panelsToggleElementMaybe;
const panelsMenuElement: HTMLDivElement = panelsMenuElementMaybe;

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
    persistPaneState(appState.mode);
    renderSidebar();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-pane-hide]").forEach(button => {
    button.addEventListener("click", () => {
      const paneId = button.dataset.paneHide as PaneId | undefined;
      if (!paneId || !isPaneId(paneId)) {
        return;
      }
      appState.panes[paneId].visible = false;
      persistPaneState(appState.mode);
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
      persistPaneState(appState.mode);
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
        persistPaneState(appState.mode);
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onUp);
        resizer.removeEventListener("pointercancel", onUp);
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
      resizer.addEventListener("pointercancel", onUp);
    });
  });

  syncPaneDom();
  renderPanelsMenu();
}

export function nextVisiblePane(paneId: PaneId): HTMLElement | null {
  const defs = paneDefsForMode(appState.mode);
  const index = defs.findIndex(pane => pane.id === paneId);
  for (const candidate of defs.slice(index + 1)) {
    const state = appState.panes[candidate.id];
    if (!state.visible || state.collapsed) {
      continue;
    }
    return document.querySelector<HTMLElement>(`[data-pane-id="${candidate.id}"]`);
  }
  return null;
}

export function persistPaneState(mode: Mode) {
  try {
    window.localStorage.setItem(paneStorageKeyForMode(mode), JSON.stringify(appState.panes));
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

export function syncPaneDom() {
  const growPaneId = paneIdToGrow();
  const currentDefs = paneDefsForMode(appState.mode);
  const currentIds = new Set<PaneId>(currentDefs.map(pane => pane.id));
  for (const pane of ALL_PANE_DEFS) {
    const element = document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`);
    if (!element) {
      continue;
    }
    if (!currentIds.has(pane.id)) {
      // Pane is not in the active Mode's catalog — force-hide regardless of
      // its persisted visibility flag for this mode.
      element.hidden = true;
      element.style.removeProperty("flex");
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

export function paneIdToGrow(): PaneId | null {
  const filesState = appState.panes.files;
  if (filesState.visible && !filesState.collapsed) {
    return "files";
  }
  const visible = paneDefsForMode(appState.mode).filter(pane => {
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

export function normalizePaneHeightsToStack() {
  const stack = document.querySelector<HTMLElement>(".pane-stack");
  if (!stack) {
    return;
  }

  const visibleExpanded = paneDefsForMode(appState.mode)
    .map(pane => ({
      id: pane.id,
      element: document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`),
      state: appState.panes[pane.id],
    }))
    .filter((pane): pane is { id: PaneId; element: HTMLElement; state: PaneState[PaneId] } =>
      Boolean(pane.element && pane.state.visible && !pane.state.collapsed),
    );

  if (visibleExpanded.length === 0) {
    return;
  }

  const collapsedHeight = paneDefsForMode(appState.mode).reduce((sum, pane) => {
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
  panelsMenuElement.innerHTML = paneDefsForMode(appState.mode).map(pane => {
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
