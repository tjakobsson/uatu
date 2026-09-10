import "./file-navigation.css";
import { workspaceForeground, onWorkspaceForegroundChange, workspaceOverlayHost } from "../hub/mobile/coordinator-context";
import { appState } from "../shell/state";
import { getSelectedDestination, getSelectionGeneration, onSelectionChange } from "../shell/selection";
import { corpusStatus, onCorpusChange } from "../shell/corpus-status";
import { refreshServerStateForContext } from "../shell/events";
import { currentWatchContext } from "../shell/watch-context";
import { applyUserRowClick } from "../shell/follow";
import { activeTab, navigationOverlayBounds, onActiveTabChange, onNavigationOverlayBoundsChange, revealFilesSurface } from "../shell/tab-bar";
import { getNavigationPreferences, onNavigationPreferencesChange } from "../shell/navigation-preferences";
import { onUiModeChange, uiMode } from "../shell/ui-mode";
import { documentLoadState, loadDocument, onDocumentLoadChange } from "./mount";
import { fileSiblings } from "./file-siblings";

export function initPreviewFileNavigation(): void {
  const group = document.createElement("nav");
  group.id = "preview-file-navigation";
  group.setAttribute("aria-label", "Preview file navigation");

  // Recovery card, above the pill. The visible copy names both routes out of a
  // failure, matching the approved design.
  const alert = document.createElement("div");
  alert.className = "preview-nav-alert";
  alert.hidden = true;
  const message = document.createElement("span");
  message.id = "preview-file-navigation-status";
  message.setAttribute("role", "status");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "preview-nav-retry";
  retry.textContent = "Retry";
  alert.append(message, retry);

  // The pill: Back to Files, a divider, then the two direction arrows. The
  // arrows are icon-only; the Files control keeps a visible label, and its
  // accessible name contains that label so it satisfies label-in-name.
  const pill = document.createElement("div");
  pill.className = "preview-nav-pill";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "preview-nav-files";
  back.setAttribute("aria-label", "Back to Files");
  back.innerHTML = '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">'
    + '<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"'
    + ' d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.4 1.6h5a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1z" />'
    + "</svg><span>Files</span>";
  const divider = document.createElement("span");
  divider.className = "preview-nav-divider";
  divider.setAttribute("aria-hidden", "true");
  const arrow = (glyph: string) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "preview-nav-arrow";
    element.textContent = glyph;
    return element;
  };
  const previous = arrow("\u2039");
  const next = arrow("\u203A");
  pill.append(back, divider, previous, next);

  group.append(alert, pill);
  workspaceOverlayHost().append(group);
  let retrying = false;
  let recoveryError = "";
  let recoveryGeneration = -1;

  const place = () => {
    const view = window.visualViewport;
    // Fixed-position boxes resolve against the visual viewport here, so its
    // width/offsets — not the layout viewport's — are the correct basis. A
    // software keyboard shrinks it, which is exactly the tightening we want.
    const top = Math.max(0, view?.offsetTop ?? 0);
    const left = Math.max(0, view?.offsetLeft ?? 0);
    const width = view?.width ?? innerWidth;
    const bottom = top + (view?.height ?? innerHeight);
    const selector = navigationOverlayBounds();
    const edge = selector ? Math.min(bottom, selector.top) : bottom;
    group.dataset.side = getNavigationPreferences().previewSide;
    group.style.setProperty("--preview-nav-left", `${left}px`);
    group.style.setProperty("--preview-nav-right", `${Math.max(0, innerWidth - left - width)}px`);
    group.style.setProperty("--preview-nav-bottom", `${Math.max(0, innerHeight - edge)}px`);
    group.style.maxWidth = `${Math.max(44, width - 16)}px`;
    group.style.maxHeight = `${Math.max(44, edge - top - 16)}px`;
  };
  const render = () => {
    group.hidden = !workspaceForeground() || uiMode() !== "touch" || activeTab() !== "preview";
    if (recoveryGeneration !== getSelectionGeneration()) recoveryError = "";
    const destination = getSelectedDestination();
    const load = documentLoadState();
    const failedLoad = load.documentId === appState.selectedId && ["timeout", "missing-target", "load-error"].includes(load.status);
    const fileContext = appState.previewMode.kind === "document" || (appState.previewMode.kind === "empty" && failedLoad);
    const siblings = destination ? fileSiblings(appState.roots, appState.scope, destination) : null;
    let status = "";
    if (fileContext) {
      if (retrying || corpusStatus() === "loading") status = "Loading file index...";
      else if (corpusStatus() === "index-error") status = "File index unavailable. Retry to refresh.";
      else if (recoveryError) status = recoveryError;
      else if (load.documentId === appState.selectedId && load.status === "pending-selection") status = "Loading selected file...";
      else if (failedLoad) status = load.status === "timeout" ? "File loading timed out. Retry this file."
        : load.status === "missing-target" ? "Selected file is unavailable in the current scope." : "File could not be loaded. Retry this file.";
      else if (!siblings || siblings.kind !== "ready") status = siblings?.kind === "ambiguous" ? "File identity is ambiguous. Retry to refresh." : "Selected file is unavailable in the current scope.";
    }
    const ready = fileContext && !status && siblings?.kind === "ready";
    const single = ready && siblings.files.length === 1;
    previous.hidden = next.hidden = !fileContext || single;
    divider.hidden = previous.hidden;
    previous.disabled = !ready || siblings.index === 0;
    next.disabled = !ready || siblings.index === siblings.files.length - 1;
    previous.setAttribute("aria-label", ready && siblings.index === 0 ? "Previous file (first file)" : "Previous file");
    next.setAttribute("aria-label", ready && siblings.index === siblings.files.length - 1 ? "Next file (last file)" : "Next file");
    for (const arrow of [previous, next]) {
      arrow.dataset.boundary = String(ready && arrow.disabled);
      arrow.setAttribute("aria-describedby", message.id);
    }
    message.textContent = status;
    retry.hidden = !fileContext || !status || retrying || status.startsWith("Loading");
    alert.hidden = !status;
    // A pending load is progress, not a failure; only a real failure gets the
    // warning treatment.
    alert.dataset.tone = status.startsWith("Loading") ? "progress" : "error";
    group.setAttribute("aria-busy", String(retrying || status.startsWith("Loading")));
    place();
  };
  const step = (direction: -1 | 1) => {
    const target = getSelectedDestination();
    if (!target || corpusStatus() !== "ready") return;
    const siblings = fileSiblings(appState.roots, appState.scope, target);
    if (siblings.kind !== "ready") return;
    const destination = siblings.files[siblings.index + direction];
    if (destination) void applyUserRowClick(destination.id);
  };
  previous.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  back.addEventListener("click", revealFilesSurface);
  retry.addEventListener("click", async () => {
    const target = getSelectedDestination();
    const id = appState.selectedId;
    if (!id || retrying) return;
    const generation = getSelectionGeneration();
    const context = JSON.stringify(currentWatchContext());
    const current = () => generation === getSelectionGeneration() && context === JSON.stringify(currentWatchContext());
    retrying = true;
    recoveryError = "";
    render();
    try {
      await refreshServerStateForContext();
      if (!current()) return;
      if (!target || fileSiblings(appState.roots, appState.scope, target).kind !== "ready") {
        recoveryGeneration = generation;
        recoveryError = "Selected file is unavailable in the current scope.";
        return;
      }
      retrying = false;
      await loadDocument(id);
    } catch {
      // The corpus owner publishes the failure; the intended selection stays intact.
    } finally {
      retrying = false;
      render();
    }
  });
  onSelectionChange(render);
  onCorpusChange(render);
  onDocumentLoadChange(render);
  onActiveTabChange(render);
  onWorkspaceForegroundChange(render);
  onUiModeChange(render);
  onNavigationPreferencesChange(place);
  onNavigationOverlayBoundsChange(place);
  window.addEventListener("resize", place);
  window.visualViewport?.addEventListener("resize", place);
  window.visualViewport?.addEventListener("scroll", place);
  render();
}
