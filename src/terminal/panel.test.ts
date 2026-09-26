// Keyboard focus across the touch tab bar and the terminal panel.
//
// The tab bar is an ARIA tablist: arrow keys, Home and End on a focused tab
// move focus to the target tab and select it. Selecting the Terminal tab
// shows the panel, which spawns or attaches a pane asynchronously — and a
// shown panel focuses its pane once one exists. For arrow-key navigation
// that must not happen: focus belongs on the tab, or the next arrow key is
// typed into the shell. A tap on the Terminal tab keeps focusing the pane.
//
// The real tab bar and panel controller run against a linkedom DOM of the
// shell's index.html; only the xterm mount is a stand-in (its `focus()`
// focuses a textarea in the pane host, as xterm does), and the terminal
// session routes answer through a fetch stub the test releases by hand.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import type { TerminalPanelHandle } from "./client";
import { appState } from "../shell/state";
import type { UiMode } from "../shell/ui-mode";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
  } as Storage;
}

const GLOBALS = ["document", "window", "Node", "Element", "HTMLElement", "HTMLButtonElement", "Event", "customElements"] as const;
const frames: FrameRequestCallback[] = [];
const WINDOW_STUBS = {
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; },
  cancelAnimationFrame: () => {},
  // A coarse primary pointer resolves the UI mode to touch.
  matchMedia: (query: string) => ({ matches: query.includes("coarse"), addEventListener() {}, removeEventListener() {} }),
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  innerWidth: 800,
  innerHeight: 1000,
};
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
let savedFetch: typeof fetch;
let savedFocus: PropertyDescriptor | undefined;
let focusPrototype: { focus?: () => void } | null = null;
let disposePanel: (() => void) | undefined;
let savedMode: UiMode | null = null;
const savedTab = appState.activeTab;
const savedSurface = appState.activeSurface;

// The session create the panel POSTs; the test decides when it answers,
// which is when the pane attaches.
let pendingCreate: Deferred<Response> | null = null;
const mounted: { host: HTMLElement; focusCalls: number }[] = [];

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const frame of frames.splice(0)) frame(0);
  }
}

function fakeMount(options: { container: HTMLElement }): TerminalPanelHandle {
  const record = { host: options.container, focusCalls: 0 };
  mounted.push(record);
  const input = options.container.ownerDocument.createElement("textarea");
  input.className = "xterm-helper-textarea";
  options.container.append(input);
  let attached = false;
  const handle = {
    attach() { attached = true; },
    detach() { attached = false; },
    terminate() { attached = false; return true; },
    release() {},
    resume() {},
    state: () => (attached ? "attached" : "idle"),
    fit() {},
    focus() {
      record.focusCalls += 1;
      input.focus();
    },
    setFontSize() {},
    sendInput() {},
    paste() {},
    isAttached: () => attached,
    isSelectionSheetOpen: () => false,
    dismissSelectionSheet: () => false,
  };
  // Anything else the controller reaches for is inert.
  return new Proxy(handle, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : () => undefined),
  }) as unknown as TerminalPanelHandle;
}

beforeAll(async () => {
  const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
  const { window, document } = parseHTML(html);
  for (const name of [...GLOBALS, ...Object.keys(WINDOW_STUBS)]) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  for (const [name, stub] of Object.entries(WINDOW_STUBS)) Reflect.set(window, name, stub);
  for (const name of GLOBALS) Reflect.set(globalThis, name, name === "window" ? window : Reflect.get(window, name));

  // linkedom tracks no focus: give it an activeElement that focus() moves.
  let active: Element | null = null;
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active ?? document.body });
  focusPrototype = (Reflect.get(window, "HTMLElement") as { prototype: { focus?: () => void } }).prototype;
  savedFocus = Object.getOwnPropertyDescriptor(focusPrototype, "focus");
  Object.defineProperty(focusPrototype, "focus", {
    configurable: true,
    value(this: Element) { active = this; },
  });

  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") return Response.json({ sessions: [] });
    pendingCreate = deferred<Response>();
    return pendingCreate.promise;
  }) as typeof fetch;
});

afterAll(async () => {
  // The panel and tab bar subscribe to shared module state; leave it as found.
  disposePanel?.();
  if (savedMode) {
    const { setUiMode } = await import("../shell/ui-mode");
    setUiMode(savedMode);
  }
  appState.activeTab = savedTab;
  appState.activeSurface = savedSurface;
  globalThis.fetch = savedFetch;
  if (focusPrototype) {
    if (savedFocus) Object.defineProperty(focusPrototype, "focus", savedFocus);
    else Reflect.deleteProperty(focusPrototype, "focus");
  }
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function pressKey(target: HTMLElement, key: string): void {
  const event = new Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  target.dispatchEvent(event);
}

function releaseCreate(id: string): void {
  expect(pendingCreate).not.toBeNull();
  pendingCreate!.resolve(Response.json({ id, attached: false, createdAt: 1, cols: 80, rows: 24, label: "zsh" }));
  pendingCreate = null;
}

describe("touch tab bar keyboard focus with the terminal panel", () => {
  test("ArrowRight onto Terminal keeps focus on the tab after the pane attaches; a tap focuses the pane", async () => {
    const { initTabBar, setActiveTab } = await import("../shell/tab-bar");
    const { setupTerminalPanel } = await import("./panel");
    const { setUiMode, uiMode } = await import("../shell/ui-mode");
    // Another suite in this process may already have resolved the shared
    // UI mode; this case is about touch mode either way.
    savedMode = uiMode();
    setUiMode("touch");
    initTabBar();
    setActiveTab("chat");
    disposePanel = setupTerminalPanel(true, undefined, { mountPane: fakeMount as never });
    expect(disposePanel).toBeFunction();

    const chatTab = document.getElementById("touch-tab-chat") as HTMLButtonElement;
    const terminalTab = document.getElementById("touch-tab-terminal") as HTMLButtonElement;
    expect(terminalTab.disabled).toBe(false);

    chatTab.focus();
    pressKey(chatTab, "ArrowRight");
    expect(terminalTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(terminalTab);

    // The panel's inventory read and session create settle only now: the
    // pane attaches after the arrow key already landed on the tab.
    await flush();
    releaseCreate("pty-1");
    await flush();
    expect(mounted).toHaveLength(1);
    expect(document.getElementById("terminal-panes")!.querySelector(".terminal-pane")).not.toBeNull();
    expect(mounted[0]!.focusCalls).toBe(0);
    expect(document.activeElement).toBe(terminalTab);

    // The next arrow key still navigates the tabs rather than the shell.
    pressKey(terminalTab, "ArrowRight");
    const filesTab = document.getElementById("touch-tab-files") as HTMLButtonElement;
    expect(document.activeElement).toBe(filesTab);
    expect(filesTab.getAttribute("aria-selected")).toBe("true");

    // A tap (click) on the Terminal tab is an activation: the attached pane
    // takes focus, as the touch UX intends.
    terminalTab.click();
    await flush();
    expect(terminalTab.getAttribute("aria-selected")).toBe("true");
    expect(mounted[0]!.focusCalls).toBeGreaterThan(0);
    expect(mounted[0]!.host.contains(document.activeElement)).toBe(true);
  });
});
