import type { CredentialFacts, DeviceView, HubIdentity, KeyTarget, LoadState, MobileHubBackend, WorkspaceView } from "./backend";
import type { PublicCredentialDto } from "../credential-types";
import type { DefaultWorkspaceParentState } from "../preferences";
import { escapeHtml as esc } from "../../shared/html";
import { appUrl } from "../../shared/app-url";
import { DEFAULT_NAVIGATION_PLACEMENT, getNavigationPreferences, setNavigationPreferences, onNavigationPreferencesChange } from "../../shell/navigation-preferences";
import { mobileHubIcon as icon } from "./icons";
import { group as section, text as note, destinationRow as destination, choiceGroup as choices, emptyState } from "./design-system";
import { createMobileHubFlows, type MobileHubDetail } from "./flows";
import { advisory, clearSecrets, dismissAdvisory, field as flowField, showContextualError } from "./flow-ui";
import { branchLabel } from "./workspace-presentation";
export { branchLabel } from "./workspace-presentation";
import { observeMobileHubLayout } from "./layout";
import { createTaskView, type TaskPresentation } from "./task-view";
export type { MobileHubDetail } from "./flows";

export type MobileHubRoute = "hub" | "settings";
export type MobileHubDestination = { kind: "credential"; id: string } | { kind: "add-credential" | "tools" | "assignments" | "default-folder" | "devices" | "security" | "add-workspace" | "folders" };
export interface MobileHubCallbacks {
  navigateWorkspace(workspaceId: string): void;
  returnToWorkspace(workspaceId: string): void;
  setRoute(route: MobileHubRoute): void;
  /** Legacy destination notification when detailChanged is absent. Product
   * views are still owned here; this callback no longer needs to supply them. */
  openDestination?(destination: MobileHubDestination): void;
  authenticationLost?(): void;
  modalChanged?(open: boolean): void;
  taskChanged?(open: boolean): void;
  /** Safe detail identity only. The coordinator serializes validated context,
   * never credential secrets or arbitrary host paths into history. */
  detailChanged?(detail: MobileHubDetail | null): void;
  authenticated?(): void;
}
export type MobileHubReturnTarget = Pick<WorkspaceView, "id" | "displayName" | "path" | "runtime">;

/** A scoped presentation owner. Coordinator owns history, eligibility and retained workspace lifetime. */
export function mountMobileHub(root: HTMLElement, backend: MobileHubBackend, callbacks: MobileHubCallbacks) {
  let route: MobileHubRoute = "hub";
  let identity: HubIdentity | null = null;
  // Keep authenticated ownership across a connection outage, even while the
  // display identity is withheld. A later different user must revoke old work.
  let authenticatedUser: string | null = null;
  let workspaces: LoadState<WorkspaceView[]> = { status: "loading" };
  let credentials: LoadState<PublicCredentialDto[]> = { status: "loading" };
  const credentialFacts = new Map<string, LoadState<CredentialFacts>>();
  let defaultFolder: LoadState<DefaultWorkspaceParentState> = { status: "loading" };
  let devices: LoadState<DeviceView[]> = { status: "loading" };
  let target: MobileHubReturnTarget | null = null;
  let targetUnavailable = false;
  let generation = 0;
  const workspaceGenerations = new Map<string, number>();
  let workspaceTask: string | null = null;
  const workspaceGeneration = (id: string) => workspaceGenerations.get(id) ?? 0;
  const workspaceCurrent = (id: string) => {
    const lifecycle = generation, workspace = workspaceGeneration(id), task = sheetGeneration;
    return () => !disposed && lifecycle === generation && workspace === workspaceGeneration(id) && task === sheetGeneration;
  };
  let readGeneration = 0;
  let credentialReadGeneration = 0;
  let disposed = false;
  let signedOut = false;
  let sheet: HTMLElement | null = null;
  let restoreFocus: HTMLElement | null = null;
  let lastHubTrigger: HTMLElement | null = null;
  let overviewTriggerAction: string | undefined;
  let pending = false;
  let renderDeferred = false;
  let sheetGeneration = 0;
  let sheetCancel: (() => void) | undefined;
  let loginBusy = false, loginError = "", loginUser = "", loginDevice = "";
  let retryAt = 0;
  let loginTimer: ReturnType<typeof setTimeout> | undefined;
  let requestedDetail: MobileHubDetail | undefined;
  let lastInvalidationGeneration = -1;
  const scroll = { hub: 0, settings: 0 };
  root.classList.add("mh-root");
  root.innerHTML = '<div class="mh-page"></div><div class="mh-flow-page" hidden></div><div class="mh-modal-host"></div>';
  const page = root.querySelector<HTMLElement>(".mh-page")!;
  const flowRoot = root.querySelector<HTMLElement>(".mh-flow-page")!;
  const modalHost = root.querySelector<HTMLElement>(".mh-modal-host")!;
  const taskView = createTaskView(modalHost, () => !root.hidden && !root.inert, cancelSheet);
  const stopLayout = observeMobileHubLayout(root);
  const flows = createMobileHubFlows(flowRoot, { ...backend, readWorkspace: async id => {
    const captured = workspaceGeneration(id);
    const result = await backend.readWorkspace(id);
    return captured === workspaceGeneration(id) ? result : { status: "unavailable", problem: { kind: "unavailable", message: "Workspace changed while loading. Check its current status." } };
  } }, {
    open: (title, body, primary, cancel, presentation) => openSheet(title, body, primary, cancel, presentation), close: () => closeSheet(false), busy, error: sheetError,
  }, {
    user: () => identity?.user ?? "", home: () => { render(); }, changed: () => { void refresh(); },
    authContext: () => { const captured = generation, user = authenticatedUser ?? ""; return { user, current: () => !disposed && generation === captured && authenticatedUser === user }; },
    authLost: invalidateAuthentication, openWorkspace: id => { void openWorkspace(id); },
    startWorkspace: w => { if (w.runtime.status === "running") void openWorkspace(w.id); else void start(w); },
    detailChanged: detail => {
      if (callbacks.detailChanged) callbacks.detailChanged(detail);
      else if (detail?.kind === "credential") callbacks.openDestination?.(detail);
      else if (detail && detail.kind !== "workspace" && detail.kind !== "clone") callbacks.openDestination?.({ kind: detail.kind });
      render();
      if (!detail && overviewTriggerAction) [...page.querySelectorAll<HTMLElement>("[data-action]")].find(el => el.dataset.action === overviewTriggerAction)?.focus({ preventScroll: true });
    },
  });
  const deferredDestinations = new Set(["add-credential", "tools", "assignments", "default-folder", "devices", "security", "add-workspace", "folders"]);
  // Local chrome composition seam: label is trusted product HTML and attrs are
  // developer-owned markup with escaped interpolations, never raw user input.
  const button = (action: string, label: string, cls = "", attrs = "") => {
    return `<button type="button" class="${cls}" data-action="${esc(action)}" ${attrs}>${label}</button>`;
  };
  function credentialStatus(c: PublicCredentialDto): string {
    if (c.type === "token") return c.enabled && c.readiness.some(r => r.status === "unavailable") ? "Unavailable" : "";
    const state = credentialFacts.get(c.id);
    if (state?.status === "loading") return "Loading…";
    if (state?.status !== "ready" || state.value.type !== c.type || state.value.lock.status !== "known") return "Unknown";
    return state.value.lock.value === "locked" ? "Locked" : "Unlocked";
  }
  /** Facts update only their existing status text. Never remount an overview,
   * steal focus, or recreate a task draft when a subordinate read completes. */
  function updateCredentialStatus(c: PublicCredentialDto) {
    const row = [...page.querySelectorAll<HTMLElement>("[data-credential-id]")].find(el => el.dataset.credentialId === c.id);
    const value = row?.querySelector<HTMLElement>(".mh-value");
    if (!value) return;
    value.textContent = credentialStatus(c);
    value.title = value.textContent === "Unknown" ? "Lock state unknown. Open credential details for facts and readiness." : "";
  }
  async function loadCredentialFacts(c: PublicCredentialDto, current: () => boolean) {
    try {
      const result = await backend.readCredentialFacts({ id: c.id, type: c.type });
      if (!current()) return;
      if (result.status === "unavailable" && result.problem.kind === "unauthorized") { invalidateAuthentication(); return; }
      credentialFacts.set(c.id, result.status === "available" && result.value.id === c.id && result.value.type === c.type
        ? { status: "ready", value: result.value }
        : { status: "unavailable", problem: result.status === "unavailable" ? result.problem : { kind: "unavailable", message: "Credential facts do not match this credential." } });
    } catch {
      if (!current()) return;
      credentialFacts.set(c.id, { status: "unavailable", problem: { kind: "unavailable", message: "Credential facts could not be loaded." } });
    }
    if (current()) updateCredentialStatus(c);
  }
  function dock() {
    return `<nav class="mh-dock" aria-label="Hub navigation">${target ? button("return", `<small>Return to</small><strong>${esc(target.displayName)}</strong>`, "mh-return", `title="${esc(target.path)}" aria-label="Return to ${esc(target.displayName)}, ${esc(target.path)}" ${targetUnavailable || target.runtime.status !== "running" ? "disabled" : ""}`) : ""}${(["hub", "settings"] as const).map(item => button(item, `${icon(item)}<span>${item === "hub" ? "Hub" : "Settings"}</span>`, `mh-tab ${route === item ? "mh-selected" : ""}`, route === item ? 'aria-current="page"' : "")).join("")}</nav>`;
  }
  function workspaceRow(w: WorkspaceView) {
    const running = w.runtime.status === "running";
    return `<article class="mh-workspace" data-workspace="${esc(w.id)}"><span class="mh-folder">${icon("folder")}</span><div class="mh-workspace-copy"><h3>${esc(w.displayName)}</h3><p>${esc(w.path)}</p></div>${button(`info:${w.id}`, icon("more"), "mh-more", `aria-label="Information and actions for ${esc(w.displayName)}, ${esc(w.path)}"`)}<div class="mh-status ${running ? "mh-running" : ""}">${running ? '<span aria-hidden="true">●</span> Running' : `${icon("branch")}<span>${esc(branchLabel(w.branch))}</span>`}</div>${button(`${running ? "open" : "start"}:${w.id}`, running ? "Open" : "Start", "mh-primary")}</article>`;
  }
  function dashboard() {
    const rows = workspaces.status === "ready" ? workspaces.value : [];
    const running = rows.filter(w => w.runtime.status === "running");
    const stopped = rows.filter(w => w.runtime.status === "stopped");
    const collection = !rows.length ? emptyState("folder", "No workspaces yet", "Add an existing folder, create a project, or clone a repository.") : note("Workspaces stay on your hub, even when a session stops.");
    return `<h1>Workspaces</h1><p class="mh-subtitle">${identity ? esc(identity.host) : ""}${workspaces.status === "ready" ? ` · ${running.length} session${running.length === 1 ? "" : "s"} running` : ""}</p>${target && (targetUnavailable || target.runtime.status === "stopped") ? note(`${target.displayName} ${targetUnavailable ? "is unavailable. Refresh to check its status." : "has stopped. Use Start below to open it again."}`) : ""}${workspaces.status === "loading" ? note("Loading workspaces…") : workspaces.status === "unavailable" ? `<div role="alert">${note(workspaces.problem.message)}${button("refresh", "Retry", "mh-text-action")}</div>` : `${running.length ? section("Running", running.map(workspaceRow).join(""), running.length) : ""}${stopped.length ? section("Ready to start", stopped.map(workspaceRow).join(""), stopped.length) : ""}${collection}`}${button("add-workspace", `${icon("plus")}<span>Add Workspace<small>Existing folder, new project, or clone</small></span>`, "mh-add")}`;
  }
  function credentialCatalog() {
    if (credentials.status === "ready" && !credentials.value.length) return emptyState("key", "No credentials", "Add a credential to set up Git authentication or commit signing on this Hub.");
    return credentials.status === "ready" ? credentials.value.map(c => {
      const type = c.type === "ssh" ? "SSH key" : c.type === "openpgp" ? "OpenPGP key" : "HTTPS / provider token";
      return destination(`credential:${c.id}`, c.name, "key", `${type}${c.enabled ? "" : " · Disabled"}`, credentialStatus(c), "green", c.id);
    }).join("") : credentials.status === "loading" ? note("Loading credentials…") : `<div role="alert">${note(credentials.problem.message)}</div>${button("retry-credentials", "Retry", "mh-text-action")}`;
  }
  async function retryCredentials() {
    const captured = ++credentialReadGeneration, lifecycle = generation, reads = readGeneration;
    const current = () => !disposed && root.isConnected && captured === credentialReadGeneration && lifecycle === generation && reads === readGeneration;
    const update = () => { const region = page.querySelector("[data-credential-catalog]"); if (region) { const top = page.scrollTop; region.innerHTML = credentialCatalog(); page.scrollTop = top; } };
    credentials = { status: "loading" }; update();
    try {
      const result = await backend.readCredentials();
      if (!current()) return;
      if (result.status === "unavailable" && result.problem.kind === "unauthorized") { invalidateAuthentication(); return; }
      credentials = result.status === "available" ? { status: "ready", value: result.value } : { status: "unavailable", problem: result.problem };
    } catch { if (!current()) return; credentials = { status: "unavailable", problem: { kind: "unavailable", message: "Could not load this information. Please retry." } }; }
    credentialFacts.clear();
    if (credentials.status === "ready") for (const c of credentials.value) { credentialFacts.set(c.id, { status: "loading" }); void loadCredentialFacts(c, current); }
    update();
  }
  function settings() {
    const prefs = getNavigationPreferences();
    const folderValue = defaultFolder.status === "ready" ? defaultFolder.value.effective.split("/").filter(Boolean).at(-1) || "/" : defaultFolder.status === "loading" ? "Loading…" : "Unavailable";
    const folderNotice = defaultFolder.status === "ready" && defaultFolder.value.configured && !defaultFolder.value.configuredAvailable ? "Saved folder unavailable; using fallback" : "";
    const deviceCount = devices.status === "ready" ? String(devices.value.length) : devices.status === "loading" ? "Loading…" : "Unavailable";
    const catalog = `<div data-credential-catalog>${credentialCatalog()}</div>`;
    return `<h1>Settings</h1>${identity ? button("identity", `<img src="${esc(appUrl("/assets/uatu-logo.svg"))}" alt=""/><span><strong>${esc(identity.user)}</strong><small>${esc(identity.host)}</small><small class="mh-running">● Connected</small></span>`, "mh-identity") + advisory(identity.user) : ""}${section("Credentials", `${catalog}${button("add-credential", "Add Credential", "mh-text-action")}`)}${note("Secure access for your workspaces. Stored only on this hub.")}${section("Workspaces", destination("default-folder", "Default Folder", "folder", folderNotice, folderValue, "blue") + destination("preview-side", "Preview File Controls", "preview", "Placement on this device", prefs.previewSide === "left" ? "Left" : "Right") + destination("auto-hide", "Navigation Auto-hide", "hub", "", prefs.autoHide ? "After 7 seconds" : "Until I close it"))}${section("Account", destination("devices", "Devices", "device", "", deviceCount) + destination("security", "Session Security", "shield", "", "", "purple"))}${section("More settings", destination("handle", "Navigation Handle", "hub", "Side and vertical placement") + destination("tools", "Credential Tools", "key") + destination("assignments", "Workspace Assignments", "folder"))}`;
  }
  function render() {
    if (disposed) return;
    if (sheet) { renderDeferred = true; return; }
    renderDeferred = false;
    const activeAction = page.contains(root.ownerDocument.activeElement) ? (root.ownerDocument.activeElement as HTMLElement)?.dataset.action : undefined;
    const previousScroll = page.scrollTop;
    clearSecrets(page);
    page.innerHTML = `<header class="mh-brand"><img src="${esc(appUrl("/assets/uatu-logo.svg"))}" alt=""/><span>UatuCode</span></header><main>${signedOut ? login() : !identity ? `<h1>UatuCode</h1>${workspaces.status === "unavailable" ? `<div role="alert">${note(workspaces.problem.message)}${button("refresh", "Retry", "mh-text-action")}</div>` : note("Connecting to hub…")}` : route === "hub" ? dashboard() : settings()}</main>${identity ? dock() : ""}`;
    page.querySelector<HTMLElement>("main")!.inert = !!flows.detail;
    if (flows.detail) page.querySelector("main")!.setAttribute("aria-hidden", "true");
    else page.querySelector("main")!.removeAttribute("aria-hidden");
    page.querySelector("[data-flow=\"dismiss-advisory\"]")?.addEventListener("click", () => { if (identity) dismissAdvisory(identity.user, page); });
    page.querySelector<HTMLFormElement>(".mh-login")?.addEventListener("submit", event => { event.preventDefault(); void signIn(); });
    if (loginBusy) page.querySelectorAll<HTMLInputElement>(".mh-login input").forEach(input => { input.disabled = true; });
    page.scrollTop = previousScroll;
    if (activeAction) [...page.querySelectorAll<HTMLElement>("[data-action]")].find(el => el.dataset.action === activeAction)?.focus();
  }
  function closeSheet(focus = true, replacing = false) {
    if (!sheet) return;
    sheetGeneration++;
    clearSecrets(sheet);
    const action = restoreFocus?.dataset.action;
    sheet = null; sheetCancel = undefined; pending = false; workspaceTask = null; taskView.close(); page.inert = false; flowRoot.inert = false;
    root.classList.remove("mh-task-active");
    if (!replacing) callbacks.taskChanged?.(false);
    callbacks.modalChanged?.(false);
    if (renderDeferred) render();
    if (focus) {
      const trigger = restoreFocus?.isConnected && root.contains(restoreFocus) ? restoreFocus : action ? [...page.querySelectorAll<HTMLElement>("[data-action]")].find(el => el.dataset.action === action) : undefined;
      if (trigger && !trigger.closest("[hidden], [inert]") && !trigger.hasAttribute("disabled")) trigger.focus({ preventScroll: true });
      else if (!flowRoot.hidden) flowRoot.querySelector<HTMLElement>("h1")?.focus();
    }
  }
  function cancelSheet(): "blocked" | "cancelled" {
    if (pending || sheet?.getAttribute("aria-busy") === "true") { taskView.explainPending(); return "blocked"; }
    const cancelled = sheetCancel; closeSheet(); cancelled?.(); return "cancelled";
  }
  function openSheet(title: string, body: string, primary?: { label: string; run: () => void | Promise<void> }, cancel?: () => void, presentation: TaskPresentation = { kind: "editor" }): HTMLElement {
    const replacing = !!sheet;
    closeSheet(false, true);
    const active = root.ownerDocument.activeElement as HTMLElement | null;
    restoreFocus = active && root.contains(active) ? active : lastHubTrigger;
    sheet = taskView.open(title, body, primary, presentation);
    sheetCancel = cancel;
    page.inert = true; flowRoot.inert = true; root.classList.add("mh-task-active"); callbacks.modalChanged?.(presentation.kind === "confirmation");
    if (!replacing) callbacks.taskChanged?.(true);
    return sheet;
  }
  function sheetError(message: string) { if (sheet) showContextualError(sheet, message, { reveal: true }); }
  function uncertainStart(message: string) {
    sheetError(`${message} Check workspace status before starting again.`);
    const commit = sheet?.querySelector<HTMLButtonElement>('[data-action="commit-sheet"]');
    if (commit) commit.disabled = true;
    sheet?.querySelector(".mh-sheet-body")?.insertAdjacentHTML("beforeend", button("check-start-status", "Check workspace status", "mh-text-action"));
  }
  function busy(value: boolean) { pending = value; taskView.busy(value); }
  function dispatchDestination(d: MobileHubDestination) {
    flows.show(d, true);
    render();
  }
  function preference(kind: "preview-side" | "handle" | "auto-hide") {
    const draft = getNavigationPreferences();
    const sideField = (label: string, value: string) => choices("side", label, value, [["left", "Left"], ["right", "Right"]]);
    const title = kind === "preview-side" ? "Preview File Controls" : kind === "handle" ? "Navigation Handle" : "Navigation Auto-hide";
    const body = kind === "preview-side" ? `${sideField("Side", draft.previewSide)}${note("Choose which side shows Preview file controls on this device.")}` : kind === "handle" ? `${sideField("Side", draft.side)}<label class="mh-field">Vertical position<input data-pref="position" type="range" min="0" max="100" step="any" value="${draft.position * 100}"/><span class="mh-range-endpoints" aria-hidden="true"><span>Top</span><span>Bottom</span></span></label>${button("reset-handle", "Reset placement", "mh-text-action")}${note("Moves the collapsed navigation handle. Applies across workspaces on this Hub, on this device.")}` : choices("autoHide", "Hide navigation", String(draft.autoHide), [["true", "After 7 seconds"], ["false", "Until I close it"]]) + note("The timer pauses while you interact. Applies across workspaces on this Hub, on this device.");
    let initialPosition = "";
    const preferenceSheet = openSheet(title, body, { label: "Save", run: () => {
      const value = (name: string) => sheet!.querySelector<HTMLInputElement>(`[data-pref="${name}"]:checked, [data-pref="${name}"]:not([type="radio"])`)!.value;
      if (kind === "preview-side") setNavigationPreferences({ previewSide: value("side") === "right" ? "right" : "left" });
      else if (kind === "auto-hide") setNavigationPreferences({ autoHide: value("autoHide") === "true" });
      else {
        // Compare native control values before percentage conversion. An
        // unchanged field must not round or rewrite its exact saved ratio.
        const side = value("side") === "right" ? "right" : "left";
        const position = value("position");
        const patch: { side?: "left" | "right"; position?: number } = {};
        if (side !== draft.side) patch.side = side;
        if (position !== initialPosition) patch.position = Number(position) / 100;
        if (Object.keys(patch).length) setNavigationPreferences(patch);
      }
      renderDeferred = true; closeSheet();
    } });
    initialPosition = preferenceSheet.querySelector<HTMLInputElement>('[data-pref="position"]')?.value ?? "";
  }
  async function start(w: WorkspaceView, confirmed = false) {
    if (!confirmed && !w.assignments.length) {
      openSheet("Start without credentials?", note(`Git authentication and signing may be unavailable for ${w.displayName}. The workspace can still start.`), { label: "Start", run: () => start(w, true) });
      workspaceTask = w.id;
      return;
    }
    if (!sheet) openSheet("Starting workspace", note(w.displayName));
    workspaceTask = w.id;
    const current = workspaceCurrent(w.id); busy(true);
    try {
      const result = await backend.startWorkspace({ workspaceId: w.id, unassigned: confirmed ? "confirmed-without-credentials" : "not-confirmed" });
      if (!current()) return;
      busy(false);
      if (result.status !== "completed") { if (result.status === "rejected" && result.problem.kind === "unauthorized") { invalidateAuthentication(); return; } if (result.status === "indeterminate") uncertainStart(result.message); else sheetError(result.problem.message); return; }
      if (result.value.status === "running") { closeSheet(); suspend(); callbacks.navigateWorkspace(result.value.workspaceId); void refresh(); }
      else if (result.value.status === "confirm-unassigned") { openSheet("Start without credentials?", note("Git authentication and signing may be unavailable. Continue without credentials?"), { label: "Start", run: () => start(w, true) }); workspaceTask = w.id; }
      else unlock(w, result.value.credentials, confirmed);
    } catch { if (current()) { busy(false); uncertainStart("Start status is unknown."); } }
  }
  function unlock(w: WorkspaceView, keys: KeyTarget[], confirmed: boolean) {
    const key = keys[0]; if (!key) { void start(w, confirmed); return; }
    openSheet("Unlock workspace credential", `${note(`Unlock ${key.id} to continue starting ${w.displayName}.`)}<label class="mh-field">Passphrase<input type="password" autocomplete="current-password" data-secret/></label>`, { label: "Unlock", run: async () => {
      const input = sheet!.querySelector<HTMLInputElement>("[data-secret]")!;
      const passphrase = input.value; input.value = "";
      if (key.type === "openpgp" && !passphrase) { sheetError("A passphrase is required for OpenPGP unlock."); return; }
      const current = workspaceCurrent(w.id); busy(true);
      try {
        const result = await backend.unlockCredential({ target: key, passphrase });
        if (!current()) return;
        busy(false);
        if (result.status !== "completed") { if (result.status === "rejected" && result.problem.kind === "unauthorized") { invalidateAuthentication(); return; } sheetError(result.status === "rejected" ? result.problem.message : result.message); return; }
        unlock(w, keys.slice(1), confirmed);
      } catch { if (current()) { busy(false); sheetError("Unlock could not be confirmed. Try again after checking the credential."); } }
    } });
    workspaceTask = w.id;
  }
  async function openWorkspace(id: string) {
    openSheet("Opening workspace", note("Checking current workspace status…")); busy(true);
    workspaceTask = id;
    const current = workspaceCurrent(id);
    try {
      const result = await backend.readWorkspace(id);
      if (!current()) return;
      busy(false);
      if (result.status === "unavailable" && result.problem.kind === "unauthorized") { invalidateAuthentication(); return; }
      if (result.status === "available" && result.value.runtime.status === "running") { closeSheet(); suspend(); callbacks.navigateWorkspace(id); }
      else { sheetError(result.status === "unavailable" ? result.problem.message : "This workspace has stopped. Use Start on the dashboard to open it again."); void refresh(); }
    } catch { if (current()) { busy(false); sheetError("Workspace status unavailable. No workspace was started."); } }
  }
  function onClick(event: Event) {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!el || el.hasAttribute("disabled") || !root.contains(el) || (sheet && page.contains(el))) return;
    const action = el.dataset.action!;
    if (action === "cancel-sheet") { cancelSheet(); return; }
    if (action === "commit-sheet") return;
    if (action === "check-start-status") { closeSheet(); void refresh(); return; }
    if (action === "reset-handle") { sheet!.querySelectorAll<HTMLInputElement>('[data-pref="side"]').forEach(input => { input.checked = input.value === DEFAULT_NAVIGATION_PLACEMENT.side; }); sheet!.querySelector<HTMLInputElement>('[data-pref="position"]')!.value = String(DEFAULT_NAVIGATION_PLACEMENT.position * 100); return; }
    if (action === "hub" || action === "settings") { show(action); callbacks.setRoute(action); }
    else if (action === "return" && target && !targetUnavailable && target.runtime.status === "running") { const id = target.id; suspend(); callbacks.returnToWorkspace(id); }
    else if (action === "refresh") void refresh();
    else if (action === "retry-credentials" && credentials.status === "unavailable") void retryCredentials();
    else if (action === "preview-side" || action === "handle" || action === "auto-hide") preference(action);
    else if (action === "identity" && identity) openSheet("Hub identity", section("Connected hub", note(identity.user) + note(identity.host) + note(`UatuCode ${identity.version}`)));
    else if (action.startsWith("credential:")) dispatchDestination({ kind: "credential", id: action.slice(11) });
    else if (action === "sign-out") openSheet("Sign out?", note("You will need to sign in again to access this hub. This does not stop workspaces."), { label: "Sign out", run: async () => {
      const captured = generation, task = sheetGeneration; busy(true);
      try { const result = await backend.signOut(); if (captured !== generation || task !== sheetGeneration || disposed) return; busy(false); if (result.status === "completed" || (result.status === "rejected" && result.problem.kind === "unauthorized")) invalidateAuthentication(); else sheetError(result.status === "rejected" ? result.problem.message : result.message); }
      catch { if (captured === generation && task === sheetGeneration) { busy(false); sheetError("Sign-out could not be confirmed. Please try again."); } }
    } }, undefined, { kind: "confirmation", destructive: true });
    else if (action.startsWith("info:") || action.startsWith("start:") || action.startsWith("open:")) {
      if (pending || workspaces.status !== "ready") return;
      const w = workspaces.value.find(w => w.id === action.slice(action.indexOf(":") + 1)); if (!w) return;
      if (action.startsWith("info:")) { flows.show({ kind: "workspace", id: w.id }, true); render(); } else if (action.startsWith("start:")) void start(w); else void openWorkspace(w.id);
    } else if (deferredDestinations.has(action)) dispatchDestination({ kind: action as Exclude<MobileHubDestination["kind"], "credential"> });
  }
  function onKey(event: KeyboardEvent) {
    taskView.key(event);
  }
  // A disabled pending control can move browser focus to body. Modal keyboard
  // ownership must survive that, but only while this Hub is foregrounded.
  const documentModalKey = (event: KeyboardEvent) => { if (!root.contains(event.target as Node)) onKey(event); };
  const rememberTrigger = (event: Event) => {
    const trigger = (event.target as Element).closest<HTMLElement>("button[data-action], button[data-flow]");
    if (trigger && root.contains(trigger) && !trigger.hasAttribute("disabled")) lastHubTrigger = trigger;
    if (trigger && page.contains(trigger)) overviewTriggerAction = trigger.dataset.action;
  };
  const backdrop = (event: Event) => { if ((event.target as HTMLElement).classList.contains("mh-confirmation-backdrop")) cancelSheet(); };
  function resetProtectedState() { generation++; credentialFacts.clear(); retryAt = 0; clearTimeout(loginTimer); loginTimer = undefined; loginError = ""; flows.invalidate(); requestedDetail = undefined; loginBusy = false; identity = null; authenticatedUser = null; target = null; workspaces = { status: "loading" }; credentials = { status: "loading" }; devices = { status: "loading" }; defaultFolder = { status: "loading" }; closeSheet(false); }
  function invalidateAuthentication() { resetProtectedState(); signedOut = true; render(); callbacks.authenticationLost?.(); }
  function login() {
    return `<h1>Sign in required</h1>${note("Sign in to access this hub.")}<form class="mh-login">${flowField("user", "Username", loginUser, "text", 'autocomplete="username" required')}${flowField("password", "Password", "", "password", 'autocomplete="current-password" required')}${flowField("device", "Device label (optional)", loginDevice, "text", 'autocomplete="off"')}<p role="alert" class="mh-sheet-error">${esc(loginError)}</p><button type="submit" class="mh-commit" ${loginBusy || Date.now() < retryAt ? "disabled" : ""}>${loginBusy ? "Signing in…" : "Sign in"}</button></form>`;
  }
  async function signIn() {
    if (loginBusy || Date.now() < retryAt) return;
    const form = page.querySelector<HTMLFormElement>(".mh-login"); if (!form) return;
    const input = (name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    loginUser = input("user").value.trim(); loginDevice = input("device").value.trim(); const password = input("password").value; input("password").value = "";
    if (!loginUser || !password) { loginError = "Enter your username and password."; render(); return; }
    const captured = generation; loginBusy = true; loginError = ""; render();
    try {
      const result = await backend.signIn({ user: loginUser, password, ...(loginDevice ? { deviceLabel: loginDevice } : {}) });
      if (disposed || captured !== generation) return;
      if (result.status === "completed") { resetProtectedState(); identity = result.value; authenticatedUser = result.value.user; signedOut = false; callbacks.authenticated?.(); await refresh(); }
      else { loginError = result.status === "rejected" ? result.problem.message : `${result.message} Sign-in could not be confirmed. Check the connection before trying again.`;
        if (result.status === "rejected" && result.problem.kind === "rate-limited") {
          retryAt = Date.now() + result.problem.retryAfterSeconds * 1000;
          loginError += ` Retry after ${result.problem.retryAfterSeconds} seconds.`;
          const deadline = retryAt; clearTimeout(loginTimer);
          const finishCooldown = () => {
            if (disposed || !signedOut || captured !== generation || retryAt !== deadline) return;
            const remaining = deadline - Date.now();
            if (remaining > 0) { loginTimer = setTimeout(finishCooldown, remaining); return; }
            // A timer is not a new login attempt: retain current inputs, nodes,
            // and focus rather than rendering the old submitted draft again.
            const submit = page.querySelector<HTMLButtonElement>('.mh-login button[type="submit"]');
            if (submit) submit.disabled = loginBusy;
            loginError = "You can try signing in again.";
            const alert = page.querySelector(".mh-login [role=alert]"); if (alert) alert.textContent = loginError;
          };
          loginTimer = setTimeout(finishCooldown, result.problem.retryAfterSeconds * 1000);
        }
      }
    } catch { if (captured === generation) loginError = "Sign-in is unavailable. Check the connection and try again."; }
    finally { loginBusy = false; if (!disposed && captured === generation) render(); }
  }
  async function refresh() {
    const captured = ++readGeneration; let lifecycle = generation;
    const current = () => !disposed && captured === readGeneration && lifecycle === generation;
    workspaces = { status: "loading", previous: workspaces.status === "ready" ? workspaces.value : workspaces.previous };
    if (target) targetUnavailable = true;
    render();
    try {
      const auth = await backend.readAuthentication(); if (!current()) return;
      if (auth.status === "unavailable") {
        if (auth.problem.kind === "unauthorized") { invalidateAuthentication(); return; }
        if (flows.detail) requestedDetail = flows.detail;
        closeSheet(false); flows.leave(); identity = null;
        workspaces = { status: "unavailable", problem: auth.problem }; loginError = auth.problem.message; render(); return;
      }
      if (auth.value.status === "signed-out") { invalidateAuthentication(); return; }
      if (authenticatedUser !== null && authenticatedUser !== auth.value.identity.user) { resetProtectedState(); lifecycle = generation; callbacks.authenticationLost?.(); }
      authenticatedUser = auth.value.identity.user;
      signedOut = false; identity = auth.value.identity;
      if (requestedDetail) { const detail = requestedDetail; requestedDetail = undefined; flows.show(detail); }
      const load = async <T,>(read: () => Promise<import("./backend").ReadResult<T>>, apply: (value: LoadState<T>) => void) => {
        try { const result = await read(); if (!current()) return; if (result.status === "unavailable" && result.problem.kind === "unauthorized") { invalidateAuthentication(); return; } apply(result.status === "available" ? { status: "ready", value: result.value } : { status: "unavailable", problem: result.problem }); render(); }
        catch { if (current()) { apply({ status: "unavailable", problem: { kind: "unavailable", message: "Could not load this information. Please retry." } }); render(); } }
      };
      await Promise.all([
        load(() => backend.readWorkspaces(), value => { workspaces = value; if (target) { const updated = value.status === "ready" ? value.value.find(w => w.id === target!.id) : null; targetUnavailable = !updated; if (updated) target = updated; } }),
        load(() => backend.readCredentials(), value => {
          credentials = value; credentialFacts.clear();
          if (value.status === "ready") for (const c of value.value) {
            credentialFacts.set(c.id, { status: "loading" });
            void loadCredentialFacts(c, current);
          }
        }),
        load(() => backend.readDefaultFolder(), value => { defaultFolder = value; }),
        load(() => backend.readDevices(), value => { devices = value; }),
      ]);
    } catch { if (current()) { if (flows.detail) requestedDetail = flows.detail; closeSheet(false); flows.leave(); identity = null; workspaces = { status: "unavailable", problem: { kind: "unavailable", message: "Could not connect to this hub." } }; loginError = "Could not connect to this hub."; render(); } }
  }
  function show(next: MobileHubRoute, detail?: MobileHubDetail) { scroll[route] = page.scrollTop; closeSheet(false); flows.leave(); route = next; requestedDetail = identity ? undefined : detail; if (detail && identity) flows.show(detail); render(); page.scrollTop = scroll[route]; }
  /** Call before foregrounding a workspace through history/direct dispatch.
   * Clears secret task inputs, not accepted operations or clone subscriptions. */
  function suspend() { closeSheet(false); flows.leave(); }
  const unsubscribe = backend.subscribeInvalidation(event => {
    if (event.generation <= lastInvalidationGeneration) return;
    lastInvalidationGeneration = event.generation;
    if (event.scope === "authentication") invalidateAuthentication();
    // Workspace invalidations are facts, not authentication/view generations.
    // In particular they can arrive before a coordinated command's result:
    // preserve its sheet and current() guard so partial failure stays visible.
    else { if (event.scope === "workspace") {
      workspaceGenerations.set(event.workspaceId, workspaceGeneration(event.workspaceId) + 1);
      // Only navigation/start continuations are revoked here. A stop may be a
      // step of an authorized management operation whose result still owns UI.
      if (workspaceTask === event.workspaceId) closeSheet(false);
      if (target?.id === event.workspaceId) { if (event.reason === "stopped") target = { ...target, runtime: { status: "stopped" } }; else targetUnavailable = true; } render(); } void refresh(); }
  });
  const unpreferences = onNavigationPreferencesChange(() => { if (identity && route === "settings" && !sheet) render(); });
  root.addEventListener("click", rememberTrigger, true); root.addEventListener("click", onClick); root.addEventListener("keydown", onKey); modalHost.addEventListener("click", backdrop);
  root.ownerDocument.addEventListener("keydown", documentModalKey, true);
  render();
  const ready = refresh();
  return {
    ready, show, refresh, suspend,
    get hasTask() { return !!sheet; },
    // Same-context Back is dismissal, not abandonment. Once dispatched it must
    // obey the same pending guard as the disabled header Cancel/Back button.
    cancelTaskFromHistory() { return cancelSheet(); },
    showDetail(detail: MobileHubDetail) { if (identity) { flows.show(detail); render(); } else requestedDetail = detail; },
    setReturnTarget(validated: MobileHubReturnTarget | null) { target = validated; targetUnavailable = false; render(); },
    destroy() { disposed = true; generation++; stopLayout(); credentialFacts.clear(); clearTimeout(loginTimer); flows.destroy(); closeSheet(false); unsubscribe(); unpreferences(); root.removeEventListener("click", rememberTrigger, true); root.removeEventListener("click", onClick); root.removeEventListener("keydown", onKey); root.ownerDocument.removeEventListener("keydown", documentModalKey, true); modalHost.removeEventListener("click", backdrop); root.replaceChildren(); root.classList.remove("mh-root"); },
  };
}
