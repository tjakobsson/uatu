import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { action, createFlowEnvironment, listRow, type SheetPort } from "./flow-ui";
import type { MobileHubBackend } from "./backend";

test("Settings page keeps contextual controls and top Back, preserving sole dispatch", () => {
  const { document } = parseHTML('<div class="mh-root"><div id="flow"></div></div>');
  const root = document.querySelector<HTMLElement>("#flow")!;
  let save = 0, back = 0;
  const { env } = createFlowEnvironment(root, {} as MobileHubBackend, {} as SheetPort, { user: () => "test", home: () => { throw new Error("Wrong Back"); }, navigate() {}, changed() {}, authLost() {}, openWorkspace() {} });
  env.page("Example", action("save", "Save") + action("other", "Other"), { save: () => save++, "flow-back": () => back++ }, { primaryAction: "save", secondaryAction: "absent", backLabel: "Back to edit" });
  expect(root.querySelectorAll('[data-flow="save"]').length).toBe(1);
  expect(root.querySelectorAll('[data-flow="flow-back"]').length).toBe(1);
  expect(root.querySelector('[data-flow="absent"]')).toBeNull();
  expect(root.querySelector('.mh-flow-toolbar')).toBeNull();
  expect(root.querySelector('.mh-flow-header [data-flow="flow-back"]')?.textContent).toContain("Back to edit");
  root.querySelector<HTMLButtonElement>('.mh-flow-content [data-flow="save"]')!.click();
  root.querySelector<HTMLButtonElement>('[data-flow="flow-back"]')!.click();
  expect([save, back]).toEqual([1, 1]);
  env.page("Frequent workspace action", action("open", "Open"), {}, { primaryAction: "open", actionPlacement: "frequent" });
  expect(root.querySelectorAll('[data-flow="open"]').length).toBe(1);
  expect(root.querySelector('.mh-flow-toolbar [data-flow="open"]')).not.toBeNull();
  expect(root.querySelector('.mh-flow-toolbar [data-flow="flow-back"]')).toBeNull();
  const name = "Long workspace name ".repeat(12);
  env.page(name, "", {}, { icon: "folder" });
  expect(root.classList.contains("mh-object-detail")).toBe(true);
  expect(root.querySelector("h1")?.textContent).toBe(name);
  env.page("Settings", ""); expect(root.classList.contains("mh-object-detail")).toBe(false);
});

test("list row is one named hierarchy button and a separate accessible More", () => {
  const { document } = parseHTML(listRow("folder", "A <folder>", "Git repository", "folder", { key: "more", label: "Actions for A <folder>" }));
  expect(document.querySelectorAll("button").length).toBe(2);
  expect(document.querySelector("button button")).toBeNull();
  expect(document.querySelector(".mh-list-primary")?.getAttribute("aria-label")).toBe("A <folder>, Git repository");
  expect(document.querySelector(".mh-list-more")?.getAttribute("aria-label")).toBe("Actions for A <folder>");
});

test("explicit page actions dispatch once; review can rename its sole cancel", () => {
  const { document } = parseHTML('<div><div id="flow"></div><div id="sheet"></div></div>');
  const root = document.querySelector<HTMLElement>("#flow")!, sheetRoot = document.querySelector<HTMLElement>("#sheet")!;
  let ran = 0;
  const sheet: SheetPort = { open(_title, body) { sheetRoot.innerHTML = `${body}<header><button data-action="cancel-sheet">Back</button></header>`; return sheetRoot; }, close() {}, busy() {}, error() {} };
  const { env } = createFlowEnvironment(root, {} as MobileHubBackend, sheet, { user: () => "test", home() {}, navigate() {}, changed() {}, authLost() {}, openWorkspace() {} });
  env.page("Folder", action("rename", "Rename"), { rename: () => { ran++; } });
  root.querySelector<HTMLButtonElement>('[data-flow="rename"]')!.click(); expect(ran).toBe(1);
  env.task("Review", "", undefined, {}, undefined, { cancelLabel: "Back to edit" });
  expect(sheetRoot.querySelectorAll("button").length).toBe(1);
  expect(sheetRoot.textContent).toBe("Back to edit");
});
