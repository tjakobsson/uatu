import { describe, expect, test } from "bun:test";

import { sortHubWorkspaces, workspaceIdFromBasePath } from "./hub-nav";

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
