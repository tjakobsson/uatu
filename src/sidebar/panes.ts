// Sidebar pane infrastructure — visibility / collapse / resize / panel
// menu. The pure data shapes (`PaneId`, `PaneState`, `ALL_PANE_DEFS`) live
// in `shell/state.ts`; this module is the DOM-interaction half.

import { MIN_PANE_CONTENT_PX, PANE_FLOOR_PX, allocatePaneHeights, paneParticipatesInStack, wholeRowTrim } from "./pane-stack";
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
import { onUiModeChange, uiMode } from "../shell/ui-mode";

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

// Touch mode's pane stack is an accordion: one pane is expanded at a time
// and takes the stack's remaining height, the others are slim header rows,
// and a pane's title toggles it. Which pane is expanded is its own per-device
// preference, kept apart from the desktop layout's collapsed flags and
// heights so switching an iPad between modes leaves the desktop stack as it
// was. `null`: every pane folded.
const TOUCH_EXPANDED_PANE_KEY = "uatu:touch-expanded-pane";
const DEFAULT_TOUCH_EXPANDED_PANE: PaneId = "files";

function readTouchExpandedPane(): PaneId | null {
  try {
    const raw = presentationLocalStorage()?.getItem(TOUCH_EXPANDED_PANE_KEY);
    if (raw === "none") return null;
    if (raw && isPaneId(raw)) return raw;
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
  return DEFAULT_TOUCH_EXPANDED_PANE;
}

let touchExpandedPane: PaneId | null = readTouchExpandedPane();

function touchAccordion(): boolean {
  return uiMode() === "touch";
}

// Whether a pane is folded to its header in the current mode.
export function paneCollapsed(id: PaneId): boolean {
  return touchAccordion() ? touchExpandedPane !== id : appState.panes[id].collapsed;
}

// Expands or folds a pane in the current mode and persists that mode's
// preference. In touch mode, expanding one pane folds the others.
function setPaneExpanded(id: PaneId, expanded: boolean): void {
  if (touchAccordion()) {
    touchExpandedPane = expanded ? id : touchExpandedPane === id ? null : touchExpandedPane;
    try {
      presentationLocalStorage()?.setItem(TOUCH_EXPANDED_PANE_KEY, touchExpandedPane ?? "none");
    } catch {
      // Ignore storage failures (private mode, quota, etc.).
    }
    return;
  }
  appState.panes[id].collapsed = !expanded;
  persistPaneState();
}

// Shows a pane and expands it (the Search shortcut, the Usage pin, the panels
// menu), leaving every other pane's stored state alone on desktop.
export function revealPane(id: PaneId): void {
  const pane = appState.panes[id];
  if (pane.visible && !paneCollapsed(id)) return;
  pane.visible = true;
  setPaneExpanded(id, true);
  persistPaneState();
  renderSidebar();
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
      setPaneExpanded(paneId, true);
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
      setPaneExpanded(paneId, paneCollapsed(paneId));
      renderSidebar();
    });
  });

  // Touch mode: a pane's title is its accordion toggle (syncPaneTitle).
  document.querySelector(".pane-stack")?.addEventListener("click", event => {
    const toggle = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-pane-toggle]");
    const paneId = toggle?.dataset.paneToggle;
    if (!paneId || !isPaneId(paneId)) return;
    setPaneExpanded(paneId, paneCollapsed(paneId));
    renderSidebar();
  });
  onUiModeChange(() => {
    syncPaneDom();
    schedulePaneHeightNormalization();
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
      const minHeight = paneMinimumHeight(pane);
      const nextMinHeight = nextPane ? paneMinimumHeight(nextPane) : 0;

      // A drag sets heights outright: no whole-row adjustment until the next fit.
      rowTrims.clear();
      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientY - startY;
        const maxHeight = nextPane ? totalHeight - nextMinHeight : 520;
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
        // Touch mode's accordion has one expanded pane and no boundaries to
        // drag; its title button toggles instead.
        if (touchAccordion() || target?.closest("button, select, input, [role='radiogroup']")) {
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
        const prevMinHeight = dragTarget ? paneMinimumHeight(dragTarget.pane) : 0;
        const minHeight = paneMinimumHeight(pane);
        const dragThreshold = 8;
        let dragging = false;

        // A drag sets heights outright: no whole-row adjustment until the next fit.
        rowTrims.clear();
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
            prevMinHeight,
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
              setPaneExpanded(paneId, paneCollapsed(paneId));
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
  onRevealUsagePane(() => revealPane("usage"));

  // Refit the panes whenever the stack's height changes: a window resize, a
  // mode switch, or touch mode's Files tab appearing (the stack measures 0
  // while another tab is in front, so a fit made then is skipped).
  const stack = document.querySelector<HTMLElement>(".pane-stack");
  if (stack && typeof ResizeObserver === "function") {
    let stackHeight = -1;
    new ResizeObserver(() => {
      if (stack.clientHeight === stackHeight) return;
      stackHeight = stack.clientHeight;
      schedulePaneHeightNormalization();
    }).observe(stack);
  }

  syncPaneDom();
  renderPanelsMenu();
}

function nextVisiblePane(paneId: PaneId): HTMLElement | null {
  const index = ALL_PANE_DEFS.findIndex(pane => pane.id === paneId);
  for (const candidate of ALL_PANE_DEFS.slice(index + 1)) {
    const state = appState.panes[candidate.id];
    if (!state.visible || paneCollapsed(candidate.id)) {
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
    if (!state.visible || paneCollapsed(candidate.id)) {
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

// A pane whose feature this session does not serve (the Pull request pane
// without GitHub data) carries `data-pane-unavailable`: it stays out of the
// stack and the panels menu, whatever its stored visibility says. The
// attribute is authored in index.html so the pane never flashes in first.
function paneUnavailable(id: PaneId): boolean {
  return document.querySelector(`[data-pane-id="${id}"]`)?.hasAttribute("data-pane-unavailable") ?? true;
}

export function setPaneAvailable(id: PaneId, available: boolean): void {
  const element = document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
  if (!element || element.hasAttribute("data-pane-unavailable") === !available) return;
  element.toggleAttribute("data-pane-unavailable", !available);
  syncPaneDom();
  renderPanelsMenu();
  schedulePaneHeightNormalization();
}

function paneShown(id: PaneId): boolean {
  return appState.panes[id].visible && !paneUnavailable(id);
}

export function syncPaneDom() {
  const growPaneId = paneIdToGrow();
  const touch = touchAccordion();
  for (const pane of ALL_PANE_DEFS) {
    const element = document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`);
    if (!element) {
      continue;
    }
    const state = appState.panes[pane.id];
    const collapsed = paneCollapsed(pane.id);
    element.hidden = !paneShown(pane.id);
    element.classList.toggle("is-collapsed", collapsed);
    if (touch && !collapsed) {
      // The accordion's one expanded pane takes the rest of the stack.
      element.style.flex = "1 1 0px";
    } else if (!touch && state.height && !collapsed) {
      element.style.flex = `${pane.id === growPaneId ? 1 : 0} 1 ${state.height + (rowTrims.get(pane.id) ?? 0)}px`;
    } else {
      element.style.removeProperty("flex");
    }
    syncPaneTitle(element, pane, touch, collapsed);
    const button = element.querySelector<HTMLButtonElement>("[data-pane-collapse]");
    if (button) {
      button.textContent = collapsed ? "+" : "−";
      button.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${pane.label}`);
    }
  }
}

// A pane's title when it is not its label (the Files pane while a pull
// request is picked: "PR #n files"). Set through here so touch mode's title
// button keeps its text.
const paneTitles = new Map<PaneId, string>();

export function setPaneTitle(id: PaneId, title: string): void {
  paneTitles.set(id, title);
  const heading = document.querySelector<HTMLElement>(`[data-pane-id="${id}"] > .pane-header h2`);
  if (heading) (heading.querySelector<HTMLElement>(":scope > [data-pane-toggle]") ?? heading).textContent = title;
}

// Touch mode: the title is a button that toggles the pane (its ::before
// covers the header row, so the whole row except the actions answers a tap);
// desktop keeps the plain heading and its − / + button.
function syncPaneTitle(element: HTMLElement, pane: (typeof ALL_PANE_DEFS)[number], touch: boolean, collapsed: boolean): void {
  const heading = element.querySelector<HTMLHeadingElement>(":scope > .pane-header h2");
  if (!heading) return;
  let toggle = heading.querySelector<HTMLButtonElement>(":scope > [data-pane-toggle]");
  const title = paneTitles.get(pane.id) ?? pane.label;
  if (!touch) {
    if (toggle) heading.textContent = title;
    return;
  }
  if (!toggle) {
    const body = element.querySelector<HTMLElement>(":scope > .pane-body");
    if (body && !body.id) body.id = `pane-body-${pane.id}`;
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "pane-toggle";
    toggle.dataset.paneToggle = pane.id;
    if (body) toggle.setAttribute("aria-controls", body.id);
    toggle.textContent = title;
    heading.replaceChildren(toggle);
  }
  toggle.setAttribute("aria-expanded", String(!collapsed));
}

function paneIdToGrow(): PaneId | null {
  const filesState = appState.panes.files;
  if (filesState.visible && !paneCollapsed("files")) {
    return "files";
  }
  const visible = ALL_PANE_DEFS.filter(pane => paneShown(pane.id) && !paneCollapsed(pane.id));
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
  // Touch mode's accordion needs no allocation: its expanded pane flexes.
  if (!stack || touchAccordion()) {
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
          visible: paneShown(pane.id),
          collapsed: paneCollapsed(pane.id),
        }),
      ),
    );

  if (visibleExpanded.length === 0) {
    return;
  }

  const collapsedHeight = ALL_PANE_DEFS.reduce((sum, pane) => {
    if (!paneShown(pane.id) || !paneCollapsed(pane.id)) {
      return sum;
    }
    const element = document.querySelector<HTMLElement>(`[data-pane-id="${pane.id}"]`);
    return sum + (element?.getBoundingClientRect().height ?? 0);
  }, 0);
  const availableHeight = Math.max(0, stack.clientHeight - collapsedHeight);
  if (availableHeight <= 0) {
    return;
  }

  const heights = allocatePaneHeights(
    visibleExpanded.map(pane => ({
      id: pane.id,
      requested: pane.state.height ?? pane.element.getBoundingClientRect().height,
      minimum: paneMinimumHeight(pane.element),
      required: paneEssentialContentHeight(pane.element) !== null,
    })),
    availableHeight,
    paneIdToGrow() ?? visibleExpanded.at(-1)!.id,
    PANE_FLOOR_PX,
  );
  for (const pane of visibleExpanded) {
    const height = Math.round(heights.get(pane.id) ?? 0);
    pane.state.height = height;
    pane.element.style.flex = `0 0 ${height}px`;
  }
  // A pane of rows ends on a whole row: the pixels of a row its bottom would
  // cut go to the grow pane (or, when it is the grow pane, the one above).
  // Only the laid-out size moves (rowTrims, which syncPaneDom applies too);
  // the stored heights stay the allocation, so repeated fits never ratchet
  // a pane smaller.
  rowTrims.clear();
  const growId = paneIdToGrow() ?? visibleExpanded.at(-1)!.id;
  for (const [index, pane] of visibleExpanded.entries()) {
    const trim = paneRowTrim(pane.element);
    if (trim <= 0) continue;
    const receiver = pane.id !== growId ? visibleExpanded.find(other => other.id === growId) : visibleExpanded[index - 1];
    if (!receiver) continue;
    rowTrims.set(pane.id, (rowTrims.get(pane.id) ?? 0) - trim);
    rowTrims.set(receiver.id, (rowTrims.get(receiver.id) ?? 0) + trim);
  }
  for (const pane of visibleExpanded) {
    const trim = rowTrims.get(pane.id);
    if (trim) pane.element.style.flex = `0 0 ${(pane.state.height ?? 0) + trim}px`;
  }
}

// Laid-out height adjustments from the last fit (whole rows), by pane.
const rowTrims = new Map<PaneId, number>();

// What a `[data-pane-rows]` pane body gives up to end on a whole row at
// scroll 0 (wholeRowTrim).
function paneRowTrim(pane: HTMLElement): number {
  const body = pane.querySelector<HTMLElement>(":scope > .pane-body[data-pane-rows]");
  if (!body || body.clientHeight === 0) return 0;
  const { rows, origin } = paneRows(body);
  const end = body.querySelector<HTMLElement>("[data-pane-essential-end]")?.getBoundingClientRect().bottom;
  return wholeRowTrim(rows, body.clientHeight, end === undefined ? 0 : end - origin);
}

// A `[data-pane-rows]` body's rows in its content coordinates (0 at the
// top of its scrolled content): the children of `[data-pane-rows]`
// elements, nested ones expanded, hidden ones left out.
export function paneRows(body: HTMLElement): { rows: { top: number; bottom: number }[]; origin: number } {
  const origin = body.getBoundingClientRect().top + (parseFloat(getComputedStyle(body).borderTopWidth) || 0) - body.scrollTop;
  const rows: { top: number; bottom: number }[] = [];
  const collect = (container: Element) => {
    for (const child of container.children) {
      if (child.hasAttribute("data-pane-rows")) { collect(child); continue; }
      const rect = child.getBoundingClientRect();
      if (rect.height > 0) rows.push({ top: rect.top - origin, bottom: rect.bottom - origin });
    }
  };
  collect(body);
  return { rows, origin };
}

// The smallest height an expanded pane may take: its fixed chrome (header
// and any toolbar) plus a few rows of content, or plus its essential content
// when it marks one. Every pane follows the same rule, for the stack
// allocation and for both resize gestures.
function paneMinimumHeight(pane: HTMLElement): number {
  const essential = paneEssentialContentHeight(pane);
  const body = pane.querySelector<HTMLElement>(":scope > .pane-body");
  if (essential !== null && body) {
    // Everything around the body's content box stays as it is.
    const around = pane.getBoundingClientRect().height - body.clientHeight;
    return Math.ceil(around + Math.max(MIN_PANE_CONTENT_PX, essential));
  }
  const chrome = Array.from(pane.querySelectorAll<HTMLElement>(":scope > .pane-header, .pane-toolbar"))
    .reduce((sum, element) => sum + element.getBoundingClientRect().height, 0);
  return Math.ceil(chrome) + MIN_PANE_CONTENT_PX;
}

// A pane whose body holds a `[data-pane-essential-end]` element (the Pull
// request pane's actions) must show everything down to it: the height from
// the body's top to that element's bottom, padding included. Null for other
// panes, and while the pane is not laid out (a hidden touch tab).
function paneEssentialContentHeight(pane: HTMLElement): number | null {
  const body = pane.querySelector<HTMLElement>(":scope > .pane-body");
  const end = body?.querySelector<HTMLElement>("[data-pane-essential-end]");
  if (!body || !end || body.clientWidth === 0) return null;
  const style = getComputedStyle(body);
  const top = body.getBoundingClientRect().top + (parseFloat(style.borderTopWidth) || 0);
  const bottom = end.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(end).marginBottom) || 0);
  return bottom - top + body.scrollTop + (parseFloat(style.paddingBottom) || 0);
}

export function renderPanelsMenu() {
  panelsMenuElement.innerHTML = ALL_PANE_DEFS.filter(pane => !paneUnavailable(pane.id)).map(pane => {
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
