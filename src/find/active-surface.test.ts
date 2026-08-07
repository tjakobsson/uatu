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

describe("the touch tab bar claims the surface it activates", () => {
  // Regression: leaving a parked terminal by tapping Preview changed only
  // `activeTab`. The bar sits outside every surface root, so `activeSurface`
  // stayed `terminal` — and because parked PTYs remain attached, the terminal
  // find engine still reported itself available, so the next ⌘F opened find
  // over the CSS-hidden terminal instead of the visible document.
  test("tapping Preview while the terminal is active claims preview", () => {
    const document = shellOf();
    setActiveSurface("terminal");
    noteInteraction(document.querySelector("#touch-tab-preview"));
    expect(appState.activeSurface).toBe("preview");
  });

  test("tapping Terminal claims terminal", () => {
    const document = shellOf();
    setActiveSurface("preview");
    noteInteraction(document.querySelector("#touch-tab-terminal"));
    expect(appState.activeSurface).toBe("terminal");
  });

  test("tapping Files claims preview — the sidebar directs the document", () => {
    const document = shellOf();
    setActiveSurface("terminal");
    noteInteraction(document.querySelector("#touch-tab-files"));
    expect(appState.activeSurface).toBe("preview");
  });

  test("a tap landing on a tab's glyph resolves like the button itself", () => {
    // Real taps land on the inner <svg>, not the <button>.
    const document = shellOf();
    setActiveSurface("terminal");
    noteInteraction(document.querySelector("#preview-glyph"));
    expect(appState.activeSurface).toBe("preview");
  });

  test("the bar's own chrome claims nothing", () => {
    const document = shellOf();
    setActiveSurface("terminal");
    expect(resolveSurfaceFromTarget(document.querySelector("#touch-tab-bar"))).toBeNull();
    noteInteraction(document.querySelector("#touch-tab-bar"));
    expect(appState.activeSurface).toBe("terminal");
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
