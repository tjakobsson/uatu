import { escapeHtml as esc } from "../../shared/html";
import type { BackendProblem, MobileHubBackend, OperationResult, ReadResult, StopConsent, CoordinatedResult } from "./backend";
export { readiness } from "./readiness";
export { infoRows, type InfoRow, text, action, listRow, group, field, check, select } from "./design-system";
import { text, action } from "./design-system";
import { mobileHubIcon, type MobileHubIcon } from "./icons";
import type { TaskPort, TaskPresentation } from "./task-view";

export type MobileHubDetail =
  | { kind: "credential"; id: string }
  | { kind: "workspace"; id: string }
  | { kind: "add-credential" | "tools" | "assignments" | "default-folder" | "devices" | "security" | "add-workspace" | "clone" | "folders" };
export type FlowActions = Record<string, () => unknown>;
export type SheetPort = TaskPort;
export type { TaskPort } from "./task-view";
export interface FlowPresentation { icon?: MobileHubIcon; subtitle?: string; primaryAction?: string; secondaryAction?: string; backLabel?: string; actionPlacement?: "frequent" }
export const value = (root: ParentNode, name: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? "";
export const checked = (root: ParentNode, name: string) => root.querySelector<HTMLInputElement>(`[name="${name}"]`)?.checked ?? false;
export const values = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLInputElement>(`[name="${name}"]:checked`)].map(input => input.value);
export function clearSecrets(root: ParentNode) { root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[type="password"], input[type="file"], textarea[data-secret]').forEach(input => { input.value = ""; }); }
export function required(input: string, label: string): string { if (!input.trim()) throw new Error(`${label} is required.`); return input.trim(); }
export function absolute(input: string): string { const path = required(input, "Absolute folder path"); if (!path.startsWith("/") || /[\u0000-\u001f]/.test(path)) throw new Error("Enter an absolute folder path."); return path; }
export function displayName(input: string): string { const name = required(input, "Display name"); if ([...name].length > 64 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error("Use 1–64 visible characters for the display name."); return name; }
export function folderName(input: string): string { const name = required(input, "Folder name"); if (name === "." || name === ".." || /[\/\\\p{Cc}\p{Cf}]/u.test(name)) throw new Error("Enter one folder name, without separators or control characters."); return name; }
export function hubForeground(root: HTMLElement): boolean {
  const hub = root.closest<HTMLElement>(".mh-root");
  return !hub || (!hub.hidden && !hub.inert);
}
/** Announce in the existing alert; reveal only for an explicit failed action.
 * Scroll the owning pane, never the document, and leave native input focus alone. */
export function showContextualError(region: HTMLElement, message: string, options: { reveal?: boolean } = {}) {
  if (!region.isConnected || !hubForeground(region)) return;
  const alert = region.querySelector<HTMLElement>(".mh-sheet-error, .mh-flow-error");
  if (!alert) return;
  alert.textContent = message;
  if (!message || !options.reveal) return;
  const container = alert.closest<HTMLElement>(".mh-sheet-body, .mh-flow-content");
  if (!container) return;
  const bounds = container.getBoundingClientRect(), errorBounds = alert.getBoundingClientRect();
  if (errorBounds.bottom > bounds.bottom) container.scrollTop += errorBounds.bottom - bounds.bottom;
  else if (errorBounds.top < bounds.top) container.scrollTop += errorBounds.top - bounds.top;
}
export function bind(root: HTMLElement, actions: FlowActions) {
  root.onclick = event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-flow]");
    if (!button || !root.isConnected || !hubForeground(root) || !root.contains(button) || button.disabled) return;
    event.stopPropagation(); void actions[button.dataset.flow!]?.();
  };
}

/** Existing pages.ts per-user dismissal key; UTF-8/base64url matches Buffer's
 * encoding without importing its server/credential-runtime dependency graph. */
export function sharedUidKey(user: string): string {
  const bytes = new TextEncoder().encode(user);
  return `uatu.hub.notice.shared-uid-v1:${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
export const sharedUidWarning = "Local workspace credential assignments configure normal tools only. All workspaces run as the Hub OS user, so same-UID processes can inspect runtime files, reach shared agents, unset the configuration, and use credentials assigned elsewhere.";
const dismissed = new Set<string>();
export function advisory(user: string): string {
  const key = sharedUidKey(user);
  try { if (window.localStorage.getItem(key) === "dismissed") dismissed.add(key); } catch { /* in-memory fallback */ }
  return dismissed.has(key) ? "" : `<aside class="mh-advisory" data-shared-uid aria-label="Credential security"><h2>${mobileHubIcon("shield")}<span>Credentials are shared on this Hub</span></h2>${text("Assignments choose defaults for tools. They do not prevent another workspace on this Hub from accessing a credential.")}${action("dismiss-advisory", "Dismiss")}</aside>`;
}
export function dismissAdvisory(user: string, root: HTMLElement) {
  const key = sharedUidKey(user); dismissed.add(key);
  try { window.localStorage.setItem(key, "dismissed"); } catch { /* in-memory fallback */ }
  root.querySelectorAll("[data-shared-uid]").forEach(el => el.remove());
}

export interface FlowEnvironment {
  backend: MobileHubBackend;
  root: HTMLElement;
  sheet: SheetPort;
  user(): string;
  /** Immutable authenticated owner; unlike current(), survives presentation changes. */
  authContext(): { user: string; current(): boolean };
  page(title: string, body: string, actions?: FlowActions, presentation?: FlowPresentation): HTMLElement;
  task(title: string, body: string, primary?: { label: string; run: (root: HTMLElement) => void | Promise<void> }, actions?: FlowActions, cancel?: () => void, options?: { cancelLabel?: string; destructive?: boolean }): HTMLElement;
  confirm: FlowEnvironment["task"];
  read<T>(read: () => Promise<ReadResult<T>>, success: (value: T) => void, retry: () => void): Promise<void>;
  mutate<T>(call: () => Promise<OperationResult<T>>, success: (value: T) => void | Promise<void>, root?: HTMLElement): Promise<void>;
  coordinated<T>(title: string, call: (stop: StopConsent) => Promise<OperationResult<CoordinatedResult<T>>>, success: (value: T) => void): Promise<void>;
  navigate(detail: MobileHubDetail): void;
  home(): void;
  changed(): void;
  authLost(): void;
  openWorkspace(id: string): void;
  current(): () => boolean;
}

export function createFlowEnvironment(root: HTMLElement, backend: MobileHubBackend, sheet: SheetPort, hooks: {
  user(): string; authContext?(): { user: string; current(): boolean }; home(): void; navigate(detail: MobileHubDetail): void; changed(): void; authLost(): void; openWorkspace(id: string): void;
}) {
  let generation = 0;
  let taskGeneration = 0;
  let activeTask: HTMLElement | undefined;
  let authenticationGeneration = 0;
  let pageBack: () => unknown = hooks.home;
  let pageBackLabel = "Back";
  const problem = (p: BackendProblem) => {
    if (p.kind === "unauthorized") hooks.authLost();
    return p.kind === "rate-limited" ? `${p.message} Retry after ${p.retryAfterSeconds} seconds.` : p.message;
  };
  const env: FlowEnvironment = {
    backend, root, sheet, ...hooks,
    authContext() { if (hooks.authContext) return hooks.authContext(); const captured = authenticationGeneration, user = hooks.user(); return { user, current: () => captured === authenticationGeneration && user === hooks.user() }; },
    current() { const captured = generation, task = taskGeneration, node = activeTask?.isConnected ? activeTask : undefined; return () => captured === generation && task === taskGeneration && (!node || node.isConnected) && hubForeground(root); },
    page(title, body, actions = {}, presentation) {
      pageBack = actions["flow-back"] ?? hooks.home;
      pageBackLabel = presentation?.backLabel ?? "Back";
      clearSecrets(root);
      root.hidden = false;
      root.oninput = null; root.onchange = null;
      root.classList.toggle("mh-object-detail", !!presentation?.icon);
      const heading = `<h1 tabindex="-1">${esc(title)}</h1>`;
      root.innerHTML = `<div class="mh-flow-content"><header class="mh-flow-header"><nav aria-label="Page navigation"><button type="button" class="mh-flow-back" data-flow="flow-back">${mobileHubIcon("back")}<span>${esc(pageBackLabel)}</span></button></nav>${presentation?.icon ? `<span class="mh-tile mh-green">${mobileHubIcon(presentation.icon)}</span>` : ""}${heading}${presentation?.subtitle ? text(presentation.subtitle) : ""}</header>${body}<p class="mh-flow-error" role="alert"></p></div>${presentation?.actionPlacement === "frequent" ? '<nav class="mh-flow-toolbar" aria-label="Page actions"></nav>' : ""}`;
      const toolbar = root.querySelector<HTMLElement>(".mh-flow-toolbar");
      for (const key of new Set([presentation?.secondaryAction, presentation?.primaryAction])) {
        if (!key || key === "flow-back") continue;
        const control = [...root.querySelectorAll<HTMLButtonElement>(".mh-flow-content button[data-flow]")].find(button => button.dataset.flow === key);
        if (control) { toolbar?.append(control); if (key === presentation?.primaryAction && !control.classList.contains("mh-destructive")) control.classList.add("mh-commit"); }
      }
      bind(root, { "flow-back": hooks.home, ...actions, "dismiss-advisory": () => dismissAdvisory(hooks.user(), root) });
      if (!root.inert) root.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
      return root;
    },
    task(title, body, primary, actions = {}, cancel, options) {
      return openTask({ kind: "editor", ...options }, title, body, primary, actions, cancel);
    },
    confirm(title, body, primary, actions = {}, cancel, options) {
      return openTask({ kind: "confirmation", ...options }, title, body, primary, actions, cancel);
    },
    async read(read, success, retry) {
      const current = env.current();
      // A failed read belongs to the page that started it, including its caller.
      const back = pageBack, backLabel = pageBackLabel;
      try { const result = await read(); if (!current()) return; if (result.status === "available") success(result.value); else { const message = problem(result.problem); if (result.problem.kind !== "unauthorized") env.page("Information unavailable", text(message) + action("retry", "Retry"), { retry, "flow-back": back }, { primaryAction: "retry", backLabel }); } }
      catch { if (current()) env.page("Information unavailable", text("This information could not be loaded.") + action("retry", "Retry"), { retry, "flow-back": back }, { primaryAction: "retry", backLabel }); }
    },
    async mutate(call, success, context) {
      const current = env.current();
      const region = context ?? root;
      const alert = region.querySelector<HTMLElement>('.mh-sheet-error, .mh-flow-error');
      const ownsRegion = () => current() && region.isConnected && (!alert || region.contains(alert));
      if (region.getAttribute("aria-busy") === "true") return;
      region.setAttribute("aria-busy", "true");
      const controls = [...region.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input,select,textarea,button")].filter(control => !control.disabled);
      const focused = controls.find(control => control === region.ownerDocument.activeElement);
      controls.forEach(control => { control.disabled = true; });
      if (alert) alert.textContent = "";
      let uncertain = false;
      try {
        const result = await call(); if (!ownsRegion()) return;
        if (result.status === "completed") await success(result.value);
        else { uncertain = result.status === "indeterminate"; const message = result.status === "rejected" ? problem(result.problem) : `${result.message} The outcome is not confirmed. Reconcile the current state before retrying; do not repeat this operation blindly.`; if (current()) showContextualError(region, message, { reveal: true }); }
      } catch { uncertain = true; if (ownsRegion()) showContextualError(region, "The operation's outcome could not be confirmed. Check the current state before retrying.", { reveal: true }); }
      finally {
        region.removeAttribute("aria-busy");
        region.querySelector("[data-task-pending]")?.remove();
        // An unknown mutation is not safe to repeat from the same submit button.
        controls.forEach(control => {
          if (!uncertain || control.tagName !== "BUTTON" || control.dataset.action === "cancel-sheet" || control.dataset.flow === "flow-back") control.disabled = false;
        });
        // Disabling a submitted native input can blur it. Restore only that
        // action's focus, never override a user who moved to another control.
        const active = region.ownerDocument.activeElement;
        if (ownsRegion() && focused?.isConnected && !focused.disabled && (active === region.ownerDocument.body || active === region || active === focused)) focused.focus({ preventScroll: true });
        if (uncertain && ownsRegion()) {
          const reconcile = root.ownerDocument.createElement("button");
          reconcile.type = "button"; reconcile.className = "mh-text-action"; reconcile.textContent = "Check current Hub state";
          reconcile.onclick = event => { event.stopPropagation(); sheet.close(); hooks.changed(); hooks.home(); };
          (region.querySelector(".mh-sheet-body") ?? region).appendChild(reconcile);
        }
      }
    },
    async coordinated(title, call, success) {
      const run = (stop: StopConsent, context?: HTMLElement) => env.mutate(() => call(stop), result => {
        if (result.status === "completed") { sheet.close(); hooks.changed(); success(result.value); }
        else env.confirm(title, text(`Stopping these workspaces terminates their shells: ${result.workspaceIds.join(", ")}. The catalog changes only after all required stops succeed. Some sessions may already have stopped if stopping fails.`), { label: "Stop and continue", run: task => run("stop-dependent-workspaces", task) });
      }, context);
      await run("ask", root);
    },
  };
  function openTask(presentation: TaskPresentation, title: string, body: string, primary?: Parameters<FlowEnvironment["task"]>[2], actions: FlowActions = {}, cancel?: () => void) {
    taskGeneration++;
    const route = generation, task = taskGeneration;
    const current = () => route === generation && task === taskGeneration && hubForeground(root);
    let taskRoot: HTMLElement;
    taskRoot = sheet.open(title, body, primary ? { label: primary.label, run: async () => {
      if (!current() || !taskRoot.isConnected) return;
      try { await primary.run(taskRoot); } catch (error) { if (current() && taskRoot.isConnected) sheet.error(error instanceof Error ? error.message : "Invalid form input."); }
    } } : undefined, cancel, presentation);
    activeTask = taskRoot;
    // Legacy ports may ignore the optional presentation argument; retain the
    // semantic dismissal label without introducing another navigation control.
    const dismiss = taskRoot.querySelector('[data-action="cancel-sheet"]');
    if (presentation.cancelLabel && dismiss) dismiss.textContent = presentation.cancelLabel;
    bind(taskRoot, { ...actions, "dismiss-advisory": () => dismissAdvisory(hooks.user(), taskRoot) });
    return taskRoot;
  }
  const clear = () => { pageBack = hooks.home; pageBackLabel = "Back"; clearSecrets(root); root.onclick = null; root.oninput = null; root.onchange = null; root.replaceChildren(); root.hidden = true; };
  return { env, invalidate() { authenticationGeneration++; generation++; sheet.close(); clear(); }, leave() { generation++; clear(); }, begin() { generation++; clear(); root.hidden = false; root.scrollTop = 0; }, };
}
