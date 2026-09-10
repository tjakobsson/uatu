import type { MobileHubBackend, WorkspaceView } from "./backend";
import { createFlowEnvironment, type MobileHubDetail, type SheetPort } from "./flow-ui";
import { createCredentialFlows } from "./credential-flows";
import { createWorkspaceFlows } from "./workspace-flows";
import { createOnboardingFlows } from "./onboarding-flows";
import { createCloneFlow } from "./clone-flow";
export type { MobileHubDetail } from "./flow-ui";

export function createMobileHubFlows(root: HTMLElement, backend: MobileHubBackend, sheet: SheetPort, hooks: {
  user(): string; home(): void; changed(): void; authLost(): void; openWorkspace(id: string): void; startWorkspace(w: WorkspaceView): void;
  authContext?(): { user: string; current(): boolean };
  detailChanged?(detail: MobileHubDetail | null): void;
}) {
  let detail: MobileHubDetail | null = null;
  const owner = createFlowEnvironment(root, backend, sheet, { ...hooks, home: () => { leave(); hooks.home(); hooks.detailChanged?.(null); }, navigate: next => show(next, true) });
  const credentials = createCredentialFlows(owner.env);
  const workspaces = createWorkspaceFlows(owner.env, hooks.startWorkspace);
  const onboarding = createOnboardingFlows(owner.env);
  const clone = createCloneFlow(owner.env, credentials.unlock, path => { show({ kind: "add-workspace" }, true); onboarding.browse(path); });
  function show(next: MobileHubDetail, notify = false) {
    clone.hide(); sheet.close(); owner.begin(); detail = next;
    if (notify) hooks.detailChanged?.(next);
    switch (next.kind) {
      case "credential": credentials.detail(next.id); break;
      case "workspace": workspaces.workspace(next.id); break;
      case "add-credential": credentials.chooser(); break;
      case "tools": credentials.tools(); break;
      case "assignments": workspaces.assignments(); break;
      case "devices": workspaces.devices(); break;
      case "security": workspaces.security(); break;
      case "default-folder": onboarding.defaultFolder(); break;
      case "add-workspace": onboarding.add(); break;
      case "clone": clone.show(); break;
    }
  }
  function leave() { detail = null; clone.hide(); owner.leave(); }
  return {
    show, leave,
    get detail() { return detail; },
    workspaceInvalidated(id: string) { if (detail && ((detail.kind === "workspace" && detail.id === id) || detail.kind === "assignments")) show(detail); },
    invalidate() { detail = null; clone.reset(); owner.invalidate(); },
    destroy() { clone.reset(); owner.invalidate(); },
  };
}
