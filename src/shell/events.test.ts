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
import type { DiscoveryState, DocumentPatch, DocumentSnapshot, RevisionedRoot } from "../shared/document-updates";
import type { MediaSource } from "../media/controller";

const GLOBALS = ["document", "window", "Node", "Element", "HTMLElement", "HTMLTemplateElement", "HTMLStyleElement", "HTMLDivElement", "SVGElement", "ShadowRoot", "MutationObserver", "customElements"] as const;
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
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
};
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
let selectPrototype: object | null = null;
let savedSelectValue: PropertyDescriptor | undefined;
let layoutPrototype: object | null = null;
const savedLayout = new Map<string, PropertyDescriptor | undefined>();

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
  // Real file rows now participate in the media integration cases. Supply
  // layout scalars that linkedom does not implement, retaining Pierre's model.
  layoutPrototype = window.HTMLElement.prototype;
  for (const [name, value] of Object.entries({ scrollTop: 0, scrollLeft: 0, clientHeight: 600, clientWidth: 320 })) {
    savedLayout.set(name, Object.getOwnPropertyDescriptor(layoutPrototype, name));
    Object.defineProperty(layoutPrototype, name, { configurable: true, writable: true, value });
  }
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
  if (layoutPrototype) for (const [name, descriptor] of savedLayout) {
    if (descriptor) Object.defineProperty(layoutPrototype, name, descriptor);
    else Reflect.deleteProperty(layoutPrototype, name);
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
  test("the page never polls for repository data, and disposing the channel releases wake-up work", async () => {
    const { disposeLiveChannel, installLiveChannelForTests, recoverLiveChannel } = await import("./live");
    const { connectEvents } = await import("./events");
    const { appState } = await import("./state");
    const intervals = spyOn(globalThis, "setInterval");
    const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const previousView = appState.viewMode;
    try {
      // Diff mode and the Git panes once drove a 5 s repository refresh; the
      // server observes Git itself now.
      appState.viewMode = "diff";
      installLiveChannelForTests(controllableChannel().channel);
      connectEvents();
      connectEvents();
      expect(intervals).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.filter(([input]) => String(input).includes("/api/repositories/refresh"))).toEqual([]);

      disposeLiveChannel();
      installLiveChannelForTests(controllableChannel().channel);
      const before = fetcher.mock.calls.length;
      await recoverLiveChannel();
      // The disposed connection's state recovery is gone with it.
      expect(fetcher.mock.calls.length).toBe(before);
    } finally {
      disposeLiveChannel();
      appState.viewMode = previousView;
      fetcher.mockRestore();
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

describe("search ownership through accepted document events", () => {
  let searchGeneratedAt = 100_000;
  beforeAll(async () => {
    const { initSearchPane } = await import("../sidebar/search-pane");
    initSearchPane();
  });

  async function withSearch(run: (fixture: {
    snapshot: DocumentSnapshot;
    send: (values?: Partial<DocumentPatch>) => Promise<void>;
    frame: (values?: Partial<DocumentSnapshot>) => Promise<void>;
    hit: () => Promise<void>;
    finish: () => Promise<void>;
    signal: AbortSignal;
  }) => Promise<void>, options: { pinned?: boolean; allRoots?: boolean; legacy?: boolean } = {}) {
    const { disposeLiveChannel, installLiveChannelForTests } = await import("./live");
    const { adoptBootSnapshot, connectEvents } = await import("./events");
    const { appState } = await import("./state");
    const documents = await import("./document-state");
    const previous = { ...appState };
    const location = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", { configurable: true, value: { origin: "http://localhost" } });
    const live = controllableChannel();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let signal!: AbortSignal;
    const encoder = new TextEncoder();
    const emit = (event: unknown) => stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      if (!String(input).includes("/api/search?")) return Response.json({});
      signal = init!.signal!;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }));
    }) as typeof fetch);
    let revision = 1;
    let generatedAt = searchGeneratedAt += 100;
    const doc = { id: "/search/a.md", rootId: "/search", name: "a.md", relativePath: "a.md",
      kind: "markdown" as const, mtimeMs: 1, revision: 1, gitIgnoreStatus: "not-ignored" as const };
    const snapshot: DocumentSnapshot = { ...state("search", generatedAt), kind: "snapshot", epoch: "search-owner",
      revision, unscopedFingerprint: "search:1", roots: [{ ...root("/search"), path: "/search", docs: [doc] }],
      discovery: { status: "ready", discovered: 1 }, repositoryState: { status: "ready", generation: 0 } };
    if (options.pinned) snapshot.scope = { kind: "file", documentId: doc.id };
    try {
      disposeLiveChannel(); documents.resetDocumentIndex();
      Object.assign(appState, { previewMode: { kind: "empty" }, followEnabled: false,
        selectedId: null, selectionCleared: true, showIgnored: false });
      installLiveChannelForTests(live.channel);
      const { kind: _kind, epoch: _epoch, revision: _revision, ...legacy } = snapshot;
      adoptBootSnapshot(options.legacy ? legacy : snapshot); connectEvents();
      const query = document.querySelector<HTMLInputElement>("#search-query")!;
      query.value = "";
      if (options.allRoots) document.querySelector('[data-search-scope="all"]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
      query.value = "needle";
      document.querySelector("#search-case")!.dispatchEvent(new window.Event("click"));
      await settle();
      emit({ kind: "file", result: { documentId: doc.id, rootId: doc.rootId, relativePath: doc.relativePath,
        matches: [{ line: 1, start: 0, end: 6, text: "needle", ordinal: 0, literalTotal: 1 }] } });
      await settle();
      expect(document.querySelectorAll(".search-hit").length).toBe(1);
      const send = async (values: Partial<DocumentPatch> = {}) => {
        const previousRevision = revision++;
        live.document().data!({ kind: "patch", epoch: snapshot.epoch, previousRevision, revision,
          generatedAt: ++generatedAt, scope: snapshot.scope, compareTarget: "base", unscopedFingerprint: "search:1",
          upserts: [], removals: [], changedId: null, ...values }, "patch", 1);
        await settle();
      };
      await run({ snapshot, send, signal,
        hit: async () => {
          emit({ kind: "file", result: { documentId: doc.id, rootId: doc.rootId, relativePath: doc.relativePath,
            matches: [{ line: 2, start: 0, end: 6, text: "needle again", ordinal: 1, literalTotal: 2 }] } });
          await settle();
        },
        frame: async (values = {}) => {
          live.document().data!({ ...(options.legacy ? legacy : documents.documentIndex.snapshot()!), revision: ++revision,
            generatedAt: ++generatedAt, changedId: null, ...values }, "snapshot", 1);
          await settle();
        },
        finish: async () => { emit({ kind: "done", truncated: false }); stream.close(); await settle(); },
      });
    } finally {
      // Cancel any held stream and clear the pane before restoring globals/state.
      document.querySelector<HTMLInputElement>("#search-query")!.value = "";
      document.querySelector("#search-case")!.dispatchEvent(new window.Event("click"));
      if (options.allRoots) document.querySelector('[data-search-scope="respect"]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
      await settle();
      fetcher.mockRestore(); disposeLiveChannel(); documents.resetDocumentIndex(); Object.assign(appState, previous);
      if (location) Object.defineProperty(window, "location", location);
      else Reflect.deleteProperty(window, "location");
    }
  }

  for (const completed of [false, true]) {
    test.each([false, true])(`repository-only patches and snapshots preserve ${completed ? "completed" : "streaming"} results, widened=%s`, async widened => {
      await withSearch(async ({ snapshot, send, frame, hit, finish, signal }) => {
        if (completed) await finish();
        const roots = snapshot.roots.map(({ docs: _, ...metadata }) => metadata);
        await send({ roots, repositoryState: { status: "pending", generation: 1 } });
        await send({ roots, repositories: [], repositoryState: { status: "ready", generation: 1 } });
        await frame({ repositories: [], repositoryState: { status: "ready", generation: 2 } });
        expect(signal.aborted).toBe(false);
        expect(document.querySelector<HTMLElement>("#search-notice")!.hidden).toBe(true);
        if (!completed) {
          expect(document.querySelector("#search-summary")!.textContent).toBe("1 result · 1 file…");
          await hit();
          await finish();
        }
        expect(document.querySelector("#search-summary")!.textContent).toBe(completed ? "1 result · 1 file" : "2 results · 1 file");
        expect(document.querySelectorAll(".search-hit").length).toBe(completed ? 1 : 2);
        expect(document.querySelector<HTMLElement>("#search-notice")!.hidden).toBe(true);
      }, { pinned: widened, allRoots: widened });
    });

    for (const change of ["scope", "widen", "unscoped"] as const) {
      test(`${change} invalidates ${completed ? "completed" : "streaming"} scoped search ownership`, async () => {
        await withSearch(async ({ frame, send, finish, signal }) => {
          if (completed) await finish();
          if (change === "unscoped") await send({ unscopedFingerprint: "search:outside-change" });
          else await frame({ scope: change === "widen" ? { kind: "folder" } : { kind: "file", documentId: "/search/b.md" } });
          expect(signal.aborted).toBe(true);
          expect(document.querySelector("#search-notice")!.textContent).toContain("changed since");
        }, { pinned: true, allRoots: change === "unscoped" });
      });
    }

    test(`legacy roots replacement still invalidates ${completed ? "completed" : "streaming"} results`, async () => {
      await withSearch(async ({ snapshot, frame, finish, signal }) => {
        if (completed) await finish();
        await frame({ roots: snapshot.roots.map(root => ({ ...root, docs: [...root.docs] })) });
        expect(signal.aborted).toBe(true);
        expect(document.querySelector("#search-notice")!.textContent).toContain("changed since");
      }, { legacy: true });
    });

    for (const change of ["write", "add", "remove", "rename", "classification", "exception", "epoch", "preference"] as const) {
      test(`${change} invalidates ${completed ? "completed" : "streaming"} search ownership`, async () => {
        await withSearch(async ({ snapshot, send, frame, finish, signal }) => {
          if (completed) await finish();
          const doc = snapshot.roots[0]!.docs[0]!;
          switch (change) {
            case "write": await send({ upserts: [{ ...doc, revision: 2 }] }); break;
            case "add": await send({ upserts: [{ ...doc, id: "/search/b.md", name: "b.md", relativePath: "b.md", revision: 2 }] }); break;
            case "remove": await send({ removals: [{ rootId: doc.rootId, id: doc.id }] }); break;
            case "rename": await send({ removals: [{ rootId: doc.rootId, id: doc.id }], upserts: [{ ...doc, id: "/search/b.md", name: "b.md", relativePath: "b.md", revision: 2 }] }); break;
            case "classification": await send({ upserts: [{ ...doc, gitIgnoreStatus: "ignored" }] }); break;
            case "exception": await send({ upserts: [{ ...doc, ignoreVisibilityException: true }] }); break;
            case "epoch": await frame({ epoch: "recovered" }); break;
            case "preference": {
              const { appState } = await import("./state");
              const { reconcileSearchVisibility } = await import("../sidebar/search-pane");
              appState.showIgnored = true; reconcileSearchVisibility(); break;
            }
          }
          expect(signal.aborted).toBe(true);
          expect(document.querySelector("#search-notice")!.textContent).toContain("changed since");
          if (change === "classification" || change === "preference") expect(document.querySelectorAll(".search-hit").length).toBe(0);
        });
      });
    }
  }
});

class BufferedMedia extends EventTarget {
  paused = true; ended = false; currentTime = 3; duration = 8; loop = false;
  src = ""; preload = ""; controls = false; loads = 0;
  parentElement: HTMLElement | null = null;
  setAttribute() {}
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
  remove() { this.parentElement = null; }
  load() { this.loads++; }
  pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
  play() { this.paused = false; this.dispatchEvent(new Event("play")); return Promise.resolve(); }
}

let mediaGeneratedAt = 10_000;
const incompleteStates: Exclude<DiscoveryState["status"], "ready">[] = ["indexing", "recovering", "error"];

async function withMediaEvents(status: DiscoveryState["status"], run: (fixture: {
  player: typeof import("../media/controller").mediaPlayer;
  elements: BufferedMedia[];
  sources: MediaSource[];
  snapshot: DocumentSnapshot;
  document: () => LiveTopicConsumer;
  patch: (revision: number, removals?: DocumentPatch["removals"]) => DocumentPatch;
  index: () => import("../shared/document-updates").DocumentStateIndex;
}) => Promise<void>): Promise<void> {
  const { disposeLiveChannel, installLiveChannelForTests } = await import("./live");
  const { adoptBootSnapshot, connectEvents } = await import("./events");
  const { appState } = await import("./state");
  const documents = await import("./document-state");
  const { mediaPlayer, mediaSource } = await import("../media/controller");
  const previous = { previewMode: appState.previewMode, followEnabled: appState.followEnabled,
    selectedId: appState.selectedId, selectionCleared: appState.selectionCleared, roots: appState.roots };
  const elements: BufferedMedia[] = [];
  const originalCreate = document.createElement.bind(document);
  const create = spyOn(document, "createElement").mockImplementation((name: string, options?: ElementCreationOptions) => {
    if (name !== "audio") return originalCreate(name, options);
    const element = new BufferedMedia(); elements.push(element);
    return element as unknown as HTMLElement;
  });
  const host = { append(element: BufferedMedia) { element.parentElement = host as unknown as HTMLElement; } };
  try {
    disposeLiveChannel(); documents.resetDocumentIndex(); mediaPlayer.close();
    appState.previewMode = { kind: "empty" }; appState.followEnabled = false;
    appState.selectedId = null; appState.selectionCleared = true;
    mediaPlayer.setDefaultElementHost(host as unknown as HTMLElement);
    const roots: RevisionedRoot[] = ["one", "two"].map(id => ({
      id, path: `/${id}`, label: id, hiddenCount: 0,
      docs: ["shared", ...(id === "two" ? ["tail"] : [])].map(name => ({
        id: name, rootId: id, name: `${name}.wav`, relativePath: `${name}.wav`,
        kind: "binary", mtimeMs: 1, revision: 1,
      })),
    }));
    const epoch = `media-removal-${++mediaGeneratedAt}`;
    const snapshot: DocumentSnapshot = { ...state("media", ++mediaGeneratedAt), kind: "snapshot", epoch,
      revision: 1, roots, discovery: { status, discovered: 3 }, repositoryState: { generation: 0, status: "pending" } };
    const sources = roots.flatMap(root => root.docs).map(doc => mediaSource(doc, epoch)!);
    const live = controllableChannel(); installLiveChannelForTests(live.channel);
    adoptBootSnapshot(snapshot); connectEvents();
    await run({ player: mediaPlayer, elements, sources, snapshot, document: live.document,
      index: () => documents.documentIndex,
      patch: (revision, removals = []) => ({ kind: "patch", epoch, previousRevision: revision - 1,
        revision, generatedAt: ++mediaGeneratedAt, scope: { kind: "folder" }, compareTarget: "base",
        unscopedFingerprint: `media:${revision}`, upserts: [], removals, changedId: null,
        discovery: { status, discovered: 2 } }),
    });
  } finally {
    mediaPlayer.close(); disposeLiveChannel(); create.mockRestore();
    documents.resetDocumentIndex(); Object.assign(appState, previous);
  }
}

describe("accepted media removals during incomplete discovery", () => {
  test.each(incompleteStates)("an explicit removal during %s releases buffered looping media and rejects late callbacks", async status => {
    await withMediaEvents(status, async ({ player, sources, elements, patch, document, index }) => {
      const active = sources[0]!;
      player.audition(active, sources); player.setLoop(true);
      const native = elements[0]!;
      expect(player.snapshot().playing).toBe(true); expect(native.loop).toBe(true);
      const removal = patch(2, [{ rootId: active.rootId, id: active.id }]);
      document().data!(removal, "remove", 1); await settle();
      expect(index().find(active.id, active.rootId)).toBeUndefined();
      expect(index().find(active.id, "two")).toBeDefined();
      expect(index().discovery?.status).toBe(status);
      expect(player.snapshot()).toMatchObject({ unavailable: true, playing: false, loading: false, loop: false, element: null });
      expect(native.paused).toBe(true); expect(native.loop).toBe(false); expect(native.src).toBe("");
      expect(native.loads).toBeGreaterThan(0);
      native.paused = false; native.currentTime = 7;
      for (const event of ["play", "canplay", "timeupdate", "error"]) native.dispatchEvent(new Event(event));
      player.play(); player.reload(); player.setLoop(true);
      expect(player.snapshot()).toMatchObject({ unavailable: true, playing: false, loop: false, element: null });
      // A later partial reconciliation must not revive a removed captured entry.
      document().data!(patch(3), "partial", 1); await settle();
      player.next();
      expect(player.snapshot().source).toMatchObject({ id: "shared", rootId: "two" });
      expect(player.snapshot().canPrevious).toBe(false);
      player.previous(); expect(player.snapshot().source?.rootId).toBe("two");
      player.close(); player.present(active); player.audition(active, sources);
      expect(player.snapshot().source).toBeNull();
    });
  });

  test.each(incompleteStates)("a partial %s snapshot without removal retains buffered playback", async status => {
    await withMediaEvents(status, async ({ player, sources, elements, snapshot, document, index }) => {
      const active = sources[0]!; player.audition(active, sources); player.setLoop(true);
      document().data!({ ...snapshot, revision: 2, generatedAt: ++mediaGeneratedAt,
        roots: snapshot.roots.slice(1), discovery: { status, discovered: 2 } }, "partial-snapshot", 1);
      await settle();
      expect(index().find(active.id, active.rootId)).toBeUndefined();
      expect(player.snapshot()).toMatchObject({ unavailable: false, playing: true, loop: true, source: active });
      expect(player.snapshot().element).toBe(elements[0] as unknown as HTMLMediaElement);
      expect(elements[0]!.src).not.toBe("");
    });
  });

  test("root-qualified removal skips only that root's captured entry and ignores unapplied patches", async () => {
    await withMediaEvents("error", async ({ player, sources, elements, patch, document, index }) => {
      const removed = sources[0]!, active = sources[1]!, tail = sources[2]!;
      player.audition(active, [active, removed, tail]); player.setLoop(true);
      const native = elements[0]!;
      document().data!({ ...patch(2, [{ rootId: active.rootId, id: active.id }]), revision: 1, previousRevision: 0 }, "old", 1);
      await settle();
      document().data!({ ...patch(3, [{ rootId: active.rootId, id: active.id }]), previousRevision: 0 }, "gap", 1);
      await settle();
      expect(index().find(active.id, active.rootId)).toBeDefined();
      expect(player.snapshot()).toMatchObject({ playing: true, loop: true, unavailable: false, source: active });
      document().data!(patch(2, [{ rootId: removed.rootId, id: removed.id }]), "current", 1); await settle();
      expect(index().find(removed.id, removed.rootId)).toBeUndefined();
      expect(player.snapshot().element).toBe(native as unknown as HTMLMediaElement);
      expect(player.snapshot()).toMatchObject({ playing: true, loop: true, unavailable: false, source: active });
      player.next(); expect(player.snapshot().source).toEqual(tail);
      player.previous(); expect(player.snapshot().source).toEqual(active);
    });
  });

  test("an accepted root-membership removal is positive evidence even while another root is errored", async () => {
    await withMediaEvents("error", async ({ player, sources, elements, snapshot, patch, document, index }) => {
      player.audition(sources[0]!, sources); player.setLoop(true);
      document().data!({ ...patch(2), roots: snapshot.roots.slice(1).map(({ docs: _docs, ...metadata }) => metadata) }, "root-removed", 1);
      await settle();
      expect(index().find("shared", "one")).toBeUndefined();
      expect(index().find("shared", "two")).toBeDefined();
      expect(player.snapshot()).toMatchObject({ unavailable: true, playing: false, loop: false, element: null });
      expect(elements[0]!.src).toBe("");
      player.next(); expect(player.snapshot().source).toMatchObject({ id: "shared", rootId: "two" });
      expect(player.snapshot().canPrevious).toBe(false);
    });
  });
});
