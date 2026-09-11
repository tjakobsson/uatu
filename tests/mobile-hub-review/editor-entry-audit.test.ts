import { afterEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createTaskView } from "../../src/hub/mobile/task-view";
import { createFlowEnvironment } from "../../src/hub/mobile/flow-ui";
import { createWorkspaceFlows } from "../../src/hub/mobile/workspace-flows";
import type { MobileHubBackend, WorkspaceView } from "../../src/hub/mobile/backend";
import type { PublicCredentialDto } from "../../src/hub/credential-types";

// Audit-only RED probes. linkedom does not implement browser focus: record the
// production focus request, not native select-popup behavior.
let restoreFocus: (() => void) | undefined;
afterEach(() => { restoreFocus?.(); restoreFocus = undefined; });
function harness() {
  const { document, window } = parseHTML('<html><body><main></main><aside></aside></body></html>');
  let active: Element | null = null;
  Object.defineProperty(document, "activeElement", { get: () => active });
  const originalFocus = window.HTMLElement.prototype.focus;
  restoreFocus = () => { window.HTMLElement.prototype.focus = originalFocus; };
  window.HTMLElement.prototype.focus = function () { active = this as unknown as Element; };
  const page = document.querySelector("main")! as unknown as HTMLElement;
  const host = document.querySelector("aside")! as unknown as HTMLElement;
  let changes = 0, writes = 0;
  document.addEventListener("change", () => changes++);
  const view = createTaskView(host, () => true, () => {});
  const workspace: WorkspaceView = { id: "audit", displayName: "Audit workspace", path: "/audit", backend: "local", runtime: { status: "stopped" }, branch: { kind: "named", name: "main" }, assignments: [], workspaceApiRevision: 1, credentialRestartRequired: false };
  const credential: PublicCredentialDto = { id: "audit-key", name: "Audit key", type: "ssh", enabled: true, createdAt: "2026-01-01", capabilities: ["ssh-authentication"], metadata: { publicKey: "synthetic", fingerprint: "synthetic" }, assignments: [], readiness: [] };
  const backend = {
    readWorkspaces: async () => ({ status: "available", value: [workspace] }),
    readCredentials: async () => ({ status: "available", value: [credential] }),
    readDevices: async () => ({ status: "available", value: [] }),
    assignWorkspace: async () => { writes++; return { status: "completed", value: undefined }; },
  } as unknown as MobileHubBackend;
  const { env } = createFlowEnvironment(page, backend, {
    open: (title, body, primary, _cancel, presentation) => view.open(title, body, primary, presentation),
    close: view.close, busy: view.busy, error() {},
  }, { user: () => "entry-audit-synthetic", home() {}, navigate() {}, changed() {}, authLost() {}, openWorkspace() {} });
  const flows = createWorkspaceFlows(env, () => {});
  const click = (key: string) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-flow="${key}"], [data-action="${key}"]`);
    if (!button) throw new Error(`Missing action ${key}`);
    button.click();
  };
  return { document, view, host, flows, click, changes: () => changes, writes: () => writes };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

for (const body of ['<input name="name">', '<select name="authentication"><option>Do not change</option></select>', '<textarea name="draft"></textarea>']) {
  test(`RED: editor entry never automatically focuses ${body.split(" ")[0]}`, () => {
    const h = harness();
    h.view.open("Editor", body, { label: "Save", run() { throw new Error("Unrequested save"); } });
    expect(h.changes()).toBe(0);
    expect(h.document.activeElement?.matches("input,select,textarea") ?? false).toBe(false);
  });
}

test("assignment entry emits no change events or backend writes before user edits", async () => {
  const h = harness(); h.flows.assignments("audit"); await settle(); h.click("edit-audit");
  expect(h.host.querySelector('[name="authentication"]')).not.toBeNull();
  expect(h.changes()).toBe(0); expect(h.writes()).toBe(0);
});

test("RED: real assignment editor entry does not focus Git authentication", async () => {
  const h = harness(); h.flows.assignments("audit"); await settle(); h.click("edit-audit");
  expect(h.document.activeElement?.matches("input,select,textarea") ?? false).toBe(false);
});

test("RED: contextual Sign out is not styled as an already-selected blue commit", () => {
  const h = harness(); h.flows.security();
  const signout = h.document.querySelector('[data-flow="signout"]')!;
  expect(signout.classList.contains("mh-destructive")).toBe(true);
  expect(signout.classList.contains("mh-commit")).toBe(false);
});

test("RED: assignment review exposes labeled current/new data, not only gray prose", async () => {
  const h = harness(); h.flows.assignments("audit"); await settle(); h.click("edit-audit");
  const auth = h.host.querySelector('[name="authentication"]')!;
  Object.defineProperty(auth, "value", { configurable: true, value: "audit-key" });
  h.host.querySelector<HTMLInputElement>('[name="host"]')!.value = "git.example.invalid";
  h.click("commit-sheet"); await settle();
  expect(h.host.textContent).toContain("Review changes");
  expect(h.writes()).toBe(0);
  expect(h.host.querySelectorAll("dt").length).toBeGreaterThan(0);
  expect(h.host.querySelectorAll("dd").length).toBeGreaterThan(0);
  expect(h.host.textContent).toMatch(/Current/);
  expect(h.host.textContent).toMatch(/After applying/);
});
