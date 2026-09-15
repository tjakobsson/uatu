import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { ShellOutputController, type ShellOutputMetadata } from "./shell-output";
import { clampShellWindow, currentFloatingShellOutput, shellOutputWindow, ShellOutputWindow } from "./shell-output-window";
import { renderSelectedConversationDeleted } from "./inventory-presentation";

let dom: ReturnType<typeof parseHTML>;
let restore: (() => void)[] = [];
let window: ShellOutputWindow;
let touch = false;
const area = { x: 40, y: 10, width: 1200, height: 800 };
const data: ShellOutputMetadata = { command: "bun test", conversation: "Child review", status: "running" };
beforeEach(() => {
  dom = parseHTML("<!doctype html><html><body><main><div id='row'></div><button>Composer</button></main><nav>Tabs</nav></body></html>");
  for (const [key, value] of Object.entries({ document: dom.document, window: dom.window })) {
    const old = Reflect.get(globalThis, key); Reflect.set(globalThis, key, value); restore.push(() => Reflect.set(globalThis, key, old));
  }
  touch = false;
  window = new ShellOutputWindow({ workArea: () => area, touch: () => touch, coveredRoots: () => [dom.document.querySelector("main") as unknown as HTMLElement] });
});
afterEach(() => { window.close(false); restore.forEach(fn => fn()); restore = []; });
function shell(id: string): ShellOutputController {
  const shell = new ShellOutputController("child", id, data);
  shell.attach(dom.document.querySelector("#row") as unknown as HTMLElement);
  shell.update("first\nlast", data);
  return shell;
}

test("bounds fit tiny work areas before preferred minimums", () => {
  expect(clampShellWindow({ x: -10, y: 10000, width: 5000, height: 1 }, { x: 10, y: 20, width: 150, height: 100 })).toEqual({ x: 10, y: 20, width: 150, height: 100 });
});

test("one body-mounted host moves the same output, retains A/B geometry, and restores inline", () => {
  const a = shell("a"), b = shell("b"); const viewport = a.viewport;
  window.open(a);
  expect(window.element!.parentElement).toBe(dom.document.body);
  expect(window.element!.contains(viewport)).toBe(true);
  expect(a.slot.querySelector(".chat-shell-viewport")).toBeNull();
  for (const node of [a.command, a.popout, a.resize]) expect(node.hidden).toBe(true);
  window.setGeometry({ x: 80, y: 60, width: 1000, height: 600 });
  const boundsA = { ...a.floatingGeometry! };
  window.open(b); expect(a.slot.contains(viewport)).toBe(true);
  for (const node of [a.command, a.popout, a.resize]) expect(node.hidden).toBe(false);
  for (const node of [b.command, b.popout, b.resize]) expect(node.hidden).toBe(true);
  window.setGeometry({ x: 120, y: 90, width: 500, height: 300 });
  window.close(false); window.open(a);
  expect(a.floatingGeometry).toEqual(boundsA);
  expect(window.element!.style.width).toBe("1000px");
  expect(b.floatingGeometry!.width).toBe(500);
  window.close(false); expect(a.slot.contains(viewport)).toBe(true);
  expect(dom.document.querySelector(".chat-shell-window")).toBeNull();
  a.dispose(); b.dispose();
});

test("maximize and touch leave desktop geometry intact; covered roots inert, moved output active", () => {
  const a = shell("a"); window.open(a);
  const saved = { ...a.floatingGeometry! };
  const main = dom.document.querySelector("main") as unknown as HTMLElement;
  window.toggleMaximize();
  expect(main.hasAttribute("inert")).toBe(true); expect(main.contains(a.viewport)).toBe(false);
  expect(window.element!.contains(a.viewport)).toBe(true);
  expect(window.element!.style.width).toBe("1200px");
  expect(a.floatingGeometry).toEqual(saved);
  window.toggleMaximize(); expect(main.hasAttribute("inert")).toBe(false);
  expect(window.element!.style.width).toBe(`${saved.width}px`);
  touch = true; window.layout(); expect(main.hasAttribute("inert")).toBe(true);
  touch = false; window.layout(); expect(main.hasAttribute("inert")).toBe(false); expect(a.floatingGeometry).toEqual(saved);
  window.toggleMaximize(); window.close(false); expect(main.hasAttribute("inert")).toBe(false);
  a.dispose();
});

for (const deletedBeforeOpen of [false, true]) test(`default covered composer composes inventory deletion, deleted before open: ${deletedBeforeOpen}`, () => {
  const composer = dom.document.createElement("form") as unknown as HTMLElement;
  composer.id = "chat-composer";
  dom.document.querySelector("main")!.append(composer);
  // Only the composer fits completely in the work area, as can happen when
  // accessible chrome forces the default root walk down into Chat.
  composer.getBoundingClientRect = () => ({ ...area, left: area.x, top: area.y,
    right: area.x + area.width, bottom: area.y + area.height, toJSON() {} });
  window.configure({ workArea: () => area, touch: () => false });
  const root = dom.document as unknown as Document;
  renderSelectedConversationDeleted(root, deletedBeforeOpen);
  const a = shell("a"); window.open(a); window.toggleMaximize();
  renderSelectedConversationDeleted(root, false);
  expect(composer.hasAttribute("inert")).toBe(true);
  window.layout();
  expect(composer.hasAttribute("inert")).toBe(true);
  renderSelectedConversationDeleted(root, true);
  window.close(false);
  expect(composer.hasAttribute("inert")).toBe(true);
  expect(composer.getAttribute("aria-disabled")).toBe("true");
  renderSelectedConversationDeleted(root, false);
  expect(composer.hasAttribute("inert")).toBe(false);
  a.dispose();
});

test("closing preserves inertness that predates both owners", () => {
  const main = dom.document.querySelector("main")!;
  main.setAttribute("inert", "");
  const a = shell("a"); window.open(a); window.toggleMaximize(); window.close(false);
  expect(main.hasAttribute("inert")).toBe(true);
  a.dispose();
});

for (const configured of [false, true]) test(`covered prompt navigation is inert while persistent tabs remain available, configured roots: ${configured}`, () => {
  const promptRail = dom.document.createElement("nav") as unknown as HTMLElement;
  promptRail.id = "chat-prompt-rail";
  promptRail.innerHTML = "<button>First prompt</button><button>Second prompt</button>";
  const tabs = dom.document.createElement("nav") as unknown as HTMLElement;
  tabs.id = "touch-tab-bar";
  tabs.innerHTML = "<button>Files</button><button>Chat</button>";
  dom.document.body.append(promptRail, tabs);
  for (const node of [promptRail, tabs]) node.getBoundingClientRect = () => ({ ...area, left: area.x, top: area.y,
    right: area.x + area.width, bottom: area.y + area.height, toJSON() {} });
  window.configure({ workArea: () => area, touch: () => touch,
    ...(configured ? { coveredRoots: () => [promptRail, tabs] } : {}) });
  const a = shell("a"); window.open(a); window.toggleMaximize();
  expect(promptRail.hasAttribute("inert")).toBe(true);
  expect(tabs.hasAttribute("inert")).toBe(false);
  window.toggleMaximize(); expect(promptRail.hasAttribute("inert")).toBe(false);
  touch = true; window.layout(); expect(promptRail.hasAttribute("inert")).toBe(true);
  expect(tabs.hasAttribute("inert")).toBe(false);
  window.close(false); expect(promptRail.hasAttribute("inert")).toBe(false);
  a.dispose();
});

test("covered Preview find is inert until moved into the active full-area window", () => {
  const find = dom.document.createElement("div") as unknown as HTMLElement;
  find.id = "find-bar";
  find.innerHTML = '<input aria-label="Find in document"><button>Next</button>';
  dom.document.querySelector("main")!.append(find);
  find.getBoundingClientRect = () => ({ ...area, left: area.x, top: area.y,
    right: area.x + area.width, bottom: area.y + area.height, toJSON() {} });
  window.configure({ workArea: () => area, touch: () => touch });
  const a = shell("a"); window.open(a); window.toggleMaximize();
  expect(find.hasAttribute("inert")).toBe(true);
  window.toggleMaximize(); expect(find.hasAttribute("inert")).toBe(false);
  // The inactive Preview tab is display:none in touch mode.
  find.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0,
    left: 0, top: 0, right: 0, bottom: 0, toJSON() {} });
  touch = true; window.layout(); expect(find.hasAttribute("inert")).toBe(true);
  window.element!.append(find); window.layout();
  expect(find.hasAttribute("inert")).toBe(false);
  window.close(false); a.dispose();
});

test("provider outcomes stay on selected item, time is supplied only, hidden ownership returns latest", () => {
  const a = shell("a"), b = shell("b"); window.open(a);
  expect(window.element!.textContent).toContain("Child review · Running");
  // Losing the connection or updating unrelated work provides no outcome.
  window.refresh(a); expect(window.element!.dataset.status).toBe("running");
  a.update("completed", { ...data, status: "completed" }); window.refresh(a);
  expect(window.owner).toBe(a);
  expect(window.element!.querySelector(".chat-shell-window-metadata")!.textContent).toBe("Child review · Completed");
  a.update("first\nlast\nfinished", { ...data, status: "failed" }); window.refresh(a);
  expect(window.owner).toBe(a); expect(window.element!.textContent).toContain("Child review · Failed");
  b.update("next command", { ...data, command: "next", status: "running" }); window.refresh(b);
  expect(window.owner).toBe(a); expect(window.element!.textContent).not.toContain("next command");
  window.setOwnerHidden(a, true); expect(window.element!.hidden).toBe(true); expect(window.viewport).toBeNull();
  a.update("finished while hidden", { ...data, status: "cancelled", completedAt: 1000 });
  window.setOwnerHidden(a, false);
  expect(window.element!.textContent).toContain("Child review · Cancelled");
  expect(window.element!.textContent).toContain(new Date(1000).toLocaleString());
  expect(window.owner).toBe(a);
  window.close(false); a.dispose(); b.dispose();
});

test("completed-only output gets its own outcome without a fabricated timestamp", () => {
  const a = shell("a");
  a.update("finished before render", { ...data, status: "completed", exitCode: 0 });
  window.open(a);
  expect(window.element!.querySelector(".chat-shell-window-metadata")!.textContent).toBe("Child review · Completed · exit 0");
  expect(window.viewport!.textContent).toContain("finished before render");
  window.close(false); a.dispose();
});

test("Escape returns directly from maximize and does not bubble into child navigation", () => {
  const a = shell("a"); window.open(a); window.toggleMaximize();
  let navigated = false;
  const listener = () => { navigated = true; };
  dom.document.body.addEventListener("keydown", listener);
  const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true }); Object.assign(event, { key: "Escape" });
  window.element!.querySelector("button")!.dispatchEvent(event);
  expect(window.owner).toBeNull(); expect(navigated).toBe(false); expect(event.defaultPrevented).toBe(true);
  expect(a.slot.contains(a.viewport)).toBe(true);
  dom.document.body.removeEventListener("keydown", listener); a.dispose();
});

test("keyboard move and two-axis resize expose resulting values and bounds", () => {
  const a = shell("a"); window.open(a);
  const previous = { ...a.floatingGeometry! };
  for (const [selector, key] of [[".chat-shell-window-move", "ArrowRight"], [".chat-shell-window-resize", "ArrowRight"], [".chat-shell-window-resize", "ArrowDown"]]) {
    const event = new dom.window.Event("keydown", { cancelable: true }); Object.assign(event, { key });
    window.element!.querySelector(selector!)!.dispatchEvent(event);
  }
  expect(a.floatingGeometry!.x).toBe(previous.x + 10);
  expect(a.floatingGeometry!.width).toBe(previous.width + 10);
  expect(a.floatingGeometry!.height).toBe(previous.height + 10);
  expect(window.element!.querySelector(".chat-shell-window-resize")!.getAttribute("aria-label")).toContain(`Width ${previous.width + 10}`);
  expect(a.inlineHeight).toBe(240);
  window.close(false); a.dispose();
});

test("explicit owner navigation retains geometry, disposal releases app-level ownership and pointer capture", () => {
  const appWindow = shellOutputWindow(); appWindow.configure({ workArea: () => area, touch: () => false });
  const a = shell("a");
  a.popout.click();
  expect(currentFloatingShellOutput()?.owner).toBe(a);
  appWindow.setGeometry({ x: 80, y: 60, width: 900, height: 500 });
  a.returnInline(); expect(currentFloatingShellOutput()).toBeNull();
  expect(a.floatingGeometry!.width).toBe(900);
  a.popout.click();
  const control = appWindow.element!.querySelector<HTMLElement>(".chat-shell-window-move")!;
  let captured = false;
  control.setPointerCapture = () => { captured = true; };
  control.hasPointerCapture = () => captured;
  control.releasePointerCapture = () => { captured = false; };
  const event = new dom.window.Event("pointerdown", { cancelable: true });
  Object.assign(event, { button: 0, pointerId: 1, clientX: 100, clientY: 80 });
  control.dispatchEvent(event); expect(captured).toBe(true);
  a.dispose(); expect(captured).toBe(false);
  expect(currentFloatingShellOutput()).toBeNull();
  expect(dom.document.querySelector(".chat-shell-window")).toBeNull();
  appWindow.configure({});
});
