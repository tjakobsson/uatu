import { describe, expect, test } from "bun:test";

import { ALL_PANE_DEFS, SIDEBAR_PANES_KEY, readPaneState } from "./state";

function storageWith(value: string | null): Pick<Storage, "getItem"> {
  return { getItem: key => (key === SIDEBAR_PANES_KEY ? value : null) };
}

describe("readPaneState defaults", () => {
  test("fresh clients get the lean sidebar: Change Overview + Files on, Git Log and Search off", () => {
    const state = readPaneState(null);
    expect(state["change-overview"].visible).toBe(true);
    expect(state.files.visible).toBe(true);
    expect(state["git-log"].visible).toBe(false);
    expect(state.search.visible).toBe(false);
  });

  test("the retired selection-inspector pane is gone from the catalog", () => {
    expect(ALL_PANE_DEFS.some(pane => (pane.id as string) === "selection-inspector")).toBe(false);
  });
});

describe("readPaneState stored state", () => {
  test("stored arrangements always win over defaults", () => {
    const state = readPaneState(
      storageWith(JSON.stringify({ "git-log": { visible: true, collapsed: false, height: 200 } })),
    );
    expect(state["git-log"].visible).toBe(true);
    expect(state["git-log"].height).toBe(200);
  });

  test("stale entries for retired pane ids are inert and the rest are honored", () => {
    const state = readPaneState(
      storageWith(
        JSON.stringify({
          "selection-inspector": { visible: true, collapsed: false, height: 160 },
          files: { visible: false, collapsed: false, height: null },
        }),
      ),
    );
    expect(state.files.visible).toBe(false);
    expect("selection-inspector" in state).toBe(false);
  });

  test("corrupt JSON and failing storage fall back to defaults", () => {
    expect(readPaneState(storageWith("{not json")).files.visible).toBe(true);
    const throwing: Pick<Storage, "getItem"> = {
      getItem: () => {
        throw new DOMException("storage disabled", "SecurityError");
      },
    };
    expect(readPaneState(throwing)["git-log"].visible).toBe(false);
  });
});
