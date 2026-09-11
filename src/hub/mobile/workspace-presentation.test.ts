import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createSyntheticBackend } from "../../../tests/mobile-hub-review/backend";
import { createFlowEnvironment, type SheetPort } from "./flow-ui";
import { createTaskView } from "./task-view";
import { createWorkspaceFlows } from "./workspace-flows";
import { branchLabel, workspaceAssignmentLabels } from "./workspace-presentation";
import type { BranchState, MobileHubBackend, WorkspaceView } from "./backend";
import type { PublicCredentialDto } from "../credential-types";

const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const assignments: WorkspaceView["assignments"] = [
  { workspaceId: "atlas", credentialId: "ssh", role: "authentication", host: "one.invalid" },
  { workspaceId: "atlas", credentialId: "ssh", role: "authentication", host: "one.invalid" },
  { workspaceId: "atlas", credentialId: "ssh", role: "authentication", host: "two.invalid" },
  { workspaceId: "atlas", credentialId: "ssh", role: "signing" },
];
const catalog = [{ id: "ssh", name: "Shared identity" }] as PublicCredentialDto[];
async function harness(readCredentials: MobileHubBackend["readCredentials"], running = true) {
  const model = createSyntheticBackend();
  const original = await model.backend.readWorkspace(running ? "atlas" : "notes");
  if (original.status !== "available") throw Error("fixture missing");
  const w: WorkspaceView = { ...original.value, assignments, credentialRestartRequired: true, branch: { kind: "unborn", name: "next" }, ...(running ? { runtime: { status: "running", shells: { status: "ready", value: [{ label: "Build shell", attached: true }] } } } : {}) };
  const { document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const root = document.querySelector("#root") as unknown as HTMLElement;
  let lost = 0, started = 0, reads = 0, user = "reviewer";
  const host = root.ownerDocument.createElement("div"); root.after(host);
  let onCancel: (() => void) | undefined;
  const cancel = () => { sheet.close(); onCancel?.(); };
  const view = createTaskView(host, () => true, cancel);
  const sheet: SheetPort = {
    open(title, body, primary, back, presentation) {
      onCancel = back; root.hidden = true; root.inert = true;
      const task = view.open(title, body, primary, presentation);
      task.querySelector('[data-action="cancel-sheet"]')!.addEventListener("click", cancel);
      return task;
    },
    close() { view.close(); root.hidden = false; root.inert = false; },
    busy: view.busy, error() {},
  };
  const owner = createFlowEnvironment(root, { ...model.backend, readWorkspace: async () => ({ status: "available", value: w }), readCredentials: () => { reads++; return readCredentials(); } }, sheet, {
    user: () => user, home() {}, navigate() {}, changed() {}, authLost: () => { lost++; owner.invalidate(); }, openWorkspace() {},
  });
  const flows = createWorkspaceFlows(owner.env, () => { started++; });
  owner.begin(); flows.workspace(w.id); await settle();
  return { root, host, owner, w, lost: () => lost, started: () => started, reads: () => reads, changeUser: () => { user = "another-user"; } };
}

test.each([
  [{ kind: "named", name: "main" }, "main"], [{ kind: "unborn", name: "next" }, "next · no commits"],
  [{ kind: "detached", commit: "abc123" }, "Detached · abc123"], [{ kind: "non-git" }, "Not a Git repository"],
  [{ kind: "loading" }, "Loading branch…"], [{ kind: "unavailable", message: "Denied" }, "Branch unavailable: Denied"],
] as [BranchState, string][])("truthful branch presentation %j", (branch, label) => { expect(branchLabel(branch)).toBe(label); });

test("assignment labels retain separate hosts and roles without duplicating defaults", () => {
  expect(workspaceAssignmentLabels(assignments, catalog)).toEqual(["AUTH: Shared identity · one.invalid", "AUTH: Shared identity · two.invalid", "SIGNING: Shared identity"]);
  expect(workspaceAssignmentLabels(assignments, [])).toContain("SIGNING: Missing credential (ssh)");
});

test.each([true, false])("workspace detail preserves facts and a sole contextual Open/Start (running=%s)", async running => {
  const h = await harness(async () => ({ status: "available", value: catalog }), running);
  const values = (region: ParentNode, label: string) => [...region.querySelectorAll(".mh-info-row")].filter(row => row.querySelector("dt")?.textContent === label).map(row => row.querySelector(".mh-info-value")?.textContent);
  expect(values(h.root, "Folder")).toContain(h.w.path); expect(values(h.root, "Stable ID")).toEqual([h.w.id]);
  expect(h.root.textContent).toContain("next · no commits"); expect(h.root.textContent).toContain("Credential changes require a workspace restart.");
  expect(h.root.textContent).toContain("Assignment presence is not credential readiness.");
  const section = (title: string) => [...h.root.querySelectorAll(".mh-section")].find(el => el.querySelector("h2")?.textContent === title)!;
  expect(values(section("Git authentication"), "Host")).toEqual(["one.invalid", "two.invalid"]);
  expect(values(section("Git authentication"), "Credential")).toEqual(["Shared identity", "Shared identity"]);
  expect(values(section("Commit signing"), "Credential")).toEqual(["Shared identity"]);
  if (running) { expect(h.root.textContent).toContain("1 shells"); expect(h.root.textContent).toContain("Build shell · Attached"); }
  expect(h.root.textContent).not.toContain("Workspace actions");
  expect(h.root.querySelectorAll('[data-flow="open"]')).toHaveLength(1);
  const primary = h.root.querySelector<HTMLButtonElement>('.mh-flow-content [data-flow="open"]')!;
  expect(primary.classList.contains("mh-commit")).toBe(false);
  expect(primary.textContent).toBe(running ? "Open" : "Start"); primary.click(); expect(h.started()).toBe(1);
});

test("catalog failure leaves workspace facts and usable commands with explicit unavailable names", async () => {
  const h = await harness(async () => ({ status: "unavailable", problem: { kind: "unavailable", message: "Catalog failed" } }));
  expect(h.root.textContent).toContain("Credential name unavailable (ssh)"); expect(h.root.textContent).toContain(h.w.path);
  expect(h.root.querySelector('[data-flow="open"]')).not.toBeNull(); expect(h.lost()).toBe(0);
});

test("unauthorized catalog side-read invalidates protected detail", async () => {
  const h = await harness(async () => ({ status: "unavailable", problem: { kind: "unauthorized", message: "Expired" } }));
  expect(h.lost()).toBe(1); expect(h.root.textContent).toBe("");
});

test("late credential names cannot repopulate a retired workspace detail", async () => {
  let resolve!: (value: Awaited<ReturnType<MobileHubBackend["readCredentials"]>>) => void;
  const h = await harness(() => new Promise(r => { resolve = r; }));
  expect(h.root.textContent).toContain("Loading credential name");
  h.owner.begin(); h.owner.env.page("Another view", "");
  resolve({ status: "available", value: catalog }); await settle();
  expect(h.root.textContent).not.toContain("Shared identity"); expect(h.root.textContent).toContain("Another view");
});

test.each(["available", "unavailable", "unauthorized"] as const)("catalog %s settles behind an actual Rename editor without losing metadata ownership", async status => {
  let resolve!: (value: Awaited<ReturnType<MobileHubBackend["readCredentials"]>>) => void;
  const h = await harness(() => new Promise(r => { resolve = r; }));
  const region = h.root.querySelector("[data-workspace-assignments]")!;
  const commandCurrent = h.owner.env.current();
  h.root.querySelector<HTMLButtonElement>('[data-flow="rename"]')!.click();
  const editor = h.host.querySelector<HTMLElement>('[data-task-kind="editor"]')!;
  expect(editor).not.toBeNull(); expect(editor.getAttribute("role")).toBe("region");
  expect(h.root.hidden).toBe(true); expect(commandCurrent()).toBe(false);
  const name = editor.querySelector<HTMLInputElement>('[name="name"]')!; name.value = "Unsubmitted draft";
  resolve(status === "available" ? { status, value: catalog } : { status: "unavailable", problem: { kind: status, message: "Catalog unavailable" } });
  await settle();
  if (status === "unauthorized") {
    expect(h.lost()).toBe(1); expect(h.root.textContent).toBe(""); expect(h.host.textContent).toBe("");
  } else {
    expect(h.root.querySelector("[data-workspace-assignments]")).toBe(region);
    expect(region.textContent).toContain(status === "available" ? "Shared identity" : "Credential name unavailable");
    expect(h.host.querySelector('[data-task-kind="editor"]')).toBe(editor);
    expect(name.value).toBe("Unsubmitted draft"); expect(h.root.hidden).toBe(true);
    editor.querySelector<HTMLButtonElement>('[data-action="cancel-sheet"]')!.click();
    expect(h.root.hidden).toBe(false); expect(region.textContent).not.toContain("Loading credential name");
  }
  expect(h.reads()).toBe(1);
});

test.each(["changed-user", "retired-region"] as const)("catalog replies ignore %s ownership even with Rename open", async retired => {
  for (const unauthorized of [false, true]) {
    let resolve!: (value: Awaited<ReturnType<MobileHubBackend["readCredentials"]>>) => void;
    const h = await harness(() => new Promise(r => { resolve = r; }));
    const region = h.root.querySelector("[data-workspace-assignments]")!;
    h.root.querySelector<HTMLButtonElement>('[data-flow="rename"]')!.click();
    if (retired === "changed-user") h.changeUser();
    else h.owner.env.page("Replacement workspace", '<div data-workspace-assignments>Replacement metadata</div>');
    resolve(unauthorized ? { status: "unavailable", problem: { kind: "unauthorized", message: "Expired" } } : { status: "available", value: catalog });
    await settle();
    expect(h.lost()).toBe(0); expect(region.textContent).toContain("Loading credential name");
    expect(h.root.textContent).not.toContain("Shared identity");
    if (retired === "retired-region") expect(h.root.textContent).toContain("Replacement metadata");
    expect(h.reads()).toBe(1);
  }
});
