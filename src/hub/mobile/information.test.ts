import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { infoRows } from "./information";
import { advisory, check, createFlowEnvironment, sharedUidKey } from "./flow-ui";
import { createTaskView } from "./task-view";
import type { MobileHubBackend } from "./backend";

test("facts are semantic, escaped and never controls", () => {
  const { document } = parseHTML(infoRows([{ label: "<Current>", value: "<secret>", detail: "Foot & note", mono: true, tone: "warning" }]));
  expect(document.querySelector("dt")?.textContent).toBe("<Current>");
  expect(document.querySelector("dd")?.textContent).toBe("<secret>Foot & note");
  expect(document.querySelectorAll("input,select,button").length).toBe(0);
  expect(document.querySelector(".mh-info-warning .mh-info-mono")).not.toBeNull();
});

test("switch markup preserves native checkbox draft and value semantics", () => {
  const { document } = parseHTML(check("consent", "Allow access", false, "allowed") + check("enabled", "Enabled", true));
  const input = document.querySelector("input")!;
  expect(input.getAttribute("role")).toBe("switch");
  expect(input.getAttribute("type")).toBe("checkbox");
  expect(input.getAttribute("value")).toBe("allowed");
  expect(input.hasAttribute("checked")).toBe(false);
  expect(document.querySelector('[name="enabled"]')?.hasAttribute("checked")).toBe(true);
});

test("inline named security notice dismisses in editors and stays dismissed per user", () => {
  const { document } = parseHTML("<html><body><main></main><aside></aside></body></html>");
  const root = document.querySelector("main")! as unknown as HTMLElement;
  const view = createTaskView(document.querySelector("aside")! as unknown as HTMLElement, () => true, () => {});
  const user = "information-test-editor";
  const { env } = createFlowEnvironment(root, {} as MobileHubBackend, { ...view, error() {}, open: (title, body, primary, _cancel, presentation) => view.open(title, body, primary, presentation) }, { user: () => user, home() {}, navigate() {}, changed() {}, authLost() {}, openWorkspace() {} });
  const task = env.task("Editor", advisory(user));
  expect(task.querySelector('aside[aria-label="Credential security"]')).not.toBeNull();
  expect(task.querySelectorAll('[data-flow="dismiss-advisory"]').length).toBe(1);
  task.querySelector<HTMLButtonElement>('[data-flow="dismiss-advisory"]')!.click();
  expect(task.querySelector("[data-shared-uid]")).toBeNull();
  expect(advisory(user)).toBe("");
  expect(advisory("another-information-test-user")).not.toBe("");
  expect(sharedUidKey("user")).toBe("uatu.hub.notice.shared-uid-v1:dXNlcg");
});
