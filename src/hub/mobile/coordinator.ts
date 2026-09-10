import type { MobileHubBackend } from "./backend";
import { mountMobileHub, type MobileHubRoute, type MobileHubDetail } from "./frontend";
import { dispatchMobileHistory, installMobileHistory, installWorkspaceInitialUrl, installWorkspacePresentationRoot, setWorkspaceForeground, workspaceForeground } from "./coordinator-context";
import { confirmAuthenticatedHubContext, invalidateAuthenticatedHubContext } from "../../shell/hub-nav";
import { createTaskHistory } from "./task-history";

export function mobileHubRoute(url: URL): MobileHubRoute | null {
  if (url.pathname === "/") return "hub";
  if (url.pathname === "/settings" || url.pathname === "/clone") return "settings";
  return null;
}

const detailKinds = new Set(["add-credential", "tools", "assignments", "default-folder", "devices", "security", "add-workspace", "clone"]);
/** Only frontend identities belong in route context, never filesystem authority
 * or form/secret drafts. Unknown/malformed queries fall back to the overview. */
export function mobileHubDetail(url: URL): MobileHubDetail | undefined {
  if (!mobileHubRoute(url)) return;
  if (url.pathname === "/clone") return { kind: "clone" };
  if (url.searchParams.getAll("detail").length !== 1 || url.searchParams.getAll("id").length > 1) return;
  const kind = url.searchParams.get("detail")!;
  if (kind === "credential" || kind === "workspace") {
    const id = url.searchParams.get("id");
    if (id && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id)) return { kind, id };
  } else if (detailKinds.has(kind) && !url.searchParams.has("id")) return { kind: kind as Exclude<MobileHubDetail["kind"], "credential" | "workspace"> };
}
export function mobileHubPath(route: MobileHubRoute, detail?: MobileHubDetail | null): string {
  if (detail?.kind === "clone") return "/clone";
  const path = route === "hub" ? "/" : "/settings";
  if (!detail) return path;
  const query = new URLSearchParams({ detail: detail.kind });
  if ("id" in detail) query.set("id", detail.id);
  return `${path}?${query}`;
}

/** One resident workspace, not a second workspace state/cache. The assembly
 * supplies its canonical context and single-shot existing boot. */
export function mountMobileCoordinator(options: {
  hubRoot: HTMLElement; workspaceRoot: HTMLElement; backend: MobileHubBackend;
  workspaceId: string; basePath: string;
  bootWorkspace(): Promise<void>; revealNavigation(): void;
  eligible(): boolean;
}) {
  const { hubRoot, workspaceRoot, backend, workspaceId, basePath } = options;
  workspaceRoot.classList.add("mh-coordinator-workspace");
  hubRoot.classList.add("mh-coordinator-hub");
  const frame = document.createElement("div");
  frame.className = "mh-coordinator-frame";
  workspaceRoot.before(frame);
  frame.append(workspaceRoot);
  const loading = document.createElement("section");
  loading.className = "mh-coordinator-loading";
  loading.hidden = true;
  loading.innerHTML = '<nav aria-label="Loading workspace navigation"><button type="button">Back to Hub</button></nav><h1>Loading workspace…</h1><p role="status">Please wait while the workspace loads.</p>';
  frame.append(loading);
  const unroot = installWorkspacePresentationRoot(workspaceRoot);
  let boot: Promise<void> | undefined;
  let bootReady = false;
  let visited = false;
  let invalidated = false;
  let resumingHistory = false;
  let restoringTaskHistory = false;
  const earlyHistoryEvents = new WeakSet<PopStateEvent>();
  let taskContextUrl: string | undefined;
  const taskHistory = createTaskHistory(history, () => location.href);
  let epoch = 0;
  let intent = 0;
  const workspaceGenerations = new Map<string, number>();
  let currentRoute: MobileHubRoute = mobileHubRoute(new URL(location.href)) ?? "hub";
  let workspaceUrl = location.pathname.startsWith(basePath) ? location.pathname + location.search + location.hash : basePath;
  const uninitialUrl = installWorkspaceInitialUrl(new URL(workspaceUrl, location.href).href);
  let workspaceState: object = history.state ?? {};
  const hubScrollRoot = () => hubRoot.querySelector<HTMLElement>(".mh-flow-page:not([hidden]) .mh-flow-content") ?? hubRoot.querySelector<HTMLElement>(".mh-page")!;
  let cancelScrollRestore = () => {};
  let restoringScroll = false;
  const restoreHubScroll = (top: unknown) => {
    cancelScrollRestore();
    if (typeof top !== "number" || !Number.isFinite(top) || top < 0) return;
    const target = top;
    restoringScroll = true;
    let frame = 0;
    const observer = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(restore); });
    const cancel = () => { observer.disconnect(); cancelAnimationFrame(frame); restoringScroll = false; };
    function restore() {
      const scroller = hubScrollRoot();
      // Detail reads may still show their short loading view. Wait for the
      // owning view to render, rather than losing its saved offset to clamping.
      if (scroller.scrollHeight - scroller.clientHeight < target) return;
      scroller.scrollTop = target;
      cancel();
    }
    cancelScrollRestore = cancel;
    observer.observe(hubRoot, { childList: true, subtree: true, characterData: true });
    frame = requestAnimationFrame(restore);
  };
  const presentation = (active: boolean) => {
    if (active) cancelScrollRestore();
    if (active) view.suspend();
    setWorkspaceForeground(active && bootReady);
    workspaceRoot.toggleAttribute("data-workspace-loading", !bootReady);
    loading.hidden = !active || bootReady;
    workspaceRoot.inert = !active || !bootReady;
    workspaceRoot.setAttribute("aria-hidden", String(!active || !bootReady));
    // The foreground attribute also drives the interruptible CSS slide. Keep
    // both roots laid out; inertness changes now, never on animation completion.
    workspaceRoot.style.pointerEvents = active && bootReady ? "" : "none";
    hubRoot.hidden = false; hubRoot.inert = active;
    hubRoot.setAttribute("aria-hidden", String(active));
  };
  const showHub = (route: MobileHubRoute, push = true, detail?: MobileHubDetail) => {
    cancelScrollRestore();
    intent++;
    if (workspaceForeground() && visited && location.pathname.startsWith(basePath)) {
      workspaceUrl = location.pathname + location.search + location.hash;
      workspaceState = history.state ?? {};
    }
    currentRoute = route;
    presentation(false);
    restoringTaskHistory = true;
    try { view.show(route, detail); } finally { restoringTaskHistory = false; }
    if (push) taskHistory.write({ mobileHub: { route } }, mobileHubPath(route, detail), false);
  };
  const loseAccess = (preserveManagement = false) => {
    epoch++; intent++; invalidated = true;
    workspaceRoot.setAttribute("data-access-invalidated", "");
    // A dependent stop can be one step of the foreground management command.
    // Revoke the resident workspace without replacing that command's view.
    if (preserveManagement && !workspaceForeground() && loading.hidden) return;
    showHub("hub", false);
    taskHistory.write({ mobileHub: { route: "hub" } }, "/", true);
  };
  const loseAuthentication = () => {
    invalidateAuthenticatedHubContext();
    loseAccess();
  };
  const openWorkspace = async (id: string, push = true): Promise<boolean> => {
    const captured = epoch, request = ++intent;
    const workspaceGeneration = workspaceGenerations.get(id) ?? 0;
    const status = await backend.readWorkspace(id).catch(() => null);
    if (taskHistory.pending) await taskHistory.settled();
    if (captured !== epoch || request !== intent || workspaceGeneration !== (workspaceGenerations.get(id) ?? 0)) return false;
    if (!status || status.status !== "available" || status.value.runtime.status !== "running") {
      if (status?.status === "unavailable" && status.problem.kind === "unauthorized") loseAuthentication();
      else if (id === workspaceId && (status?.status === "available" || status?.status === "unavailable" && status.problem.kind === "not-found")) loseAccess();
      else { showHub("hub"); void view.refresh(); }
      return false;
    }
    if (id !== workspaceId || invalidated || !options.eligible()) {
      location.assign(id === workspaceId ? workspaceUrl : `/s/${encodeURIComponent(id)}/`); return false;
    }
    confirmAuthenticatedHubContext();
    loading.querySelector("h1")!.textContent = `Loading ${status.value.displayName || "workspace"}…`;
    if (push) taskHistory.write({ ...workspaceState, mobileHub: { workspaceId } }, workspaceUrl, false);
    const requestedUrl = workspaceUrl;
    presentation(true);
    visited = true;
    view.setReturnTarget(status.value);
    boot ??= Promise.resolve().then(() => options.bootWorkspace()).then(() => { bootReady = true; }, error => {
      // Remember a failed singleton even if Back already abandoned this intent.
      invalidated = true;
      throw error;
    });
    try { await boot; }
    catch {
      // A failed single-shot workspace boot cannot be retried by importing its
      // singleton again. Withhold it; the next explicit Open is a new document.
      if (captured === epoch && request === intent) loseAccess();
      return false;
    }
    if (captured !== epoch || request !== intent) return false;
    // Boot history writes were retained while the loader owned interaction.
    // Commit them only for this still-current foreground intent.
    // If none changed the route, retain native URL cleanup (e.g. token removal).
    if (workspaceUrl === requestedUrl) workspaceUrl = location.pathname + location.search + location.hash;
    history.replaceState(workspaceState, "", workspaceUrl);
    presentation(true);
    workspaceUrl = location.pathname + location.search + location.hash;
    workspaceState = history.state ?? {};
    options.revealNavigation();
    return true;
  };
  const view = mountMobileHub(hubRoot, backend, {
    navigateWorkspace: id => { void openWorkspace(id); },
    returnToWorkspace: id => { void openWorkspace(id); },
    setRoute: route => showHub(route), authenticationLost: loseAuthentication,
    modalChanged: open => { if (!workspaceForeground()) setWorkspaceForeground(false, open); },
    // A task is one ephemeral workflow entry. Editor -> Review replaces its
    // live nodes within that entry; Back to edit is the flow's cancel callback.
    // No task identity, draft, secret, or operation is serialized. Forward to
    // an expired entry shows only the safe underlying detail, never resubmits.
    // Dismissal consumes the entry; a synchronous result replaces it. All
    // intervening writes serialize through taskHistory until owned Back lands.
    taskChanged: open => {
      if (open) taskContextUrl = new URL(taskHistory.contextUrl, location.href).href;
      else taskContextUrl = undefined;
      if (restoringTaskHistory) return;
      if (open) taskHistory.open({ route: currentRoute, scroll: history.state?.mobileHub?.scroll });
      else taskHistory.close();
    },
    detailChanged: detail => {
      cancelScrollRestore();
      intent++;
      const path = mobileHubPath(currentRoute, detail);
      // Refuse to serialize an unvalidated identity, even if a future flow
      // accidentally hands the coordinator a raw host path.
      if (detail && !mobileHubDetail(new URL(path, location.origin))) return;
      taskHistory.write({ mobileHub: { route: currentRoute } }, path, false);
    },
    authenticated: () => { if (!boot) { invalidated = false; workspaceRoot.removeAttribute("data-access-invalidated"); } },
  });
  loading.querySelector("button")!.addEventListener("click", () => {
    showHub("hub");
    hubRoot.querySelector<HTMLElement>("button, a[href]")?.focus({ preventScroll: true });
  });
  const unwindTask = () => {
    if (!view.hasTask || workspaceForeground() || taskContextUrl !== location.href) return false;
    restoringTaskHistory = true;
    try {
      if (view.cancelTaskFromHistory() === "blocked") {
        // Back already landed on the workflow's safe base entry. Restore the
        // pending entry synchronously, retaining its exact DOM/operation owner.
        // No history.forward() promise may race the eventual result/navigation.
        taskHistory.open({ route: currentRoute, scroll: history.state?.mobileHub?.scroll });
      }
    } finally { restoringTaskHistory = false; }
    return true;
  };
  const unhistory = installMobileHistory({
    dispatch(event) {
      if (resumingHistory) return false;
      if (earlyHistoryEvents.has(event)) return true;
      if (taskHistory.consumePop()) return true;
      const route = mobileHubRoute(new URL(location.href));
      if (route) {
        if (unwindTask()) return true;
        showHub(route, false, mobileHubDetail(new URL(location.href)));
        restoreHubScroll(event.state?.mobileHub?.scroll);
        return true;
      }
      // A history intent leaving Hub revokes task continuations immediately,
      // before the workspace status read/boot can yield to another response.
      view.suspend();
      if (!location.pathname.startsWith(basePath)) { location.assign(location.href); return true; }
      if (invalidated) { showHub("hub", false); history.replaceState({ mobileHub: { route: "hub" } }, "", "/"); return true; }
      const same = location.pathname + location.search + location.hash === workspaceUrl;
      if ((!workspaceForeground() && boot) || !bootReady) {
        const destination = location.href;
        void openWorkspace(workspaceId, false).then(opened => {
          if (!opened || same || location.href !== destination) return;
          // Resume through the existing selection owner, not a duplicated
          // file/hash/commit implementation. Its one dispatch seam runs first.
          resumingHistory = true;
          try { window.dispatchEvent(new PopStateEvent("popstate", { state: event.state })); }
          finally { resumingHistory = false; }
        });
        return true;
      }
      presentation(true);
      if (!boot) { void openWorkspace(workspaceId, false); return true; }
      options.revealNavigation();
      workspaceState = event.state ?? {};
      workspaceUrl = location.pathname + location.search + location.hash;
      return same;
    },
    write(state, url, replace) {
      workspaceState = { ...state, mobileHub: { workspaceId } };
      workspaceUrl = url;
      if (!workspaceForeground()) return true;
      history[replace ? "replaceState" : "pushState"](workspaceState, "", url);
      return true;
    },
  });
  // A started boot promise does not mean the workspace history listener exists.
  // Until ready, forward through the same seam. If a partially loaded workspace
  // listener also sees this exact event, the seam acknowledges it once only.
  const earlyPop = (event: PopStateEvent) => { if (!bootReady && dispatchMobileHistory(event)) earlyHistoryEvents.add(event); };
  window.addEventListener("popstate", earlyPop);
  const click = (event: MouseEvent) => {
    if (!options.eligible() || !workspaceForeground() || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (!link || !workspaceRoot.contains(link) || link.target || link.download) return;
    const url = new URL(link.href);
    const route = url.origin === location.origin ? mobileHubRoute(url) : null;
    if (!route) return;
    event.preventDefault(); event.stopImmediatePropagation(); showHub(route); void view.refresh();
  };
  document.addEventListener("click", click, true);
  const saveHubScroll = (event: Event) => {
    if (taskHistory.pending || restoringScroll || workspaceForeground() || event.target !== hubScrollRoot() || !mobileHubRoute(new URL(location.href))) return;
    history.replaceState({ ...history.state, mobileHub: { ...history.state?.mobileHub, scroll: hubScrollRoot().scrollTop } }, "");
  };
  hubRoot.addEventListener("scroll", saveHubScroll, true);
  const userScrollIntent = () => cancelScrollRestore();
  for (const type of ["pointerdown", "wheel", "keydown"]) hubRoot.addEventListener(type, userScrollIntent, { capture: true, passive: true });
  const unsubscribe = backend.subscribeInvalidation(event => {
    if (event.scope === "workspace") workspaceGenerations.set(event.workspaceId, (workspaceGenerations.get(event.workspaceId) ?? 0) + 1);
    if (event.scope === "authentication") loseAuthentication();
    else if (event.scope === "workspace" && event.workspaceId === workspaceId) loseAccess(true);
  });
  presentation(false);
  if (location.pathname.startsWith(basePath)) { presentation(true); void openWorkspace(workspaceId, false); }
  else view.show(currentRoute, mobileHubDetail(new URL(location.href)));
  return { ready: view.ready, showHub, openWorkspace,
    destroy() { epoch++; taskHistory.destroy(); cancelScrollRestore(); unsubscribe(); unhistory(); unroot(); uninitialUrl(); loading.remove(); window.removeEventListener("popstate", earlyPop); document.removeEventListener("click", click, true); hubRoot.removeEventListener("scroll", saveHubScroll, true); for (const type of ["pointerdown", "wheel", "keydown"]) hubRoot.removeEventListener(type, userScrollIntent, true); view.destroy(); setWorkspaceForeground(true); },
  };
}
