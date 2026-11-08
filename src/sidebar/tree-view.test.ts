import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import type { FileTree, FileTreeDirectoryHandle } from "@pierre/trees";

import type { ChangedFileSummary, RepositorySnapshot, RootGroup } from "../shared/types";
import type { DocumentPatch } from "../shared/document-updates";
import {
  ancestorPaths,
  buildPathInputs,
  computeFilesPaneFilterMembership,
  computeFilteredPaths,
  reconcileFilterExpansion,
  resolveFileGitStatus,
  TreeView,
  type FilesPaneFilterMembership,
} from "./tree-view";

describe("TreeView selection lifecycle with the real library", () => {
  let container: HTMLElement & { __pierreFileTree?: FileTree };
  let view: TreeView;
  let selections: string[];
  let deselections: number;
  let restoreGlobals: () => void;
  // Animation-frame callbacks queue here and are flushed in afterEach before
  // the globals go. Preact's effect flush schedules itself through
  // requestAnimationFrame plus a 35 ms fallback timer, and it decides once,
  // when preact/hooks first loads in the process, whether it may call
  // cancelAnimationFrame. A stub that never fires leaves that timer to run
  // after this file has removed cancelAnimationFrame, which throws as an
  // unhandled error in whichever file runs next (seen on CI's serial order).
  let frames: FrameRequestCallback[] = [];
  const leaf = "guides/deep/active.md";
  const other = "other/deep/next.md";
  const paths = [leaf, "guides/direct.md", "guides/deep/sibling.md", other, "kept/open.md"];

  function roots(entries = paths, ids: Record<string, string> = {}): RootGroup[] {
    return [makeRoot({
      id: "r1", label: "project",
      docs: entries.map(relativePath => ({
        id: ids[relativePath] ?? relativePath,
        name: relativePath.split("/").at(-1)!, relativePath,
        rootId: "r1", mtimeMs: 0, kind: "markdown",
      })),
    })];
  }

  function tree(): FileTree {
    expect(container.__pierreFileTree).toBeDefined();
    return container.__pierreFileTree!;
  }

  function directory(path: string): FileTreeDirectoryHandle {
    const handle = tree().getItem(path);
    expect(handle?.isDirectory()).toBe(true);
    return handle as FileTreeDirectoryHandle;
  }

  function installClickHarness() {
    // linkedom runs capture listeners in bubble order. Supply that missing DOM
    // phase only; the target/bubble handlers, selection, and callbacks below
    // are still the real library. Browser tests cover actual native dispatch,
    // including the clicks synthesized by Enter/Space and touch taps.
    const captures = new Map<string, Set<EventListenerOrEventListenerObject>>([
      ["click", new Set()], ["keydown", new Set()],
    ]);
    const attachShadow = container.attachShadow.bind(container);
    container.attachShadow = init => {
      const shadow = attachShadow(init);
      const add = shadow.addEventListener.bind(shadow);
      const remove = shadow.removeEventListener.bind(shadow);
      shadow.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
        if (captures.has(type) && options === true && listener) captures.get(type)!.add(listener);
        else if (listener) add(type, listener, options);
      };
      shadow.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
        if (captures.has(type) && options === true && listener) captures.get(type)!.delete(listener);
        else if (listener) remove(type, listener, options);
      };
      return shadow;
    };
    const prepare = (target: HTMLElement, properties: Record<string, unknown> = {}, dispatchTarget: EventTarget = target) => {
      const type = properties.key ? "keydown" : "click";
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { button: 0, ...properties });
      if (properties.cancelled) event.preventDefault();
      const path: EventTarget[] = [];
      for (let node: Node | null = target; node; node = node.parentNode) path.push(node);
      Object.defineProperty(event, "composedPath", { value: () => path });
      for (const listener of captures.get(type)!) {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      }
      return () => {
        dispatchTarget.dispatchEvent(event);
        return event;
      };
    };
    const dispatch = (target: HTMLElement, properties: Record<string, unknown> = {}, dispatchTarget: EventTarget = target) =>
      prepare(target, properties, dispatchTarget)();
    return Object.assign(dispatch, {
      // Native browser dispatch can checkpoint microtasks between listeners;
      // a synchronous JS dispatchEvent call (including linkedom) cannot.
      withMicrotaskCheckpoint: async (target: HTMLElement, properties: Record<string, unknown> = {}) => {
        const finish = prepare(target, properties);
        await Promise.resolve();
        return finish();
      },
    });
  }

  beforeEach(() => {
    const { document, window } = parseHTML("<!doctype html><html><body><div id='tree'></div></body></html>");
    const globals: Record<string, unknown> = {
      document, window, HTMLElement: window.HTMLElement, Element: window.Element,
      HTMLStyleElement: window.HTMLStyleElement, Node: window.Node,
      HTMLTemplateElement: window.HTMLTemplateElement,
      HTMLDivElement: window.HTMLDivElement,
      SVGElement: window.SVGElement,
      ShadowRoot: window.ShadowRoot,
      MutationObserver: window.MutationObserver,
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
      cancelAnimationFrame: (id: number) => { frames[id - 1] = () => {}; },
    };
    frames = [];
    const previous = Object.entries(globals).map(([key]) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    // linkedom has no layout/scroll implementation. Supply browser defaults,
    // not a fake tree: all model mutations and callbacks remain Pierre's.
    const prototype = window.HTMLElement.prototype;
    const layout = { scrollTop: 0, scrollLeft: 0, clientHeight: 600, clientWidth: 300 };
    const previousLayout = Object.keys(layout).map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)] as const);
    for (const [key, value] of Object.entries(layout)) {
      Object.defineProperty(prototype, key, { configurable: true, writable: true, value });
    }
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    restoreGlobals = () => {
      for (const [key, descriptor] of previousLayout) {
        if (descriptor) Object.defineProperty(prototype, key, descriptor);
        else Reflect.deleteProperty(prototype, key);
      }
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    container = document.getElementById("tree") as typeof container;
    selections = [];
    deselections = 0;
    view = new TreeView({ container, onSelectDocument: id => selections.push(id), onDeselectDocument: () => {
      deselections++;
      view.update(roots(), null);
    } });
  });

  afterEach(() => {
    try {
      view.dispose();
      expect(selections).toEqual([]);
    } finally {
      // Run what the render and the dispose scheduled while the stubs are
      // still in place; preact's flush cancels its fallback timer here.
      for (const frame of frames.splice(0)) frame(performance.now());
      restoreGlobals();
    }
  });

  it("reveals an initial nested selection without emitting a navigation echo", () => {
    view.update(roots(), leaf);
    expect(directory("guides/").isExpanded()).toBe(true);
    expect(directory("guides/deep/").isExpanded()).toBe(true);
    expect(directory("other/").isExpanded()).toBe(false);
    expect(tree().getSelectedPaths()).toEqual([leaf]);
  });

  it("a tree of only unlisted ignored folders stays visible, and filters hide folder rows without failing", () => {
    const folderOnly: RootGroup[] = [{ id: "r1", label: "r1", path: "/r1", hiddenCount: 0, docs: [],
      folders: [{ id: "/r1/build", rootId: "r1", relativePath: "build/", listed: false, revision: 0 }] }];
    view.update(folderOnly, null);
    expect(view.getVisibleLeafCount()).toBe(0);
    expect(view.hasVisibleFolderRows()).toBe(true);
    expect(directory("build/").isExpanded()).toBe(false);
    // A listed level's file plus a media filter: folder rows leave after their
    // files, without a non-recursive removal of a non-empty folder.
    const listed: RootGroup[] = [{ ...folderOnly[0]!, docs: [{ id: "/r1/build/out.txt", name: "out.txt", relativePath: "build/out.txt", rootId: "r1", mtimeMs: 0, kind: "text", gitIgnoreStatus: "ignored" }],
      folders: [{ ...folderOnly[0]!.folders![0]!, listed: true }] }];
    view.update(listed, null);
    view.update(listed, null, { mediaType: "audio" });
    expect(view.hasVisibleFolderRows()).toBe(false);
    expect(tree().getItem("build/")).toBeNull();
    view.update(listed, null, { mediaType: "all", showIgnored: false });
    expect(view.hasVisibleFolderRows()).toBe(false);
    view.update(listed, null);
    expect(view.hasVisibleFolderRows()).toBe(true);
  });

  it("removing a folder row whose live-written file sat in an implicit subfolder does not fail", () => {
    const inventory: RootGroup[] = [{ id: "r1", label: "r1", path: "/r1", hiddenCount: 0,
      docs: [{ id: "/r1/build/renders/a.wav", name: "a.wav", relativePath: "build/renders/a.wav", rootId: "r1", mtimeMs: 0, kind: "binary", gitIgnoreStatus: "ignored", revision: 1 }],
      folders: [{ id: "/r1/build", rootId: "r1", relativePath: "build/", listed: false, revision: 0 }] }];
    view.update(inventory, null);
    expect(tree().getItem("build/renders/a.wav")).not.toBeNull();
    const patch: DocumentPatch = { kind: "patch", epoch: "e", previousRevision: 1, revision: 2, generatedAt: 2,
      scope: { kind: "folder" }, compareTarget: "base", unscopedFingerprint: "2", upserts: [], changedId: null,
      removals: [{ rootId: "r1", id: "/r1/build/renders/a.wav" }], folderRemovals: [{ rootId: "r1", id: "/r1/build" }] };
    expect(view.applyPatch(patch, null)).toBe(true);
    expect(tree().getItem("build/")).toBeNull();
    expect(tree().getItem("build/renders/")).toBeNull();
  });

  it("a folder row removed before its last files leaves once they do", () => {
    const docs = ["a.o", "b.o"].map((name, index) => ({ id: `/r1/build/${name}`, name, relativePath: `build/${name}`, rootId: "r1", mtimeMs: 0, kind: "binary" as const, gitIgnoreStatus: "ignored" as const, revision: index + 1 }));
    view.update([{ id: "r1", label: "r1", path: "/r1", hiddenCount: 0, docs,
      folders: [{ id: "/r1/build", rootId: "r1", relativePath: "build/", listed: true, revision: 0 }] }], null);
    const patch = (revision: number, values: Partial<DocumentPatch>): DocumentPatch => ({ kind: "patch", epoch: "e", previousRevision: revision - 1, revision, generatedAt: revision,
      scope: { kind: "folder" }, compareTarget: "base", unscopedFingerprint: String(revision), upserts: [], removals: [], changedId: null, ...values });
    expect(view.applyPatch(patch(3, { removals: [{ rootId: "r1", id: "/r1/build/a.o" }], folderRemovals: [{ rootId: "r1", id: "/r1/build" }] }), null)).toBe(true);
    expect(tree().getItem("build/b.o")).not.toBeNull();
    expect(view.applyPatch(patch(4, { removals: [{ rootId: "r1", id: "/r1/build/b.o" }] }), null)).toBe(true);
    expect(tree().getItem("build/")).toBeNull();
  });

  it("folder removals are qualified by root when overlapping roots share a folder id", () => {
    const shared = { id: "/repo/sub/build", listed: false, revision: 0 };
    const overlapping: RootGroup[] = [
      { id: "/repo", label: "repo", path: "/repo", hiddenCount: 0, docs: [], folders: [{ ...shared, rootId: "/repo", relativePath: "sub/build/" }] },
      { id: "/repo/sub", label: "sub", path: "/repo/sub", hiddenCount: 0, docs: [], folders: [{ ...shared, rootId: "/repo/sub", relativePath: "build/" }] },
    ];
    view.update(overlapping, null);
    expect(tree().getItem("repo/sub/build/")).not.toBeNull();
    expect(tree().getItem("sub/build/")).not.toBeNull();
    const removal = (rootId: string): DocumentPatch => ({ kind: "patch", epoch: "e", previousRevision: 0, revision: 1, generatedAt: 1,
      scope: { kind: "folder" }, compareTarget: "base", unscopedFingerprint: "1", upserts: [], removals: [], changedId: null,
      folderRemovals: [{ rootId, id: shared.id }] });
    expect(view.applyPatch(removal("/repo"), null)).toBe(true);
    expect(tree().getItem("repo/sub/build/")).toBeNull();
    expect(tree().getItem("sub/build/")).not.toBeNull();
    expect(view.applyPatch({ ...removal("/repo/sub"), previousRevision: 1, revision: 2 }, null)).toBe(true);
    expect(tree().getItem("sub/build/")).toBeNull();
  });

  it("type filtering excludes an active nonmatching file and captures natural tree order including closed folders", () => {
    const inventory = roots(["z.wav", "renders/take10.wav", "renders/take2.wav", "movie.mp4", "README.md", "ignored.wav"]);
    inventory[0]!.docs.find(doc => doc.name === "ignored.wav")!.gitIgnoreStatus = "ignored";
    view.update(inventory, "README.md", { mediaType: "audio", showIgnored: false });
    expect(tree().getItem("README.md")).toBeNull();
    expect(tree().getItem("movie.mp4")).toBeNull();
    expect(tree().getItem("ignored.wav")).toBeNull();
    expect(directory("renders/").isExpanded()).toBe(false);
    expect(view.getEligibleDocuments().map(doc => doc.id)).toEqual(["renders/take2.wav", "renders/take10.wav", "z.wav"]);
    expect(view.getVisibleLeafCount()).toBe(3);
    view.setQuery("renders/");
    expect(view.getEligibleDocuments().map(doc => doc.id)).toEqual(["renders/take2.wav", "renders/take10.wav"]);
    const original = tree();
    view.update(inventory, "README.md", { mediaType: "video", showIgnored: false });
    view.setQuery("");
    expect(tree()).toBe(original);
    expect(view.getVisibleLeafCount()).toBe(1);
    expect(view.getEligibleDocuments().map(doc => doc.id)).toEqual(["movie.mp4"]);
    expect(tree().getSelectedPaths()).toEqual([]);
    expect(deselections).toBe(0);
  });

  it("Changed type membership composes with ignored visibility and does not inject a mismatching active file", () => {
    const inventory = roots(["clip.wav", "clip.mp4", "README.md", "ignored.wav"]);
    inventory[0]!.docs.find(doc => doc.name === "ignored.wav")!.gitIgnoreStatus = "ignored";
    const filter = { allowedByRoot: new Map([["r1", new Set(["clip.wav", "clip.mp4", "ignored.wav"])]]) };
    view.update(inventory, "README.md", { filter, mediaType: "audio", showIgnored: false });
    expect(view.getEligibleDocuments().map(doc => doc.id)).toEqual(["clip.wav"]);
    view.updateFilter(filter);
    expect(tree().getItem("README.md")).toBeNull();
    expect(view.getVisibleLeafCount()).toBe(1);
    expect(tree().getSelectedPaths()).toEqual([]);
  });

  for (const mode of ["all", "changed"] as const) {
    it(`${mode} hides an ignored active file without injecting it back or emitting navigation`, () => {
      const inventory = roots();
      inventory[0]!.docs.find(doc => doc.id === leaf)!.gitIgnoreStatus = "ignored";
      inventory[0]!.docs.find(doc => doc.id === "guides/direct.md")!.gitIgnoreStatus = "unknown";
      const exception = inventory[0]!.docs.find(doc => doc.id === "guides/deep/sibling.md")!;
      exception.gitIgnoreStatus = "ignored";
      exception.ignoreVisibilityException = true;
      const filter = mode === "changed" ? { allowedByRoot: new Map([["r1", new Set(paths)]]) } : null;
      view.update(inventory, leaf, { filter, showIgnored: true });
      const original = tree();
      directory("kept/").expand();
      view.update(inventory, leaf, { filter, showIgnored: false });
      expect(tree()).toBe(original);
      expect(tree().getItem(leaf)).toBeNull();
      expect(tree().getItem("guides/direct.md")).not.toBeNull();
      expect(tree().getItem(exception.relativePath)).not.toBeNull();
      expect(view.getVisibleLeafCount()).toBe(paths.length - 1);
      expect(tree().getSelectedPaths()).toEqual([]);
      expect(deselections).toBe(0);
      if (mode === "changed") {
        expect(view.updateFilter(filter!)).toBe(true);
        expect(tree().getItem(leaf)).toBeNull();
      }
      view.setQuery("active");
      expect(view.getVisibleLeafCount()).toBe(0);
      view.setQuery("");
      view.update(inventory, leaf, { filter, showIgnored: true });
      expect(tree().getSelectedPaths()).toEqual([leaf]);
      if (mode === "all") expect(directory("kept/").isExpanded()).toBe(true);
    });
  }

  it("a metadata-only ignored classification removes the active row, and later patches do not resurrect it", () => {
    const inventory = roots();
    view.update(inventory, leaf, { showIgnored: false });
    const doc = inventory[0]!.docs.find(doc => doc.id === leaf)!;
    const patch: DocumentPatch = { kind: "patch", epoch: "test", previousRevision: 1, revision: 2, generatedAt: 10,
      scope: { kind: "folder" }, compareTarget: "base", unscopedFingerprint: "test", changedId: null,
      removals: [], upserts: [{ ...doc, revision: 2, gitIgnoreStatus: "ignored" }] };
    expect(view.applyPatch(patch, leaf)).toBe(true);
    expect(tree().getItem(leaf)).toBeNull();
    expect(view.getVisibleLeafCount()).toBe(paths.length - 1);
    expect(view.applyPatch({ ...patch, previousRevision: 2, revision: 3, upserts: [] }, leaf)).toBe(true);
    expect(tree().getItem(leaf)).toBeNull();
    view.updateFilter({ allowedByRoot: new Map([["r1", new Set([leaf])]]) });
    expect(tree().getItem(leaf)).toBeNull();
    expect(tree().getSelectedPaths()).toEqual([]);
    expect(deselections).toBe(0);
    expect(view.applyPatch({ ...patch, previousRevision: 3, revision: 4,
      upserts: [{ ...doc, revision: 4, gitIgnoreStatus: "unknown" }] }, leaf)).toBe(true);
    expect(tree().getItem(leaf)).not.toBeNull();
    expect(view.getVisibleLeafCount()).toBe(paths.length);
    expect(container.shadowRoot!.querySelector(`[data-item-path="${leaf}"]`)?.getAttribute("data-item-git-status")).toBeNull();
  });

  it("independent ignore metadata uses native muted status and preserves unrelated Git modifications", () => {
    const inventory = roots();
    inventory[0]!.docs.find(doc => doc.id === leaf)!.gitIgnoreStatus = "ignored";
    inventory[0]!.docs.find(doc => doc.id === "guides/direct.md")!.gitIgnoreStatus = "unknown";
    view.update(inventory, leaf);
    view.setGitStatus([{ rootId: "r1", relativePath: "guides/", status: "ignored" },
      { rootId: "r1", relativePath: "guides/deep/sibling.md", status: "modified" }]);
    const row = (path: string) => container.shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    expect(row(leaf)?.getAttribute("data-item-git-status")).toBe("ignored");
    expect(row("guides/direct.md")?.getAttribute("data-item-git-status")).toBeNull();
    expect(row("guides/deep/sibling.md")?.getAttribute("data-item-git-status")).toBe("modified");
    expect(row(leaf)?.textContent).not.toMatch(/ignored/i);
    expect(resolveFileGitStatus({ ...inventory[0]!.docs[0]!, gitIgnoreStatus: "unknown" }, "ignored")).toBeUndefined();
  });

  for (const refresh of ["unchanged", "addition", "removal", "rename"] as const) {
    it(`preserves programmatically collapsed ancestors and requested leaf selection after ${refresh}`, () => {
      view.update(roots(), leaf);
      directory("guides/").collapse();
      expect(directory("guides/deep/").isExpanded()).toBe(true);
      directory("kept/").expand();
      // Folder interactions can leave a directory selected. Synchronization
      // must restore the application's leaf without revealing its ancestors.
      tree().getItem(leaf)!.deselect();
      directory("guides/").select();
      const next = refresh === "addition" ? [...paths, "new/file.md"]
        : refresh === "removal" ? paths.filter(path => path !== other)
        : refresh === "rename" ? paths.map(path => path === other ? "renamed/file.md" : path)
        : paths;
      view.update(roots(next), leaf);
      expect(directory("guides/").isExpanded()).toBe(false);
      expect(directory("guides/deep/").isExpanded()).toBe(true);
      expect(directory("kept/").isExpanded()).toBe(true);
      expect(tree().getSelectedPaths()).toEqual([leaf]);
      expect(deselections).toBe(0);
      if (refresh === "addition") expect(directory("new/").isExpanded()).toBe(false);
      directory("guides/").expand();
      expect(tree().getItem(leaf)?.isSelected()).toBe(true);
    });
  }

  it("does not mistake ArrowLeft focus movement for collapse, even though the library consumes it", () => {
    const dispatch = installClickHarness();
    view.update(roots(), leaf);
    tree().getItem(leaf)!.focus();
    const row = container.shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${leaf}"]`)!;
    let reachedShadow = false;
    container.shadowRoot!.addEventListener("keydown", () => { reachedShadow = true; });
    const event = dispatch(row, { key: "ArrowLeft" });
    expect(tree().getFocusedPath()).toBe("guides/deep/");
    expect(directory("guides/deep/").isExpanded()).toBe(true);
    expect(deselections).toBe(0);
    expect(reachedShadow).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(tree().getSelectedPaths()).toEqual([leaf]);
  });

  it("observes ArrowLeft handled at the tree root without depending on bubbling to the shadow", () => {
    const dispatch = installClickHarness();
    view.update(roots(), leaf);
    directory("guides/").focus();
    const root = container.shadowRoot!.querySelector<HTMLElement>('[role="tree"]')!;
    const event = dispatch(root, { key: "ArrowLeft" });
    expect(event.defaultPrevented).toBe(true);
    expect(deselections).toBe(1);
    expect(tree().getFocusedPath()).toBe("guides/");
  });

  for (const input of ["click", "ArrowLeft"]) {
    it(`retains ${input} collapse observers through a native-style microtask checkpoint`, async () => {
      const dispatch = installClickHarness();
      view.update(roots(), leaf);
      directory("guides/").focus();
      const row = container.shadowRoot!.querySelector<HTMLElement>('[data-item-path="guides/"]')!;
      await dispatch.withMicrotaskCheckpoint(row, input === "ArrowLeft" ? { key: input } : {});
      expect(deselections).toBe(1);
      expect(tree().getSelectedPaths()).toEqual([]);
      expect(directory("guides/").isExpanded()).toBe(false);
      expect(tree().getFocusedPath()).toBe("guides/");
    });
  }

  for (const refresh of ["unchanged", "addition", "removal", "rename"] as const) {
    it(`keeps deliberate empty selection and expanded descendants after ${refresh}`, () => {
      const dispatch = installClickHarness();
      view.update(roots(), leaf);
      directory("kept/").expand();
      dispatch(container.shadowRoot!.querySelector<HTMLElement>('[data-item-path="guides/"]')!);
      expect(deselections).toBe(1);
      const next = refresh === "addition" ? [...paths, "new/file.md"]
        : refresh === "removal" ? paths.filter(path => path !== other)
        : refresh === "rename" ? paths.map(path => path === other ? "renamed/file.md" : path)
        : paths;
      view.update(roots(next), null);
      expect(tree().getSelectedPaths()).toEqual([]);
      expect(directory("guides/").isExpanded()).toBe(false);
      expect(directory("guides/deep/").isExpanded()).toBe(true);
      expect(directory("kept/").isExpanded()).toBe(true);
      expect(deselections).toBe(1);
      dispatch(container.shadowRoot!.querySelector<HTMLElement>('[data-item-path="guides/"]')!);
      expect(tree().getSelectedPaths()).not.toContain(leaf);
      view.update(roots(next), leaf);
      expect(tree().getSelectedPaths()).toEqual([leaf]);
      expect(directory("guides/").isExpanded()).toBe(true);
    });
  }

  for (const selected of [null, "unknown.md", "unavailable.md"]) {
    it(`ignores manual collapse with requested selection ${selected}`, () => {
      const dispatch = installClickHarness();
      view.update(roots(), selected);
      directory("guides/").expand();
      const row = container.shadowRoot!.querySelector<HTMLElement>('[data-item-path="guides/"]')!;
      dispatch(row);
      expect(directory("guides/").isExpanded()).toBe(false);
      expect(deselections).toBe(0);
    });
  }

  it("ignores opening, unrelated and similarly prefixed directories", () => {
    const dispatch = installClickHarness();
    view.update(roots([...paths, "guides-old/file.md", "guide/file.md"]), leaf);
    for (const folder of ["other/deep/", "guides-old/", "guide/"]) {
      const row = () => container.shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${folder}"]`)!;
      dispatch(row());
      expect(directory(folder).isExpanded()).toBe(true);
      dispatch(row());
      expect(directory(folder).isExpanded()).toBe(false);
      expect(deselections).toBe(0);
    }
    expect(directory("guides/").isExpanded()).toBe(true);
  });

  it("does not close a retained but unavailable request when its surviving folder is collapsed", () => {
    const dispatch = installClickHarness();
    view.update(roots(), leaf);
    view.update(roots(paths.filter(path => path !== leaf)), leaf);
    dispatch(container.shadowRoot!.querySelector<HTMLElement>('[data-item-path="guides/"]')!);
    expect(directory("guides/").isExpanded()).toBe(false);
    expect(deselections).toBe(0);
    view.update(roots(), leaf);
    expect(directory("guides/").isExpanded()).toBe(false);
    expect(tree().getSelectedPaths()).toEqual([leaf]);
  });

  for (const ancestor of ["project/", "project/guides/", "project/guides/deep/"]) {
    it(`matches multi-root ancestor ${ancestor}, not another root's same relative path`, () => {
      const dispatch = installClickHarness();
      const groups = [...roots(), makeRoot({ id: "r2", label: "project-old", docs: [
        { ...roots()[0]!.docs[0]!, id: "second", rootId: "r2" },
      ] })];
      view.dispose();
      view = new TreeView({ container, onSelectDocument: id => selections.push(id), onDeselectDocument: () => {
        deselections++;
        view.update(groups, null);
      } });
      view.update(groups, leaf);
      directory("project-old/").expand();
      directory("project-old/guides/deep/").expand();
      const sibling = container.shadowRoot!.querySelector<HTMLElement>('[data-item-path="project-old/guides/deep/"]')!;
      dispatch(sibling);
      expect(directory("project-old/guides/deep/").isExpanded()).toBe(false);
      expect(deselections).toBe(0);
      directory(ancestor).focus();
      const row = container.shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${ancestor}"]`)!;
      dispatch(row, { key: "ArrowLeft" });
      expect(deselections).toBe(1);
      expect(directory(ancestor).isExpanded()).toBe(false);
      expect(tree().getSelectedPaths()).toEqual([]);
      expect(tree().getFocusedPath()).toBe(ancestor);
    });
  }

  it("keeps the active leaf selected when an unrelated root's directories are clicked", () => {
    const dispatch = installClickHarness();
    // Enough entries that the library renders project-old/ and its guides/
    // as separate (unflattened) directory rows.
    const groups = [...roots(), makeRoot({ id: "r2", label: "project-old",
      docs: roots()[0]!.docs.map(doc => ({ ...doc, id: `second-${doc.id}`, rootId: "r2" })),
    })];
    view.update(groups, leaf);
    const active = `project/${leaf}`;
    expect(tree().getSelectedPaths()).toEqual([active]);
    // Open then close the unrelated root, and an unrelated folder beside the
    // active document's ancestors.
    for (const path of ["project-old/", "project-old/", "project/kept/", "project/kept/"]) {
      directory(path).focus();
      const row = container.shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
      expect(row, path).not.toBeNull();
      dispatch(row!);
      expect(tree().getSelectedPaths()).toEqual([active]);
      expect(tree().getFocusedPath()).toBe(path);
    }
    expect(directory("project-old/").isExpanded()).toBe(false);
    expect(directory("project/kept/").isExpanded()).toBe(false);
    expect(deselections).toBe(0);
    expect(selections).toEqual([]);
  });

  it("ignores a collapse boundary after the requested document changes", () => {
    const dispatch = installClickHarness();
    view.update(roots(), leaf);
    const row = container.shadowRoot!.querySelector<HTMLElement>('[data-item-path="guides/"]')!;
    // Registered before the adapter's event-boundary listener, after Pierre's
    // handler: a newer application request must not be closed by the old input.
    row.addEventListener("click", () => view.update(roots(), other));
    dispatch(row);
    expect(directory("guides/").isExpanded()).toBe(false);
    expect(tree().getSelectedPaths()).toEqual([other]);
    expect(deselections).toBe(0);
  });

  it("programmatic collapse, reset restoration and filter reconciliation never emit deselection", () => {
    installClickHarness();
    view.update(roots(), leaf);
    directory("guides/").collapse();
    view.update(roots([...paths, "added.md"]), leaf);
    expect(directory("guides/").isExpanded()).toBe(false);
    expect(directory("guides/deep/").isExpanded()).toBe(true);
    const filter = { allowedByRoot: new Map([["r1", new Set([other])]]) };
    view.update(roots(), leaf, { filter });
    view.update(roots(), leaf);
    expect(deselections).toBe(0);
    expect(tree().getSelectedPaths()).toEqual([leaf]);
  });

  it("manual collapse under Changed emits once; subsequent resets and filters cannot restore a cleared request", () => {
    const dispatch = installClickHarness();
    const filter = { allowedByRoot: new Map([["r1", new Set(paths)]]) };
    view.dispose();
    view = new TreeView({ container, onSelectDocument: id => selections.push(id), onDeselectDocument: () => {
      deselections++;
      view.update(roots(), null, { filter });
    } });
    view.update(roots(), leaf, { filter });
    const row = container.shadowRoot!.querySelector<HTMLElement>('[data-item-path="guides/"]')!;
    dispatch(row, { detail: 0 }); // Native Enter/Space use the same button click boundary.
    expect(deselections).toBe(1);
    expect(directory("guides/").isExpanded()).toBe(false);
    view.update(roots([...paths, "added.md"]), null);
    view.update(roots(), null, { filter });
    view.update(roots(), null);
    expect(tree().getSelectedPaths()).toEqual([]);
    expect(deselections).toBe(1);
  });

  it("removes collapse observers and pending event listeners on disposal and installs them once on remount", () => {
    const dispatch = installClickHarness();
    view.update(roots(), leaf);
    const oldRow = container.shadowRoot!.querySelector<HTMLElement>('[data-item-path="guides/"]')!;
    dispatch(oldRow);
    expect(deselections).toBe(1);
    view.dispose();
    dispatch(oldRow, { key: "ArrowLeft" });
    dispatch(oldRow);
    expect(deselections).toBe(1);
    view.update(roots(), leaf);
    const row = container.shadowRoot!.querySelector<HTMLElement>('[data-item-path="guides/"]')!;
    directory("guides/").focus();
    dispatch(row, { key: "ArrowLeft" });
    expect(deselections).toBe(2);
  });

  it("never leaves a directory selected; an active leaf under a collapsed ancestor stays represented", () => {
    view.update(roots(), leaf);
    const folder = directory("guides/");
    folder.collapse();
    folder.focus();
    const focusedPath = tree().getFocusedPath();
    expect(focusedPath).not.toBeNull();
    tree().getItem(leaf)!.deselect();
    // Pre-toggle state is collapsed: this interaction opens the folder, so
    // the still-active document keeps its selection.
    folder.select();
    expect(tree().getSelectedPaths()).toEqual([leaf]);
    expect(folder.isExpanded()).toBe(false);
    expect(tree().getFocusedPath()).toBe(focusedPath);
    expect(selections).toEqual([]);
  });

  it("drops a directory selection without restoring the leaf when an expanded ancestor is selected", () => {
    view.update(roots(), leaf);
    const folder = directory("guides/deep/");
    folder.focus();
    // Pre-toggle state is expanded: the click that follows collapses the
    // ancestor and closes the document, so the leaf must not come back.
    // (A real click selects only the directory; model that replacement.)
    tree().getItem(leaf)!.deselect();
    folder.select();
    expect(tree().getSelectedPaths()).toEqual([]);
    expect(tree().getFocusedPath()).toBe("guides/deep/");
    expect(selections).toEqual([]);
    expect(deselections).toBe(0);
  });

  for (const ancestor of ["guides/", "guides/deep/"]) {
    for (const input of ["click", "ArrowLeft"]) {
      it(`closes once on native ${input} collapse of ${ancestor} and never on reopening`, () => {
        const dispatch = installClickHarness();
        view.update(roots(), leaf);
        directory(ancestor).focus();
        const row = container.shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${ancestor}"]`)!;
        dispatch(row, input === "ArrowLeft" ? { key: input } : {});
        expect(deselections).toBe(1);
        expect(directory(ancestor).isExpanded()).toBe(false);
        expect(tree().getSelectedPaths()).toEqual([]);
        expect(tree().getFocusedPath()).toBe(ancestor);
        dispatch(row);
        expect(deselections).toBe(1);
        expect(tree().getSelectedPaths()).toEqual([]);
      });
    }
  }

  for (const nextSelection of [null, "unavailable.md"]) {
    it(`does not resurrect the previous leaf on directory selection after selecting ${nextSelection}`, () => {
      view.update(roots(), leaf);
      directory("guides/").collapse();
      view.update(roots(), nextSelection);
      const folder = directory("guides/");
      folder.focus();
      const focusedPath = tree().getFocusedPath();
      expect(focusedPath).not.toBeNull();
      folder.select();
      expect(tree().getSelectedPaths()).toEqual([]);
      expect(folder.isExpanded()).toBe(false);
      expect(tree().getFocusedPath()).toBe(focusedPath);
      expect(selections).toEqual([]);
    });
  }

  it("reveals a changed document additively", () => {
    view.update(roots(), leaf);
    directory("guides/").collapse();
    directory("kept/").expand();
    view.update(roots(), other);
    expect(directory("other/").isExpanded()).toBe(true);
    expect(directory("other/deep/").isExpanded()).toBe(true);
    expect(directory("kept/").isExpanded()).toBe(true);
    expect(directory("guides/").isExpanded()).toBe(false);
    expect(tree().getSelectedPaths()).toEqual([other]);
  });

  it("forwards a library selection after refresh instead of leaving the update guard active", () => {
    view.update(roots(), leaf);
    view.update(roots([...paths, "new.md"]), leaf);
    expect(selections).toEqual([]);
    tree().getItem(leaf)!.deselect();
    tree().getItem(other)!.select();
    expect(selections).toEqual([other]);
    selections.length = 0;
    view.update(roots([...paths, "new.md"]), other);
    expect(tree().getSelectedPaths()).toEqual([other]);
  });

  it("reveals the same document after explicit selection clearing", () => {
    view.update(roots(), leaf);
    directory("guides/").collapse();
    view.update(roots(), null);
    view.update(roots(), leaf);
    expect(directory("guides/").isExpanded()).toBe(true);
    expect(tree().getSelectedPaths()).toEqual([leaf]);
  });

  it("reveals returning A after navigation to unavailable B", () => {
    view.update(roots(), leaf);
    directory("guides/").collapse();
    directory("kept/").expand();
    view.update(roots(), "unavailable.md");
    view.update(roots(), leaf);
    expect(directory("guides/").isExpanded()).toBe(true);
    expect(directory("kept/").isExpanded()).toBe(true);
    expect(tree().getSelectedPaths()).toEqual([leaf]);
  });

  it("routes real-library file clicks exactly once, including selected-file activation and remount", () => {
    const dispatchClick = installClickHarness();
    view.update(roots(), leaf);
    expect(selections).toEqual([]);
    const click = (path: string, properties: Record<string, unknown> = {}) => {
      const row = container.shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${path}"]`)!;
      expect(row).not.toBeNull();
      dispatchClick(row, properties);
    };
    click(leaf);
    expect(selections.splice(0)).toEqual([leaf]);
    click(leaf, { detail: 0 });
    expect(selections.splice(0)).toEqual([leaf]);
    click("guides/deep/sibling.md");
    expect(selections.splice(0)).toEqual(["guides/deep/sibling.md"]);
    click("guides/deep/sibling.md");
    expect(selections.splice(0)).toEqual(["guides/deep/sibling.md"]);
    const oldRow = container.shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${leaf}"]`)!;
    view.dispose();
    dispatchClick(oldRow);
    expect(selections).toEqual([]);
    view.update(roots(), leaf);
    expect(selections).toEqual([]);
    click(leaf);
    expect(selections.splice(0)).toEqual([leaf]);
  });

  it("does not bridge modified, cancelled, secondary, or nested-control clicks", () => {
    const dispatchClick = installClickHarness();
    view.update(roots(), leaf);
    const row = container.shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${leaf}"]`)!;
    // Isolate the bridge's exclusions from Pierre's independent modified-click
    // selection policy by dispatching the bubble phase directly at the shadow.
    const shadow = container.shadowRoot!;
    for (const properties of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }, { button: 2 }, { cancelled: true }]) {
      dispatchClick(row, properties, shadow);
    }
    expect(selections).toEqual([]);
    const input = document.createElement("input");
    row.appendChild(input);
    dispatchClick(input, {}, shadow);
    expect(selections).toEqual([]);
    dispatchClick(row, {}, shadow);
    expect(selections.splice(0)).toEqual([leaf]);
  });

  it("keeps a surviving ancestor collapsed when a represented same-path selection returns", () => {
    view.update(roots(), leaf);
    directory("guides/").collapse();
    view.update(roots(paths.filter(path => path !== leaf)), leaf);
    expect(directory("guides/").isExpanded()).toBe(false);
    view.update(roots(), leaf);
    expect(directory("guides/").isExpanded()).toBe(false);
    expect(tree().getSelectedPaths()).toEqual([leaf]);
    directory("guides/").expand();
    expect(tree().getItem(leaf)?.isSelected()).toBe(true);
  });

  it("reveals a different unavailable selection when it first becomes represented", () => {
    const missing = paths.filter(path => path !== other);
    view.update(roots(missing), leaf);
    directory("kept/").expand();
    view.update(roots(missing), other);
    view.update(roots(), other);
    expect(directory("other/").isExpanded()).toBe(true);
    expect(directory("other/deep/").isExpanded()).toBe(true);
    expect(directory("kept/").isExpanded()).toBe(true);
    expect(tree().getSelectedPaths()).toEqual([other]);
  });

  it("reveals a changed resolved path even when document identity is unchanged", () => {
    view.update(roots(paths, { [leaf]: "stable-id" }), "stable-id");
    const moved = "moved/deep/active.md";
    view.update(roots(paths.map(path => path === leaf ? moved : path), { [moved]: "stable-id" }), "stable-id");
    expect(directory("moved/").isExpanded()).toBe(true);
    expect(directory("moved/deep/").isExpanded()).toBe(true);
    expect(tree().getSelectedPaths()).toEqual([moved]);
  });

  it("reveals a changed document identity even at the same tree path", () => {
    view.update(roots(), leaf);
    directory("guides/").collapse();
    view.update(roots(paths, { [leaf]: "replacement-id" }), "replacement-id");
    expect(directory("guides/").isExpanded()).toBe(true);
    expect(tree().getSelectedPaths()).toEqual([leaf]);
  });

  it("clears mounted state on disposal and reveals on a fresh mount", () => {
    view.update(roots(), leaf);
    directory("guides/").collapse();
    const mounted = tree();
    view.dispose();
    expect(container.__pierreFileTree).toBeUndefined();
    expect(view.getVisibleLeafCount()).toBe(0);
    expect(view.getVisibleBinaryLeafCount()).toBe(0);
    view.update(roots(), leaf);
    expect(tree()).not.toBe(mounted);
    expect(directory("guides/").isExpanded()).toBe(true);
    expect(tree().getSelectedPaths()).toEqual([leaf]);
  });
});

function makeRoot(overrides: Partial<RootGroup> & { id: string; label: string; docs: RootGroup["docs"] }): RootGroup {
  return {
    path: `/tmp/${overrides.id}`,
    hiddenCount: 0,
    ...overrides,
  };
}

describe("buildPathInputs", () => {
  it("does not prefix paths with the root label when there is a single root", () => {
    const root = makeRoot({
      id: "r1",
      label: "myproject",
      docs: [
        {
          id: "/abs/myproject/README.md",
          name: "README.md",
          relativePath: "README.md",
          mtimeMs: 0,
          rootId: "r1",
          kind: "markdown",
        },
        {
          id: "/abs/myproject/src/index.ts",
          name: "index.ts",
          relativePath: "src/index.ts",
          mtimeMs: 0,
          rootId: "r1",
          kind: "text",
        },
      ],
    });

    const { paths, mapping, rootPrefix } = buildPathInputs([root]);
    // Single-root: paths are taken verbatim, so top-level files show at the
    // top of the tree (matches VS Code's single-folder workspace UX).
    expect(paths).toEqual(["README.md", "src/index.ts"]);
    expect(mapping.get("README.md")).toBe("/abs/myproject/README.md");
    expect(mapping.get("src/index.ts")).toBe("/abs/myproject/src/index.ts");
    expect(rootPrefix.get("r1")).toBe("");
  });

  it("prefixes every file with the root label when there are multiple roots", () => {
    const left = makeRoot({
      id: "r1",
      label: "docs",
      docs: [
        {
          id: "/a/docs/a.md",
          name: "a.md",
          relativePath: "a.md",
          mtimeMs: 0,
          rootId: "r1",
          kind: "markdown",
        },
      ],
    });
    const right = makeRoot({
      id: "r2",
      label: "site",
      docs: [
        {
          id: "/b/site/b.md",
          name: "b.md",
          relativePath: "b.md",
          mtimeMs: 0,
          rootId: "r2",
          kind: "markdown",
        },
      ],
    });

    const { paths, rootPrefix } = buildPathInputs([left, right]);
    expect(paths).toEqual(["docs/a.md", "site/b.md"]);
    expect(rootPrefix.get("r1")).toBe("docs/");
    expect(rootPrefix.get("r2")).toBe("site/");
  });

  it("disambiguates duplicate labels with a numeric suffix in multi-root mode", () => {
    const left = makeRoot({
      id: "r1",
      label: "docs",
      docs: [
        {
          id: "/a/docs/a.md",
          name: "a.md",
          relativePath: "a.md",
          mtimeMs: 0,
          rootId: "r1",
          kind: "markdown",
        },
      ],
    });
    const right = makeRoot({
      id: "r2",
      label: "docs",
      docs: [
        {
          id: "/b/docs/b.md",
          name: "b.md",
          relativePath: "b.md",
          mtimeMs: 0,
          rootId: "r2",
          kind: "markdown",
        },
      ],
    });

    const { paths, rootPrefix } = buildPathInputs([left, right]);
    expect(paths).toEqual(["docs/a.md", "docs (2)/b.md"]);
    expect(rootPrefix.get("r1")).toBe("docs/");
    expect(rootPrefix.get("r2")).toBe("docs (2)/");
  });

  it("falls back to 'root' when a multi-root label is blank", () => {
    const left = makeRoot({
      id: "r1",
      label: "   ",
      docs: [
        {
          id: "/nameless/README.md",
          name: "README.md",
          relativePath: "README.md",
          mtimeMs: 0,
          rootId: "r1",
          kind: "markdown",
        },
      ],
    });
    const right = makeRoot({
      id: "r2",
      label: "other",
      docs: [
        {
          id: "/other/README.md",
          name: "README.md",
          relativePath: "README.md",
          mtimeMs: 0,
          rootId: "r2",
          kind: "markdown",
        },
      ],
    });
    const { paths } = buildPathInputs([left, right]);
    expect(paths).toEqual(["root/README.md", "other/README.md"]);
  });

  it("strips a leading slash from relativePath if present (defensive)", () => {
    const root = makeRoot({
      id: "r1",
      label: "proj",
      docs: [
        {
          id: "/abs/proj/README.md",
          name: "README.md",
          relativePath: "/README.md",
          mtimeMs: 0,
          rootId: "r1",
          kind: "markdown",
        },
      ],
    });
    const { paths } = buildPathInputs([root]);
    expect(paths).toEqual(["README.md"]);
  });

  it("returns empty paths and an empty mapping when there are no roots", () => {
    const { paths, mapping, rootPrefix } = buildPathInputs([]);
    expect(paths).toEqual([]);
    expect(mapping.size).toBe(0);
    expect(rootPrefix.size).toBe(0);
  });
});

describe("ancestorPaths", () => {
  it("returns each ancestor directory from outermost to innermost, trailing slash", () => {
    expect(ancestorPaths("a/b/c/leaf.md")).toEqual(["a/", "a/b/", "a/b/c/"]);
  });

  it("returns an empty array for a top-level file (no ancestors)", () => {
    expect(ancestorPaths("README.md")).toEqual([]);
  });

  it("returns an empty array for an empty input", () => {
    expect(ancestorPaths("")).toEqual([]);
  });

  it("handles a single nested directory", () => {
    expect(ancestorPaths("src/index.ts")).toEqual(["src/"]);
  });

  it("handles multi-root-prefixed paths consistently", () => {
    expect(ancestorPaths("myproject/src/index.ts")).toEqual(["myproject/", "myproject/src/"]);
  });
});

describe("computeFilteredPaths", () => {
  const root = makeRoot({
    id: "r1",
    label: "proj",
    docs: [
      {
        id: "/abs/proj/README.md",
        name: "README.md",
        relativePath: "README.md",
        mtimeMs: 0,
        rootId: "r1",
        kind: "markdown",
      },
      {
        id: "/abs/proj/src/auth/login.ts",
        name: "login.ts",
        relativePath: "src/auth/login.ts",
        mtimeMs: 0,
        rootId: "r1",
        kind: "text",
      },
      {
        id: "/abs/proj/src/auth/oauth.ts",
        name: "oauth.ts",
        relativePath: "src/auth/oauth.ts",
        mtimeMs: 0,
        rootId: "r1",
        kind: "text",
      },
      {
        id: "/abs/proj/docs/glossary.md",
        name: "glossary.md",
        relativePath: "docs/glossary.md",
        mtimeMs: 0,
        rootId: "r1",
        kind: "markdown",
      },
    ],
  });

  it("keeps only docs in the allow-list plus their ancestor directories", () => {
    const filter: FilesPaneFilterMembership = {
      allowedByRoot: new Map([["r1", new Set(["src/auth/login.ts", "docs/glossary.md"])]]),
    };
    const { rootPrefix } = buildPathInputs([root]);
    const { paths, ancestors } = computeFilteredPaths([root], rootPrefix, filter);
    expect(new Set(paths)).toEqual(new Set(["src/auth/login.ts", "docs/glossary.md"]));
    expect(new Set(ancestors)).toEqual(new Set(["src/", "src/auth/", "docs/"]));
  });

  it("returns empty arrays when no doc matches the allow-list", () => {
    const filter: FilesPaneFilterMembership = {
      allowedByRoot: new Map([["r1", new Set(["nonexistent.md"])]]),
    };
    const { rootPrefix } = buildPathInputs([root]);
    const { paths, ancestors } = computeFilteredPaths([root], rootPrefix, filter);
    expect(paths).toEqual([]);
    expect(ancestors).toEqual([]);
  });

  it("filters every root out when the per-root allow-list is missing", () => {
    const filter: FilesPaneFilterMembership = { allowedByRoot: new Map() };
    const { rootPrefix } = buildPathInputs([root]);
    const { paths } = computeFilteredPaths([root], rootPrefix, filter);
    expect(paths).toEqual([]);
  });

  it("respects multi-root prefixes when the chip's allow-list is per repo-root path", () => {
    const left = makeRoot({
      id: "r1",
      label: "docs",
      docs: [
        {
          id: "/a/docs/intro.md",
          name: "intro.md",
          relativePath: "intro.md",
          mtimeMs: 0,
          rootId: "r1",
          kind: "markdown",
        },
      ],
    });
    const right = makeRoot({
      id: "r2",
      label: "site",
      docs: [
        {
          id: "/b/site/index.md",
          name: "index.md",
          relativePath: "index.md",
          mtimeMs: 0,
          rootId: "r2",
          kind: "markdown",
        },
      ],
    });
    const filter: FilesPaneFilterMembership = {
      allowedByRoot: new Map([["r2", new Set(["index.md"])]]),
    };
    const { rootPrefix } = buildPathInputs([left, right]);
    const { paths } = computeFilteredPaths([left, right], rootPrefix, filter);
    expect(paths).toEqual(["site/index.md"]);
  });

  it("ignores any allow-list path not present in the doc list (defensive)", () => {
    const filter: FilesPaneFilterMembership = {
      allowedByRoot: new Map([["r1", new Set(["README.md", "ghost.md"])]]),
    };
    const { rootPrefix } = buildPathInputs([root]);
    const { paths, ancestors } = computeFilteredPaths([root], rootPrefix, filter);
    expect(paths).toEqual(["README.md"]);
    expect(ancestors).toEqual([]);
  });
});

describe("computeFilesPaneFilterMembership", () => {
  function makeChange(path: string, status = "M"): ChangedFileSummary {
    return { path, oldPath: null, status, additions: 0, deletions: 0, hunks: 0 };
  }

  function makeRepo(overrides: {
    id: string;
    watchedRootIds: string[];
    snapshot: Partial<Pick<RepositorySnapshot, "status" | "changedFiles" | "gitIgnoredFiles">>;
  }): RepositorySnapshot {
    return {
      id: overrides.id,
      rootPath: `/tmp/${overrides.id}`,
      label: overrides.id,
      watchedRootIds: overrides.watchedRootIds,
      metadata: {
        id: overrides.id,
        rootPath: `/tmp/${overrides.id}`,
        label: overrides.id,
        watchedRootIds: overrides.watchedRootIds,
        status: "git",
        branch: "main",
        detached: false,
        commitShort: null,
        dirty: false,
        message: null,
      },
      status: "available",
      base: { mode: "fallback", ref: "main", mergeBase: null, compareTarget: "base", comparedAgainstRef: "main", targetsCollapsed: false },
      changedFiles: [],
      gitIgnoredFiles: [],
      configWarnings: [],
      message: null,
      commitLog: [],
      ...overrides.snapshot,
    };
  }

  it("collects changedFiles per repo, keyed by watched-root id", () => {
    const repo = makeRepo({
      id: "r1",
      watchedRootIds: ["root-1"],
      snapshot: {
        changedFiles: [makeChange("src/app.ts", "M"), makeChange("README.md", "?")],
      },
    });
    const membership = computeFilesPaneFilterMembership([repo]);
    const set = membership.allowedByRoot.get("root-1");
    expect(set).toBeDefined();
    expect(set).toEqual(new Set(["src/app.ts", "README.md"]));
  });

  it("excludes gitIgnoredFiles from the change set", () => {
    const repo = makeRepo({
      id: "r1",
      watchedRootIds: ["root-1"],
      snapshot: {
        changedFiles: [makeChange("src/app.ts", "M")],
        gitIgnoredFiles: [".claude/settings.local.json"],
      },
    });
    const membership = computeFilesPaneFilterMembership([repo]);
    const set = membership.allowedByRoot.get("root-1") ?? new Set();
    expect(set.has("src/app.ts")).toBe(true);
    expect(set.has(".claude/settings.local.json")).toBe(false);
  });

  it("skips repositories whose change data is not available", () => {
    const repo = makeRepo({
      id: "r1",
      watchedRootIds: ["root-1"],
      snapshot: { status: "non-git", changedFiles: [makeChange("README.md", "M")] },
    });
    const membership = computeFilesPaneFilterMembership([repo]);
    expect(membership.allowedByRoot.size).toBe(0);
  });

  it("strips a leading slash on incoming paths so the allow-set matches normalised doc paths", () => {
    const repo = makeRepo({
      id: "r1",
      watchedRootIds: ["root-1"],
      snapshot: {
        changedFiles: [makeChange("/src/app.ts", "M"), makeChange("/dist/bundle.js", "M")],
      },
    });
    const membership = computeFilesPaneFilterMembership([repo]);
    const set = membership.allowedByRoot.get("root-1") ?? new Set();
    expect(set.has("src/app.ts")).toBe(true);
    expect(set.has("/src/app.ts")).toBe(false);
    expect(set.has("dist/bundle.js")).toBe(true);
  });

  it("fans out one repository's change set to every watched-root id it owns", () => {
    const repo = makeRepo({
      id: "r1",
      watchedRootIds: ["root-a", "root-b"],
      snapshot: { changedFiles: [makeChange("shared.ts", "M")] },
    });
    const membership = computeFilesPaneFilterMembership([repo]);
    expect(membership.allowedByRoot.get("root-a")).toEqual(new Set(["shared.ts"]));
    expect(membership.allowedByRoot.get("root-b")).toEqual(new Set(["shared.ts"]));
  });
});

describe("reconcileFilterExpansion", () => {
  it("snapshots the user's currently-expanded set when transitioning All → Changed", () => {
    const result = reconcileFilterExpansion({
      previousFilterKind: "all",
      nextFilterKind: "changed",
      autoExpanded: ["src/", "src/auth/"],
      currentlyExpanded: ["src/", "tests/", "docs/guides/"],
      storedSnapshot: null,
    });
    expect(result.initialExpandedPaths).toEqual(["src/", "src/auth/"]);
    expect(result.nextSnapshot).toEqual(["src/", "tests/", "docs/guides/"]);
  });

  it("restores the snapshot as initial expansion when transitioning Changed → All", () => {
    const result = reconcileFilterExpansion({
      previousFilterKind: "changed",
      nextFilterKind: "all",
      autoExpanded: ["src/"],
      currentlyExpanded: null,
      storedSnapshot: ["src/", "tests/", "docs/guides/"],
    });
    // Snapshot directories restored alongside the new auto-expand reveal,
    // deduplicated and in first-seen order.
    expect(result.initialExpandedPaths).toEqual(["src/", "tests/", "docs/guides/"]);
    // Snapshot is consumed on restore so a subsequent All → Changed → All
    // cycle without further user expansion does not double-feed stale dirs.
    expect(result.nextSnapshot).toBeNull();
  });

  it("does not lose user-opened directories across All → Changed → All", () => {
    const after_all_to_changed = reconcileFilterExpansion({
      previousFilterKind: "all",
      nextFilterKind: "changed",
      autoExpanded: ["src/", "src/auth/"],
      currentlyExpanded: ["src/", "src/auth/oauth/", "tests/"],
      storedSnapshot: null,
    });
    const after_changed_to_all = reconcileFilterExpansion({
      previousFilterKind: "changed",
      nextFilterKind: "all",
      autoExpanded: [],
      currentlyExpanded: null,
      storedSnapshot: after_all_to_changed.nextSnapshot,
    });
    expect(after_changed_to_all.initialExpandedPaths).toEqual([
      "src/",
      "src/auth/oauth/",
      "tests/",
    ]);
  });

  it("passes the auto-expand reveal through unchanged on same-kind transitions", () => {
    const stayAll = reconcileFilterExpansion({
      previousFilterKind: "all",
      nextFilterKind: "all",
      autoExpanded: ["docs/"],
      currentlyExpanded: null,
      storedSnapshot: null,
    });
    expect(stayAll.initialExpandedPaths).toEqual(["docs/"]);
    expect(stayAll.nextSnapshot).toBeNull();

    const stayChanged = reconcileFilterExpansion({
      previousFilterKind: "changed",
      nextFilterKind: "changed",
      autoExpanded: ["src/auth/"],
      currentlyExpanded: null,
      storedSnapshot: ["src/", "docs/guides/"],
    });
    expect(stayChanged.initialExpandedPaths).toEqual(["src/auth/"]);
    // Snapshot is preserved across same-kind transitions so the next
    // Changed → All edge can still restore it.
    expect(stayChanged.nextSnapshot).toEqual(["src/", "docs/guides/"]);
  });

  it("falls back to bare auto-expand when no snapshot exists on Changed → All", () => {
    const result = reconcileFilterExpansion({
      previousFilterKind: "changed",
      nextFilterKind: "all",
      autoExpanded: ["src/"],
      currentlyExpanded: null,
      storedSnapshot: null,
    });
    expect(result.initialExpandedPaths).toEqual(["src/"]);
    expect(result.nextSnapshot).toBeNull();
  });
});
