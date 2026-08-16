import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseHTML } from "linkedom";

import { appState } from "../shell/state";
import {
  findSurfaceRoot,
  noteInteraction,
  resolveSurfaceFromTarget,
  setActiveSurface,
  surfaceForRoot,
  surfaceForTab,
} from "./active-surface";

// The live listener binding is exercised end-to-end in tests/e2e/find.e2e.ts.
// Here we cover the resolution rules — which interaction implies which
// surface — plus the structural guarantee that no selection path can reach
// the setter.

// A fragment mirroring the app shell's surface roots.
function shellOf(): Document {
  const { document } = parseHTML(
    `<!doctype html><html><body>
      <div class="app-shell">
        <aside class="sidebar">
          <div class="sidebar-mode-row"><button id="follow-toggle">Follow</button></div>
          <div class="pane-body"><div id="tree"></div></div>
        </aside>
        <div id="sidebar-resizer" class="sidebar-resizer"></div>
        <button id="sidebar-expand" class="sidebar-rail"></button>
        <div class="main-stack">
          <main class="preview-shell" tabindex="-1">
            <!-- Nested inside the shell, exactly as in index.html — that
                 nesting is what made the bar claim the preview surface. -->
            <div id="find-bar" class="find-bar">
              <div class="find-bar-inner"><input id="find-query" /></div>
            </div>
            <article id="preview" class="preview"><p id="para">text</p></article>
          </main>
          <section id="chat-surface"><textarea id="chat-input"></textarea></section>
          <section id="terminal-panel" class="terminal-panel">
            <div class="terminal-pane"><textarea id="term-input"></textarea></div>
          </section>
        </div>
      </div>
      <!-- Outside .app-shell and every surface root, exactly as in
           index.html — which is why a tap on it resolved to no surface. -->
      <nav id="touch-tab-bar" class="touch-tab-bar" role="tablist">
        <button id="touch-tab-files" data-tab="files"><svg id="files-glyph"></svg></button>
        <button id="touch-tab-preview" data-tab="preview"><svg id="preview-glyph"></svg></button>
        <button id="touch-tab-chat" data-tab="chat"><svg id="chat-glyph"></svg></button>
        <button id="touch-tab-terminal" data-tab="terminal"><svg id="terminal-glyph"></svg></button>
      </nav>
    </body></html>`,
  );
  return document as unknown as Document;
}

describe("findSurfaceRoot", () => {
  test("locates the root an interaction landed in", () => {
    const document = shellOf();
    expect(findSurfaceRoot(document.querySelector("#para"))).toBe("preview");
    expect(findSurfaceRoot(document.querySelector("#chat-input"))).toBe("chat");
    expect(findSurfaceRoot(document.querySelector("#term-input"))).toBe("terminal");
    expect(findSurfaceRoot(document.querySelector("#tree"))).toBe("sidebar");
  });

  test("the collapsed sidebar's expand rail counts as sidebar", () => {
    const document = shellOf();
    expect(findSurfaceRoot(document.querySelector("#sidebar-expand"))).toBe("sidebar");
  });

  test("the find bar is chrome, not a surface", () => {
    // It is nested inside the preview shell for layout reasons. Without an
    // explicit exclusion, focusing its query box claimed `preview` — so
    // opening find over the terminal silently reassigned the surface and the
    // next ⌘F searched the document instead.
    const document = shellOf();
    expect(findSurfaceRoot(document.querySelector("#find-query"))).toBeNull();
    expect(findSurfaceRoot(document.querySelector("#find-bar"))).toBeNull();
  });

  test("opening find over the terminal leaves the terminal active", () => {
    const document = shellOf();
    setActiveSurface("terminal");
    noteInteraction(document.querySelector("#find-query"));
    expect(appState.activeSurface).toBe("terminal");
  });

  test("chrome outside every surface resolves to no root", () => {
    const document = shellOf();
    expect(findSurfaceRoot(document.querySelector("#sidebar-resizer"))).toBeNull();
    expect(findSurfaceRoot(null)).toBeNull();
  });

  test("a non-element target has no ancestry to consult", () => {
    const document = shellOf();
    expect(findSurfaceRoot(document as unknown as EventTarget)).toBeNull();
  });
});

describe("surfaceForRoot", () => {
  test("the sidebar is not a find target — it resolves to the preview", () => {
    // The product rule: directing the sidebar is an act about the document it
    // is directing, so ⌘F after a tree click searches the document.
    expect(surfaceForRoot("sidebar")).toBe("preview");
  });

  test("preview and terminal map to themselves", () => {
    expect(surfaceForRoot("preview")).toBe("preview");
    expect(surfaceForRoot("terminal")).toBe("terminal");
  });

  test("no root implies no surface", () => {
    expect(surfaceForRoot(null)).toBeNull();
  });
});

describe("noteInteraction", () => {
  test("claims the surface the interaction landed in", () => {
    const document = shellOf();
    setActiveSurface("preview");
    noteInteraction(document.querySelector("#term-input"));
    expect(appState.activeSurface).toBe("terminal");
  });

  test("a tree click while working in the terminal returns find to the preview", () => {
    const document = shellOf();
    setActiveSurface("terminal");
    noteInteraction(document.querySelector("#tree"));
    expect(appState.activeSurface).toBe("preview");
  });

  test("interaction outside every surface leaves the current one standing", () => {
    const document = shellOf();
    setActiveSurface("terminal");
    noteInteraction(document.querySelector("#sidebar-resizer"));
    expect(appState.activeSurface).toBe("terminal");
  });
});

describe("resolveSurfaceFromTarget", () => {
  test("composes root lookup with the sidebar rule", () => {
    const document = shellOf();
    expect(resolveSurfaceFromTarget(document.querySelector("#follow-toggle"))).toBe("preview");
    expect(resolveSurfaceFromTarget(document.querySelector("#term-input"))).toBe("terminal");
    expect(resolveSurfaceFromTarget(document.querySelector("#sidebar-resizer"))).toBeNull();
  });
});

describe("surfaceForTab", () => {
  // Touch mode presents one surface at a time, so the active tab decides
  // where find acts. The claim is made from a committed tab change (wired in
  // initActiveSurfaceTracking), NOT from a tab-bar DOM event: the bar sits
  // outside every surface root, `pointerdown`/`focusin` fire before its click
  // commits, and the terminal panel changes tabs from call sites of its own
  // (Ctrl/Cmd+`, Escape, leaving fullscreen) that produce no bar event at all.
  test("the Terminal tab is its own surface", () => {
    expect(surfaceForTab("terminal")).toBe("terminal");
  });

  test("Preview is the preview surface", () => {
    expect(surfaceForTab("preview")).toBe("preview");
  });

  test("Chat is the chat surface", () => {
    expect(surfaceForTab("chat")).toBe("chat");
  });

  test("Files is the preview surface — the sidebar directs the document", () => {
    // Same product rule `surfaceForRoot` applies to the sidebar root.
    expect(surfaceForTab("files")).toBe("preview");
  });
});

describe("the tab bar is not resolved as a surface root", () => {
  // It is app chrome outside every root; claiming from a tap here is what the
  // committed-tab-change subscription replaced.
  test("a tab button resolves to no surface", () => {
    const document = shellOf();
    expect(resolveSurfaceFromTarget(document.querySelector("#touch-tab-preview"))).toBeNull();
    expect(resolveSurfaceFromTarget(document.querySelector("#preview-glyph"))).toBeNull();
  });

  test("a tap on the bar leaves the current surface standing", () => {
    const document = shellOf();
    setActiveSurface("terminal");
    noteInteraction(document.querySelector("#touch-tab-preview"));
    expect(appState.activeSurface).toBe("terminal");
  });
});

describe("a committed tab change claims its surface", () => {
  // This is the half no tab-bar DOM event can cover, and the reason the claim
  // moved off `pointerdown`: the terminal panel changes tabs from its own call
  // sites — Ctrl/Cmd+`, Escape, leaving fullscreen, boot fallbacks — none of
  // which produce a tab-bar event, so the surface used to go stale on every
  // one of them. Driven through the real `setActiveTab` rather than by calling
  // the listener directly, so the subscription itself is what's under test.
  test("switching tabs with no tab-bar event still moves the surface", async () => {
    const savedDocument = Reflect.get(globalThis, "document");
    const savedWindow = Reflect.get(globalThis, "window");
    const store = new Map<string, string>();
    Reflect.set(globalThis, "document", {
      documentElement: { setAttribute: () => {} },
      addEventListener: () => {},
    });
    Reflect.set(globalThis, "window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        get length() {
          return store.size;
        },
        key: (index: number) => [...store.keys()][index] ?? null,
      },
      // Coarse pointer => touch mode, where the tab decides the surface.
      matchMedia: () => ({ matches: true }),
    });
    try {
      const { initActiveSurfaceTracking } = await import("./active-surface");
      const { setActiveTab } = await import("../shell/tab-bar");
      initActiveSurfaceTracking();

      setActiveTab("terminal");
      expect(appState.activeSurface).toBe("terminal");

      // The regression: leaving Terminal this way fires no tab-bar event.
      setActiveTab("preview");
      expect(appState.activeSurface).toBe("preview");

      setActiveTab("files");
      expect(appState.activeSurface).toBe("preview");
    } finally {
      Reflect.set(globalThis, "document", savedDocument);
      Reflect.set(globalThis, "window", savedWindow);
    }
  });
});

describe("inertness against programmatic selection", () => {
  // Follow-mode Rules C/D re-select from file-watcher events. The guarantee
  // that a background file change cannot relocate the user's working context
  // is structural — there is no code path from the watcher to the setter — so
  // it is asserted structurally rather than by simulating a file event.
  const SRC_ROOT = path.resolve(import.meta.dir, "..");
  const SELECTION_MODULES = [
    "shell/follow.ts",
    "shell/selection.ts",
    "shell/events.ts",
    "sidebar/tree-view.ts",
    "sidebar/tree-mount.ts",
  ];

  test("no selection or file-event module imports the surface setter", () => {
    const offenders = SELECTION_MODULES.filter(relative => {
      const contents = readFileSync(path.join(SRC_ROOT, relative), "utf8");
      return contents.includes("setActiveSurface") || contents.includes("noteInteraction");
    });
    expect(offenders).toEqual([]);
  });

  // A committed touch-tab change now claims its surface too, so the tab is a
  // second route to the setter and the same modules must not reach it either.
  test("no file-event module reaches the active tab either", () => {
    const offenders = SELECTION_MODULES.filter(relative => relative !== "shell/follow.ts").filter(
      relative => {
        const contents = readFileSync(path.join(SRC_ROOT, relative), "utf8");
        return contents.includes("setActiveTab") || contents.includes("revealPreviewSurface");
      },
    );
    expect(offenders).toEqual([]);
  });

  test("follow.ts reaches the tab exactly once — the Rule A chokepoint", () => {
    // follow.ts is the one exemption above because it owns BOTH Rule A (user
    // row click, which legitimately brings the Preview surface forward) and
    // Rules C/D (file events, which must not). Pinning the call count is what
    // stops a second call site being added on a watcher path later.
    const contents = readFileSync(path.join(SRC_ROOT, "shell/follow.ts"), "utf8");
    expect(contents.match(/revealPreviewSurface\(\)/g) ?? []).toHaveLength(1);
    expect(contents).not.toContain("setActiveTab");
  });

  test("the setter is reachable only from this module's user-event listeners", () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(absolute);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
          continue;
        }
        const relative = path.relative(SRC_ROOT, absolute).split(path.sep).join("/");
        if (relative === "find/active-surface.ts") {
          continue;
        }
        if (readFileSync(absolute, "utf8").includes("setActiveSurface")) {
          callers.push(relative);
        }
      }
    };
    walk(SRC_ROOT);
    expect(callers).toEqual([]);
  });
});
