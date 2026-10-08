// Ordering between boot's authoritative state and the live document topic.
//
// Boot fetches `/api/state` and applies it, then subscribes the document
// topic. Through the hub, a subscriber joining an upstream that is already
// open (another tab, or the lingering upstream a reload leaves behind) is
// handed the upstream's LATEST snapshot — one the server produced before
// boot's fetch. That frame must be refused like any other frame older than
// state already applied, or the page is put back on the older roots.
//
// events.ts is driven for real against a linkedom DOM of the shell's
// index.html, with the page's one live channel replaced by a controllable one.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";

import type { LiveChannel, LiveTopicConsumer } from "./live-channel";
import { BUILD, BUNDLED_WEB_REVISION, WORKSPACE_API_REVISION } from "../shared/version";
import type { RootGroup, StatePayload } from "../shared/types";

const GLOBALS = ["document", "window", "Node", "Element", "HTMLElement", "HTMLTemplateElement", "customElements"] as const;
// What the shell reads off `window`. linkedom's window forwards unknown
// properties to `globalThis`, so these land there too, and are put back.
// Frame callbacks queue here and are flushed in afterAll before the globals
// go. Importing events.ts loads the sidebar tree and so preact/hooks, which
// decides at that moment, from `typeof requestAnimationFrame`, that it may
// call cancelAnimationFrame in its effect flush for the rest of the process;
// a flush left pending by a stub that never fires would then throw after
// this suite removed cancelAnimationFrame, in whichever file runs next.
const frames: FrameRequestCallback[] = [];
const WINDOW_STUBS = {
  // Layout passes the sidebar schedules are irrelevant here; they run at
  // teardown only so nothing stays pending.
  requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
  cancelAnimationFrame: (id: number) => { frames[id - 1] = () => {}; },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
let selectPrototype: object | null = null;
let savedSelectValue: PropertyDescriptor | undefined;

beforeAll(async () => {
  const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
  const { window } = parseHTML(html);
  for (const name of [...GLOBALS, ...Object.keys(WINDOW_STUBS)]) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  // linkedom's <select> has a read-only `value`; the sidebar writes one. The
  // class is linkedom's own, shared by every suite, so the original returns.
  selectPrototype = (Reflect.get(window, "HTMLSelectElement") as { prototype: object }).prototype;
  savedSelectValue = Object.getOwnPropertyDescriptor(selectPrototype, "value");
  Object.defineProperty(selectPrototype, "value", {
    configurable: true,
    get(this: Element) { return this.getAttribute("data-test-value") ?? ""; },
    set(this: Element, value: string) { this.setAttribute("data-test-value", value); },
  });
  for (const [name, stub] of Object.entries(WINDOW_STUBS)) Reflect.set(window, name, stub);
  for (const name of GLOBALS) Reflect.set(globalThis, name, name === "window" ? window : Reflect.get(window, name));
  // Importing events.ts loads the preview's Mermaid module, which subscribes
  // to color-scheme changes for the life of the process. Pin the theme
  // module's media query now, so a later suite's dispatch reaches that
  // listener without it reading a `window` this suite has since removed.
  const { initColorSchemeTracking } = await import("./theme");
  initColorSchemeTracking();
});

afterAll(async () => {
  const { disposeLiveChannel } = await import("./live");
  disposeLiveChannel();
  for (const frame of frames.splice(0)) frame(performance.now());
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  if (selectPrototype) {
    if (savedSelectValue) Object.defineProperty(selectPrototype, "value", savedSelectValue);
    else Reflect.deleteProperty(selectPrototype, "value");
  }
});

function root(label: string): RootGroup {
  return { id: label, label, path: `/${label}`, docs: [], hiddenCount: 0 };
}

function state(label: string, generatedAt: number): StatePayload {
  return {
    workspaceApiRevision: WORKSPACE_API_REVISION,
    roots: [root(label)],
    repositories: [],
    compareTarget: "base",
    initialFollow: false,
    defaultDocumentId: null,
    changedId: null,
    generatedAt,
    build: {
      version: BUILD.version,
      branch: BUILD.branch,
      commitSha: BUILD.commitSha,
      commitShort: BUILD.commitShort,
      release: BUILD.release,
      identifier: "test",
      bundledWebRevision: BUNDLED_WEB_REVISION,
    },
    scope: { kind: "folder" },
  } as StatePayload;
}

// A channel whose document topic the test feeds by hand, always current.
function controllableChannel(): { channel: LiveChannel; document: () => LiveTopicConsumer; confirmed: number[] } {
  let consumer: LiveTopicConsumer | null = null;
  const confirmed: number[] = [];
  const channel = {
    connect() {},
    suspend() {},
    dispose() {},
    onStatus: () => () => {},
    subscribe(_key: unknown, next: LiveTopicConsumer) {
      consumer = next;
      return { resubscribe() {}, close() {} };
    },
    isCurrent: () => true,
    confirm: (generation: number) => { confirmed.push(generation); },
    invalidate() {},
  } as unknown as LiveChannel;
  return { channel, document: () => consumer!, confirmed };
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe("boot state and the first live frame", () => {
  test("disposing the live channel releases repository polling and wake-up work", async () => {
    const { disposeLiveChannel, installLiveChannelForTests, recoverLiveChannel } = await import("./live");
    const { connectEvents } = await import("./events");
    const { appState } = await import("./state");
    const intervals = spyOn(globalThis, "setInterval");
    const clears = spyOn(globalThis, "clearInterval");
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const previousView = appState.viewMode;
    try {
      installLiveChannelForTests(controllableChannel().channel);
      connectEvents();
      connectEvents();
      expect(intervals).toHaveBeenCalledTimes(1);
      const [tick, delay] = intervals.mock.calls[0]!;
      expect(delay).toBe(5000);
      appState.viewMode = "diff";
      (tick as () => void)();
      expect(fetcher).toHaveBeenCalledTimes(1);

      disposeLiveChannel();
      expect(clears).toHaveBeenCalledWith(intervals.mock.results[0]!.value);
      installLiveChannelForTests(controllableChannel().channel);
      await recoverLiveChannel();
      expect(fetcher).toHaveBeenCalledTimes(1);

      // An explicit new connection installs exactly one fresh polling timer.
      connectEvents();
      expect(intervals).toHaveBeenCalledTimes(2);
      disposeLiveChannel();
      expect(clears).toHaveBeenCalledWith(intervals.mock.results[1]!.value);
    } finally {
      disposeLiveChannel();
      for (const result of intervals.mock.results) if (result.type === "return") clearInterval(result.value);
      appState.viewMode = previousView;
      fetcher.mockRestore();
      clears.mockRestore();
      intervals.mockRestore();
    }
  });

  test("a live frame the server produced before boot's state is refused, and a newer one applies", async () => {
    const { installLiveChannelForTests } = await import("./live");
    const { adoptBootSnapshot, connectEvents } = await import("./events");
    const { appState } = await import("./state");
    const live = controllableChannel();
    installLiveChannelForTests(live.channel);

    // Boot applied state the server produced at 2_000, then subscribed.
    adoptBootSnapshot(state("booted", 2_000));
    connectEvents();
    expect(appState.roots.map(r => r.label)).toEqual(["booted"]);

    // The hub hands the joiner its retained snapshot from 1_000.
    live.document().data!(state("retained-older", 1_000), "e.1", 1);
    await settle();
    expect(appState.roots.map(r => r.label)).toEqual(["booted"]);
    // The transport still proved itself live.
    expect(live.confirmed).toContain(1);

    // Anything the server produced after boot's state applies as usual.
    live.document().data!(state("newer", 3_000), "e.2", 1);
    await settle();
    expect(appState.roots.map(r => r.label)).toEqual(["newer"]);
  });
});
