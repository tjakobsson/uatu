import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { ShellOutputController, ShellScrollOwner, type ShellOutputMetadata } from "./shell-output";
import { CoordinatedScrollOwner } from "./coordinated-scroll";
import { TimelineAnchorController } from "./anchor";
import { shellOutputWindow } from "./shell-output-window";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const frames = new Map<number, FrameRequestCallback>();
let id = 0;
let timestamp = 0;
let restore: (() => void)[] = [];
beforeEach(() => {
  for (const [key, value] of Object.entries({ document: dom.document, requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++id, fn); return id; }, cancelAnimationFrame: (id: number) => frames.delete(id) })) {
    const old = Reflect.get(globalThis, key); Reflect.set(globalThis, key, value);
    restore.push(() => Reflect.set(globalThis, key, old));
  }
});
afterEach(() => { frames.clear(); restore.forEach(fn => fn()); restore = []; });
function frame(): void { const work = [...frames.values()]; frames.clear(); timestamp += 16; work.forEach(fn => fn(timestamp)); }
function view(): HTMLElement {
  const element = dom.document.createElement("pre") as unknown as HTMLElement;
  Object.assign(element, { scrollTop: 0, scrollLeft: 0, scrollHeight: 2000, clientHeight: 240, scrollWidth: 1800, clientWidth: 500 });
  return element;
}
const metadata: ShellOutputMetadata = { command: "bun test", conversation: "Test conversation", status: "running" };

describe("shell scroll owner", () => {
  test("one frame correction initializes completed output at bottom and coalesces appends", () => {
    const viewport = view(); const owner = new ShellScrollOwner(viewport);
    let writes = 0, top = 0;
    Object.defineProperty(viewport, "scrollTop", { get: () => top, set: value => { writes++; top = value; }, configurable: true });
    owner.updated(); owner.request(); owner.updated();
    expect(frames.size).toBe(1); frame();
    expect(writes).toBe(1); expect(top).toBe(1760);
    owner.observe(); expect(owner.following).toBe(true);
    owner.dispose();
  });

  test("small upward input cancels pending latest; appends and echoes preserve both axes", () => {
    const viewport = view(); const owner = new ShellScrollOwner(viewport);
    owner.latest(); frame();
    viewport.scrollLeft = 70; owner.observe();
    owner.updated(); owner.readerInput("up");
    expect(frames.size).toBe(0);
    viewport.scrollTop = 1756; owner.observe();
    expect(owner.following).toBe(false);
    Object.assign(viewport, { scrollHeight: 2500 });
    owner.updated(); owner.request(); frame(); owner.observe();
    expect(viewport.scrollTop).toBe(1756); expect(viewport.scrollLeft).toBe(70);
    expect(owner.unseen).toBe(true); expect(owner.following).toBe(false);
    owner.latest(); frame(); owner.observe();
    expect(viewport.scrollTop).toBe(2260); expect(owner.following).toBe(true);
    expect(owner.unseen).toBe(false); expect(viewport.scrollLeft).toBe(70);
    owner.dispose();
  });

  test("layout and authoritative shrink clamps never resume paused follow", () => {
    const viewport = view(); const owner = new ShellScrollOwner(viewport);
    owner.latest(); frame();
    owner.readerInput("up"); viewport.scrollTop = 1700; owner.observe();
    Object.assign(viewport, { scrollHeight: 200, scrollTop: 0 }); owner.observe();
    owner.request(); frame(); owner.observe();
    expect(owner.following).toBe(false);
    Object.assign(viewport, { scrollHeight: 2500 }); owner.request(); frame();
    expect(viewport.scrollTop).toBe(1700);
    owner.readerInput("down"); viewport.scrollTop = 2260; owner.observe();
    expect(owner.following).toBe(true);
    owner.dispose();
  });

  for (const input of ["wheel", "touch", "keyboard"]) {
    test(`nested shell ${input} input pauses only its registered owner`, () => {
      const parent = view(), viewport = view(); parent.append(viewport);
      const parentAnchor = new TimelineAnchorController();
      const outer = new CoordinatedScrollOwner(parent, {
        anchor: parentAnchor,
        measure: () => ({ scrollTop: parent.scrollTop, scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight, items: [] }),
      });
      const owner = new ShellScrollOwner(viewport);
      outer.latest(); owner.latest(); frame();
      owner.updated(); outer.request(true);
      const fire = (type: string, properties: Record<string, unknown>) => {
        const event = new dom.window.Event(type, { bubbles: true }); Object.assign(event, properties); viewport.dispatchEvent(event);
      };
      if (input === "wheel") fire("wheel", { deltaY: -4 });
      else if (input === "keyboard") fire("keydown", { key: "ArrowUp" });
      else { fire("touchstart", { touches: [{ clientY: 100 }] }); fire("touchmove", { touches: [{ clientY: 104 }] }); }
      expect(owner.following).toBe(false); expect(parentAnchor.isPinned()).toBe(true);
      expect(frames.size).toBe(1); // Only the outer correction remains pending.
      viewport.scrollTop -= 4; owner.observe(); frame();
      expect(viewport.scrollTop).toBe(1756); expect(parent.scrollTop).toBe(1760);
      owner.dispose(); outer.dispose();
      // Disposal releases the WeakMap registration as well as event ownership.
      const replacement = new ShellScrollOwner(viewport); replacement.dispose();
    });
  }

  test("one listener set and one writer handle replacement and delayed clamp echoes", () => {
    const viewport = view();
    const counts = new Map<string, number>();
    const add = viewport.addEventListener.bind(viewport);
    viewport.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
      counts.set(type, (counts.get(type) ?? 0) + 1); add(type, listener, options);
    }) as typeof viewport.addEventListener;
    const owner = new ShellScrollOwner(viewport);
    for (const type of ["scroll", "wheel", "touchstart", "touchmove", "keydown"]) expect(counts.get(type)).toBe(1);
    expect(counts.has("pointerdown")).toBe(false);
    owner.latest(); frame(); owner.readerInput("up"); viewport.scrollTop = 217; owner.observe();
    owner.replaced(1); owner.updated(); frame(); owner.observe(); owner.observe();
    expect(owner.readingTop).toBe(237); expect(owner.following).toBe(false);
    Object.assign(viewport, { scrollHeight: 200, scrollTop: 0 }); owner.observe(); frame(); owner.observe(); owner.observe();
    expect(owner.readingTop).toBe(237); expect(owner.following).toBe(false);
    Object.assign(viewport, { scrollHeight: 2000 }); owner.request(); frame();
    expect(viewport.scrollTop).toBe(237);
    owner.dispose();
  });

  test("horizontal native clamps and echoes preserve the offset, but deliberate return to zero does not", () => {
    const viewport = view(); const owner = new ShellScrollOwner(viewport);
    owner.latest(); frame(); owner.readerInput("up"); viewport.scrollTop = 200; owner.observe();
    viewport.scrollLeft = 90; owner.observe();
    // Browser clamps before the coordinated layout correction sees the width.
    Object.assign(viewport, { clientWidth: 1800, scrollLeft: 0 }); owner.observe();
    owner.capture(); owner.request(); frame(); owner.observe();
    Object.assign(viewport, { clientWidth: 500 }); owner.observe(); owner.request(); frame();
    expect(viewport.scrollLeft).toBe(90); expect(owner.following).toBe(false);
    viewport.scrollLeft = 0; owner.observe(); owner.request(); frame();
    expect(viewport.scrollLeft).toBe(0);
    owner.dispose();
  });

  test("replacement that removes the anchored line clamps once without following later growth", () => {
    const viewport = view(); const owner = new ShellScrollOwner(viewport);
    owner.latest(); frame(); owner.readerInput("up"); viewport.scrollTop = 500; owner.observe();
    owner.replaced(undefined);
    Object.assign(viewport, { scrollHeight: 200, scrollTop: 0 }); owner.updated(); frame(); owner.observe();
    expect(owner.readingTop).toBe(0); expect(owner.following).toBe(false);
    Object.assign(viewport, { scrollHeight: 2500 }); owner.updated(); frame();
    expect(viewport.scrollTop).toBe(0); expect(owner.unseen).toBe(true);
    owner.dispose();
  });
});

test("incremental lines preserve completed text nodes and process only the appended suffix", () => {
  const shell = new ShellOutputController("c1", "a", metadata);
  const output = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  shell.update(output, metadata);
  const first = shell.lines.firstElementChild!;
  const text = first.firstChild;
  const work = shell.buffer.stats.inputCodeUnits;
  shell.update(`${output}\nnext`, metadata);
  expect(shell.lines.firstElementChild).toBe(first); expect(first.firstChild).toBe(text);
  expect(shell.lines.children.length).toBe(2001);
  expect(shell.buffer.stats.inputCodeUnits - work).toBe(5);
  expect(shell.viewport.textContent).toContain("line 0\n");
  expect(shell.element.querySelector(".chat-output-more")).toBeNull();
  shell.update("line 0\ncorrected", { ...metadata, status: "failed" }, "\x1b[31merror<script>x</script>\x1b[0m");
  expect(shell.lines.firstElementChild).toBe(first); expect(first.firstChild).toBe(text);
  expect(shell.lines.children.length).toBe(2);
  expect(shell.error.querySelector("script")).toBeNull(); expect(shell.error.hidden).toBe(false);
  expect(shell.error.textContent).toBe("error<script>x</script>");
  shell.dispose();
});

test("hidden controllers defer parsing, DOM and error painting until restored", () => {
  const shell = new ShellOutputController("c1", "a", metadata);
  shell.update("before", metadata); shell.setHidden(true);
  const work = shell.buffer.stats.inputCodeUnits;
  shell.update("before\nafter", { ...metadata, status: "completed" }, "failure");
  expect(shell.viewport.textContent).not.toContain("after");
  expect(shell.error.hidden).toBe(true); expect(shell.buffer.stats.inputCodeUnits).toBe(work);
  shell.setHidden(false);
  expect(shell.viewport.textContent).toContain("after"); expect(shell.error.textContent).toBe("failure");
  expect(shell.element.dataset.status).toBe("completed");
  shell.dispose(); expect(frames.size).toBe(0);
});

test("hidden shells suspend shared input ownership and ignore delayed scroll observations", () => {
  const shell = new ShellOutputController("c1", "a", metadata);
  Object.assign(shell.viewport, { scrollTop: 0, scrollLeft: 0, scrollHeight: 2000, clientHeight: 240, scrollWidth: 1000, clientWidth: 500 });
  shell.update("before", metadata); frame();
  shell.setHidden(true);
  const event = new dom.window.Event("wheel"); Object.assign(event, { deltaY: -4 }); shell.viewport.dispatchEvent(event);
  shell.viewport.scrollTop = 0; shell.scroll.observe();
  expect(shell.scroll.following).toBe(true); expect(frames.size).toBe(0);
  shell.setHidden(false); frame();
  expect(shell.viewport.scrollTop).toBe(1760); expect(shell.scroll.following).toBe(true);
  shell.dispose();
});

test("authoritative insertion preserves the visible rendered line and its pixel offset", () => {
  const shell = new ShellOutputController("c1", "a", metadata);
  Object.assign(shell.viewport, { scrollTop: 0, scrollLeft: 0, scrollHeight: 2000, clientHeight: 240, scrollWidth: 1000, clientWidth: 500 });
  const output = Array.from({ length: 100 }, (_, index) => `unique line ${index}`).join("\n");
  shell.update(output, metadata); frame();
  shell.scroll.readerInput("up"); shell.viewport.scrollTop = 217; shell.scroll.observe();
  shell.update(`inserted\n${output}`, metadata); frame();
  expect(shell.viewport.scrollTop).toBe(237);
  expect(shell.scroll.following).toBe(false);
  shell.dispose();
});

test("presentation snapshots restore line anchors against current output without retaining old DOM", () => {
  const first = new ShellOutputController("c1", "a", metadata);
  Object.assign(first.viewport, { scrollTop: 0, scrollLeft: 0, scrollHeight: 2000, clientHeight: 240, scrollWidth: 1000, clientWidth: 500 });
  const output = Array.from({ length: 100 }, (_, index) => `retained ${index}`).join("\n");
  first.update(output, metadata); frame();
  first.scroll.readerInput("up"); first.viewport.scrollTop = 217; first.viewport.scrollLeft = 60; first.scroll.observe();
  first.setInlineHeight(360); first.floatingGeometry = { x: 50, y: 20, width: 800, height: 500 };
  const state = first.presentation(); first.dispose();
  const restored = new ShellOutputController("c1", "a", metadata);
  Object.assign(restored.viewport, { scrollTop: 0, scrollLeft: 0, scrollHeight: 2020, clientHeight: 240, scrollWidth: 1000, clientWidth: 500 });
  restored.restorePresentation(state); restored.update(`new prefix\n${output}`, { ...metadata, status: "completed" }); frame();
  expect(restored.viewport).not.toBe(first.viewport);
  expect(restored.viewport.scrollTop).toBe(237); expect(restored.viewport.scrollLeft).toBe(60);
  expect(restored.scroll.following).toBe(false); expect(restored.inlineHeight).toBe(360); expect(restored.readerOpened).toBe(true);
  expect(restored.floatingGeometry).toEqual(state.floatingGeometry);
  expect(restored.floatingGeometry).not.toBe(state.floatingGeometry);
  restored.dispose();
});

test("inline find reveals through the coordinated owner and consumes its reveal event", () => {
  const shell = new ShellOutputController("c1", "a", metadata);
  Object.assign(shell.viewport, { scrollTop: 100, scrollLeft: 30, scrollHeight: 2000, clientHeight: 240, scrollWidth: 1000, clientWidth: 500 });
  shell.update("needle", metadata);
  shell.viewport.getBoundingClientRect = () => ({ top: 50, left: 20 }) as DOMRect;
  const node = shell.lines.firstElementChild!.firstChild!;
  const range = { startContainer: node, endContainer: node, getBoundingClientRect: () => ({ top: 160, left: 100 }) };
  const event = new dom.window.CustomEvent("chat-shell-reveal", { detail: { range }, bubbles: true, cancelable: true });
  shell.viewport.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true); frame();
  expect(shell.viewport.scrollTop).toBe(200); expect(shell.viewport.scrollLeft).toBe(100);
  expect(shell.scroll.following).toBe(false); expect(shell.readerOpened).toBe(true); shell.dispose();
});

for (const unseen of [false, true]) for (const changed of [false, true]) test(`paused completed restoration retains unseen=${unseen}, changed=${changed}`, () => {
  const completed = { ...metadata, status: "completed" as const };
  const first = new ShellOutputController("c1", "a", completed);
  first.update("before", completed);
  first.scroll.following = false; first.scroll.unseen = unseen;
  const state = first.presentation(); first.dispose();
  const restored = new ShellOutputController("c1", "a", completed);
  restored.restorePresentation(state);
  restored.update(changed ? "after" : "before", completed); frame();
  expect(restored.scroll.unseen).toBe(unseen || changed);
  expect(restored.scroll.following).toBe(false);
  expect(restored.readerOpened).toBe(false);
  expect(restored.latest.textContent).toBe(unseen || changed ? "New output · Latest output" : "Latest output");
  restored.update(`${changed ? "after" : "before"}\nappend`, completed); frame();
  expect(restored.scroll.unseen).toBe(true);
  restored.dispose();
});

test("hidden unpainted output remains new through presentation reconstruction", () => {
  const first = new ShellOutputController("c1", "a", metadata);
  first.update("before", metadata); frame(); first.scroll.following = false;
  first.setHidden(true); first.update("before\nafter", metadata);
  const state = first.presentation(); first.dispose();
  const restored = new ShellOutputController("c1", "a", metadata);
  restored.restorePresentation(state); restored.update("before\nafter", metadata); frame();
  expect(restored.scroll.unseen).toBe(true); restored.dispose();
});

test("layout clamps, correction echoes and hidden keyboard input do not inspect output", () => {
  const shell = new ShellOutputController("c1", "a", metadata);
  Object.assign(shell.viewport, { scrollTop: 0, scrollLeft: 0, scrollHeight: 2000, clientHeight: 240 });
  shell.update("output", metadata); frame(); shell.scroll.observe();
  Object.assign(shell.viewport, { scrollHeight: 200, scrollTop: 0 }); shell.scroll.observe(); frame(); shell.scroll.observe();
  expect(shell.readerOpened).toBe(false);
  shell.setHidden(true);
  for (const key of ["Home", "PageUp", "ArrowUp"]) {
    const event = new dom.window.Event("keydown"); Object.assign(event, { key }); shell.viewport.dispatchEvent(event);
  }
  shell.setHidden(false); frame();
  expect(shell.readerOpened).toBe(false); expect(shell.scroll.unseen).toBe(false); shell.dispose();
});

test("Home then PageDown before a frame uses the requested shell anchor rather than native page scrolling", () => {
  const shell = new ShellOutputController("c1", "a", metadata);
  Object.assign(shell.viewport, { scrollTop: 0, scrollLeft: 0, scrollHeight: 2000, clientHeight: 240, scrollWidth: 500, clientWidth: 500 });
  shell.update("output", metadata); frame();
  for (const key of ["Home", "PageDown"]) {
    const event = new dom.window.Event("keydown", { cancelable: true }); Object.assign(event, { key });
    shell.viewport.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  }
  frame(); expect(shell.viewport.scrollTop).toBe(220); expect(shell.scroll.following).toBe(false);
  shell.dispose();
});

for (const key of ["Home", "PageUp"]) for (const hidden of [false, true]) test(`${key} explicit positioning${hidden ? " and hide/restore" : ""} permits first downward wheel arrival to resume following`, () => {
  const shell = new ShellOutputController("c1", "a", metadata);
  Object.assign(shell.viewport, { scrollTop: 0, scrollLeft: 0, scrollHeight: 2000, clientHeight: 240, scrollWidth: 500, clientWidth: 500 });
  shell.update("output", metadata); frame();
  const event = new dom.window.Event("keydown", { cancelable: true }); Object.assign(event, { key }); shell.viewport.dispatchEvent(event);
  frame(); shell.scroll.observe();
  if (hidden) { shell.setHidden(true); shell.setHidden(false); frame(); shell.scroll.observe(); }
  expect(shell.scroll.following).toBe(false);
  const wheel = new dom.window.Event("wheel"); Object.assign(wheel, { deltaY: 2000 }); shell.viewport.dispatchEvent(wheel);
  shell.viewport.scrollTop = 1760; shell.scroll.observe();
  expect(shell.scroll.following).toBe(true);
  Object.assign(shell.viewport, { scrollHeight: 2200 }); shell.update("output\nappend", metadata); frame();
  expect(shell.viewport.scrollTop).toBe(1960); shell.dispose();
});

test("streaming and unchanged refreshes preserve command selection nodes and avoid metadata mutations", async () => {
  const window = shellOutputWindow(), originalRefresh = window.refresh;
  const notifications: string[] = [];
  window.refresh = owner => { notifications.push(`${owner.metadata.conversation}:${owner.metadata.status}`); originalRefresh.call(window, owner); };
  restore.push(() => { window.refresh = originalRefresh; });
  const shell = new ShellOutputController("c1", "a", metadata);
  const described = { ...metadata, description: "Selected command description" };
  shell.update("output", described);
  notifications.length = 0;
  const commandText = shell.command.firstChild, descriptionText = shell.description.firstChild;
  const records: MutationRecord[] = [];
  const observer = new dom.window.MutationObserver(changes => records.push(...changes as unknown as MutationRecord[]));
  observer.observe(shell.command, { subtree: true, childList: true, characterData: true });
  observer.observe(shell.description, { subtree: true, attributes: true, childList: true, characterData: true });
  observer.observe(shell.element, { attributes: true });
  shell.update("output\nappend", { ...described }); shell.update("output\nappend", { ...described });
  await Promise.resolve();
  expect(records).toHaveLength(0);
  expect(notifications).toHaveLength(0);
  expect(shell.command.firstChild).toBe(commandText!); expect(shell.description.firstChild).toBe(descriptionText!);
  shell.update("output\nappend", { ...described, conversation: "Renamed" });
  expect(notifications).toEqual(["Renamed:running"]);
  shell.update("output\nappend", { ...described, conversation: "Renamed", status: "completed" });
  expect(notifications).toEqual(["Renamed:running", "Renamed:completed"]);
  await Promise.resolve();
  expect(records).toHaveLength(1); expect(records[0]!.attributeName).toBe("data-status");
  expect(shell.command.firstChild).toBe(commandText!); expect(shell.description.firstChild).toBe(descriptionText!);
  observer.disconnect(); shell.dispose();
});

test("inline keyboard sizing is bounded, reader-owned and brackets each mutation", () => {
  const calls: string[] = [];
  const shell = new ShellOutputController("c1", "a", metadata, { beforeMutation: () => calls.push("before"), afterMutation: () => calls.push("after") });
  const event = new dom.window.Event("keydown", { cancelable: true }); Object.assign(event, { key: "ArrowDown" });
  shell.resize.dispatchEvent(event);
  expect(shell.inlineHeight).toBe(260); expect(shell.readerOpened).toBe(true);
  expect(calls).toEqual(["before", "after", "before", "after"]);
  shell.setInlineHeight(10000);
  expect(Number(shell.resize.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(shell.heightBounds().max);
  expect(shell.inlineHeight).toBe(10000);
  shell.setInlineHeight(NaN); expect(shell.inlineHeight).toBe(10000);
  shell.dispose();
});
