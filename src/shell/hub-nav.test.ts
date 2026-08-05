import { describe, expect, test } from "bun:test";

import { chipDotClass, parseHubState, sortHubWorkspaces, workspaceIdFromBasePath } from "./hub-nav";

describe("workspaceIdFromBasePath", () => {
  test("extracts the id from a hub-shaped base path", () => {
    expect(workspaceIdFromBasePath("/s/uatu/")).toBe("uatu");
    expect(workspaceIdFromBasePath("/s/my-project-2/")).toBe("my-project-2");
    expect(workspaceIdFromBasePath("/s/sp%20ace/")).toBe("sp ace");
  });

  test("returns null for the default and non-hub-shaped prefixes", () => {
    expect(workspaceIdFromBasePath("/")).toBeNull();
    expect(workspaceIdFromBasePath("/docs/")).toBeNull();
    expect(workspaceIdFromBasePath("/s/")).toBeNull();
    expect(workspaceIdFromBasePath("/s/a/b/")).toBeNull();
    expect(workspaceIdFromBasePath("/s/%GG/")).toBeNull();
  });
});

describe("sortHubWorkspaces", () => {
  test("orders current first, then running, then stopped, alphabetically within groups", () => {
    const sorted = sortHubWorkspaces(
      [
        { id: "zeta", running: false },
        { id: "beta", running: true },
        { id: "alpha", running: false },
        { id: "uatu", running: true },
        { id: "gamma", running: true },
      ],
      "uatu",
    );
    expect(sorted.map(workspace => workspace.id)).toEqual(["uatu", "beta", "gamma", "alpha", "zeta"]);
  });

  test("does not mutate the input", () => {
    const input = [
      { id: "b", running: false },
      { id: "a", running: true },
    ];
    sortHubWorkspaces(input, null);
    expect(input.map(workspace => workspace.id)).toEqual(["b", "a"]);
  });
});

describe("chipDotClass", () => {
  test("live only when the hub reports the current session running", () => {
    expect(chipDotClass([{ id: "uatu", running: true }], "uatu")).toBe("indicator-dot is-live");
    expect(chipDotClass([{ id: "uatu", running: false }], "uatu")).toBe("indicator-dot");
  });

  test("unknown or absent workspaces read as not running", () => {
    expect(chipDotClass([], "uatu")).toBe("indicator-dot");
    expect(chipDotClass([{ id: "other", running: true }], "uatu")).toBe("indicator-dot");
    expect(chipDotClass([{ id: "uatu", running: true }], null)).toBe("indicator-dot");
  });
});

describe("parseHubState", () => {
  test("extracts workspaces and the local-mode flag", () => {
    const state = parseHubState({
      local: true,
      workspaces: [{ id: "uatu", running: true }, { id: "junk" }],
    });
    expect(state).toEqual({ local: true, workspaces: [{ id: "uatu", running: true }] });
  });

  test("defaults local to false and rejects non-hub payloads", () => {
    expect(parseHubState({ workspaces: [] })).toEqual({ local: false, workspaces: [] });
    expect(parseHubState({})).toBeNull();
    expect(parseHubState(null)).toBeNull();
  });
});
