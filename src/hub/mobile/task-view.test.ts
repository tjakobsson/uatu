import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createTaskView } from "./task-view";
import { createFlowEnvironment } from "./flow-ui";
import type { MobileHubBackend, OperationResult } from "./backend";

describe("task presentation", () => {
  function setup() { const { window } = parseHTML('<html><body></body></html>'); const host = window.document.createElement("div"); window.document.body.append(host); return { window, host: host as unknown as HTMLElement }; }
  test("editors are pages with one header Cancel and Save, not drawers or modal dialogs", () => {
    const { host } = setup(); const view = createTaskView(host, () => true, () => {});
    const task = view.open("Edit", '<input type="password" value="secret"/>', { label: "Save", run() {} });
    expect(task.getAttribute("role")).toBe("region"); expect(task.hasAttribute("aria-modal")).toBe(false);
    expect(host.querySelector(".mh-backdrop, .mh-grabber")).toBeNull();
    expect(task.querySelectorAll('header [data-action="cancel-sheet"]')).toHaveLength(1);
    expect(task.querySelectorAll('[data-action="commit-sheet"]')).toHaveLength(1);
    const key = { key: "Tab", defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; view.key(key as unknown as KeyboardEvent); expect(key.defaultPrevented).toBe(false);
    const input = task.querySelector("input")!; view.close(); expect(input.value).toBe("");
  });
  test("confirmation is explicit; read-only results say Back", () => {
    const { host } = setup(); const view = createTaskView(host, () => true, () => {});
    expect(view.open("Delete?", "Result").querySelector('[data-action="cancel-sheet"]')?.textContent).toBe("Back");
    const task = view.open("Delete", "Consequences", { label: "Delete", run() {} }, { kind: "confirmation" });
    expect(task.getAttribute("role")).toBe("alertdialog"); expect(task.getAttribute("aria-modal")).toBe("true");
    expect(task.querySelector('[data-action="commit-sheet"]')?.classList.contains("mh-destructive")).toBe(true);
    view.busy(true); expect(task.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
    const start = view.open("Start", "Consequences", { label: "Start", run() {} }, { kind: "confirmation", destructive: false });
    expect(start.querySelector('[data-action="commit-sheet"]')?.classList.contains("mh-destructive")).toBe(false);
  });
  test("a mutation cannot replace a newer task on the same detail", async () => {
    const { host } = setup(); const page = host.ownerDocument.createElement("div"), tasks = host.ownerDocument.createElement("div"); host.append(page, tasks);
    const view = createTaskView(tasks, () => true, () => {});
    const { env } = createFlowEnvironment(page, {} as MobileHubBackend, {
      open: (title, body, primary, _cancel, presentation) => view.open(title, body, primary, presentation), close: view.close, busy: view.busy, error() {},
    }, { user: () => "user", home() {}, navigate() {}, changed() {}, authLost() {}, openWorkspace() {} });
    let resolve!: (value: OperationResult<string>) => void;
    const response = new Promise<OperationResult<string>>(done => { resolve = done; });
    const old = env.task("Old draft", '<input type="password" value="secret"/>');
    let successes = 0;
    const operation = env.mutate(() => response, () => { successes++; env.task("Wrong result", ""); }, old);
    const next = env.task("New draft", '<input value="retained"/>');
    resolve({ status: "completed", value: "ok" }); await operation;
    expect(successes).toBe(0); expect(next.isConnected).toBe(true); expect(old.querySelector("input")!.value).toBe("");
    expect(next.querySelector("input")!.value).toBe("retained");
  });
});
