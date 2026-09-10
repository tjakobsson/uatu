/** Presentation only. Standalone/desktop owners keep their default behavior
 * until a same-document host explicitly installs this seam. */
let foreground = true;
let modal = false;
let presentationRoot: HTMLElement | undefined;
let initialUrl: string | undefined;
/** Lazy first boot may finish while the address bar belongs to Hub/Settings. */
export const workspaceInitialUrl = () => new URL(initialUrl ?? window.location.href);
export function installWorkspaceInitialUrl(url: string) {
  if (initialUrl) throw new Error("A workspace initial URL is already installed");
  initialUrl = url;
  return () => { initialUrl = undefined; };
}
/** Body-level workspace overlays keep their existing fallback outside a host. */
export const workspaceOverlayHost = () => presentationRoot ?? document.body;
export function installWorkspacePresentationRoot(root: HTMLElement) {
  if (presentationRoot) throw new Error("A workspace presentation root is already installed");
  presentationRoot = root;
  return () => { presentationRoot = undefined; };
}
let dispatch: ((event: PopStateEvent) => boolean) | undefined;
let write: ((state: object, url: string, replace: boolean) => boolean) | undefined;
const listeners = new Set<() => void>();
export const workspaceForeground = () => foreground && !modal;
export function onWorkspaceForegroundChange(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setWorkspaceForeground(active: boolean, blockingModal = false) {
  if (foreground === active && modal === blockingModal) return;
  if (typeof document !== "undefined") document.dispatchEvent(new Event("uatu:before-surface-change"));
  foreground = active; modal = blockingModal;
  if (typeof document !== "undefined") document.documentElement.dataset.workspaceForeground = String(workspaceForeground());
  for (const listener of listeners) listener();
}
export function installMobileHistory(handlers: { dispatch(event: PopStateEvent): boolean; write(state: object, url: string, replace: boolean): boolean }) {
  if (dispatch) throw new Error("A mobile history owner is already installed");
  dispatch = handlers.dispatch; write = handlers.write;
  return () => { dispatch = undefined; write = undefined; };
}
export const dispatchMobileHistory = (event: PopStateEvent) => dispatch?.(event) ?? false;
export const writeMobileHistory = (state: object, url: string, replace: boolean) => write?.(state, url, replace) ?? false;
