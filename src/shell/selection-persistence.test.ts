import { afterEach, beforeEach, expect, test } from "bun:test";
import { appState } from "./state";
import { clearDocumentSelection, resumeDocumentSelection, setSelectedId } from "./selection";
import { readSelectionCleared, writeSelectionCleared } from "./selection-storage";
import { enablePersonalStatePersistence, flushPersonalWorkspaceState, loadPersonalWorkspaceState, parsePersonalWorkspaceState, resetPersonalStateForTests, setPersonalStateFetchForTests } from "./personal-state";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const initialSelectedId = appState.selectedId;
const initialSelectionCleared = appState.selectionCleared;

beforeEach(() => {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
    },
    addEventListener() {},
    removeEventListener() {},
  } });
});

afterEach(() => {
  resetPersonalStateForTests();
  appState.selectedId = initialSelectedId;
  appState.selectionCleared = initialSelectionCleared;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("the browser marker is not a Hub personal-state field", () => {
  expect(parsePersonalWorkspaceState({ version: 1, selectionCleared: true })).toEqual({ version: 1 });
});

test("close synchronously records browser intent and only clears existing Hub destination/Follow fields", async () => {
  const patches: unknown[] = [];
  setPersonalStateFetchForTests(async (_input, init) => {
    if (init?.method === "PATCH") patches.push(JSON.parse(String(init.body)));
    return Response.json({ version: 1 });
  });
  await loadPersonalWorkspaceState();
  enablePersonalStatePersistence();
  clearDocumentSelection();
  expect(readSelectionCleared()).toBe(true);
  await flushPersonalWorkspaceState();
  expect(patches).toEqual([{ documentPath: null, follow: false }]);
  resumeDocumentSelection(); // Follow-on must work even with no files
  expect(readSelectionCleared()).toBe(false);
  await flushPersonalWorkspaceState();
  expect(patches).toHaveLength(1);
  expect(appState.selectionCleared).toBe(false);
});

test("background selection and commit clearing never erase another tab's browser intent", () => {
  setSelectedId("/docs/a.md", "navigation");
  writeSelectionCleared(true); // another tab closes a document
  expect(appState.selectionCleared).toBe(false); // no forced change to this tab
  setSelectedId("/docs/a.md");
  expect(readSelectionCleared()).toBe(true);
  setSelectedId("/docs/b.md"); // Follow's background selection
  expect(readSelectionCleared()).toBe(true);
  setSelectedId(null); // commit navigation has no document selection
  expect(readSelectionCleared()).toBe(true);
});

test("explicit same-file and new-file navigation clear browser intent", () => {
  setSelectedId("/docs/a.md", "navigation");
  for (const id of ["/docs/a.md", "/docs/b.md"]) {
    writeSelectionCleared(true);
    setSelectedId(id, "navigation");
    expect(readSelectionCleared()).toBe(false);
    expect(appState.selectionCleared).toBe(false);
  }
});

test("read-only restoration cannot write Hub fields, but user navigation after enabling can", async () => {
  const roots = appState.roots;
  const patches: unknown[] = [];
  setPersonalStateFetchForTests(async (_input, init) => {
    if (init?.method === "PATCH") patches.push(JSON.parse(String(init.body)));
    return Response.json({ version: 1 });
  });
  try {
    await loadPersonalWorkspaceState();
    clearDocumentSelection();
    await flushPersonalWorkspaceState();
    expect(patches).toEqual([]);
    enablePersonalStatePersistence();
    appState.roots = [{ id: "docs", label: "docs", path: "/docs", hiddenCount: 0, docs: [
      { id: "/docs/a.md", rootId: "docs", name: "a.md", relativePath: "a.md", kind: "markdown", mtimeMs: 1 },
    ] }];
    setSelectedId("/docs/a.md", "navigation");
    await flushPersonalWorkspaceState();
    expect(patches).toEqual([{ documentPath: "a.md" }]);
    expect(readSelectionCleared()).toBe(false);
  } finally {
    appState.roots = roots;
  }
});

test("a watcher frame re-confirming the held selection does not re-save it over another client's newer choice", async () => {
  const roots = appState.roots;
  const patches: unknown[] = [];
  setPersonalStateFetchForTests(async (_input, init) => {
    if (init?.method === "PATCH") patches.push(JSON.parse(String(init.body)));
    return Response.json({ version: 1 });
  });
  try {
    await loadPersonalWorkspaceState();
    appState.roots = [{ id: "docs", label: "docs", path: "/docs", hiddenCount: 0, docs: [
      { id: "/docs/a.md", rootId: "docs", name: "a.md", relativePath: "a.md", kind: "markdown", mtimeMs: 1 },
      { id: "/docs/b.md", rootId: "docs", name: "b.md", relativePath: "b.md", kind: "markdown", mtimeMs: 2 },
    ] }];
    // Boot restores a.md read-only, then the page becomes interactive.
    setSelectedId("/docs/a.md");
    enablePersonalStatePersistence();
    // Its live frames (the stream's first snapshot, any file event) keep the
    // selection where it is. Meanwhile another client saved b.md; these
    // frames must not put a.md back as the newest choice.
    setSelectedId("/docs/a.md");
    setSelectedId("/docs/a.md");
    await flushPersonalWorkspaceState();
    expect(patches).toEqual([]);
    // A real move is saved, whatever drove it (Follow's switch included) ...
    setSelectedId("/docs/b.md");
    await flushPersonalWorkspaceState();
    expect(patches).toEqual([{ documentPath: "b.md" }]);
    // ... and so is the user activating the document already shown.
    setSelectedId("/docs/b.md", "navigation");
    await flushPersonalWorkspaceState();
    expect(patches).toEqual([{ documentPath: "b.md" }, { documentPath: "b.md" }]);
  } finally {
    appState.roots = roots;
  }
});
