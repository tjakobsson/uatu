import { describe, expect, test } from "bun:test";

import {
  chipDotClass,
  parseHubState,
  sortHubWorkspaces,
  submitHubSignOut,
  workspaceIdFromBasePath,
  workspaceMenuDetail,
  workspaceMenuLabel,
} from "./hub-nav";

function summary(id: string, running: boolean, displayName = id, path = "/src/" + id) {
  return { id, displayName, path, running };
}

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
        summary("zeta", false),
        summary("beta", true),
        summary("alpha", false),
        summary("uatu", true),
        summary("gamma", true),
      ],
      "uatu",
    );
    expect(sorted.map(workspace => workspace.id)).toEqual(["uatu", "beta", "gamma", "alpha", "zeta"]);
  });

  test("does not mutate the input", () => {
    const input = [
      summary("b", false),
      summary("a", true),
    ];
    sortHubWorkspaces(input, null);
    expect(input.map(workspace => workspace.id)).toEqual(["b", "a"]);
  });
});

describe("chipDotClass", () => {
  test("live only when the hub reports the current session running", () => {
    expect(chipDotClass([summary("uatu", true)], "uatu")).toBe("indicator-dot is-live");
    expect(chipDotClass([summary("uatu", false)], "uatu")).toBe("indicator-dot");
  });

  test("unknown or absent workspaces read as not running", () => {
    expect(chipDotClass([], "uatu")).toBe("indicator-dot");
    expect(chipDotClass([summary("other", true)], "uatu")).toBe("indicator-dot");
    expect(chipDotClass([summary("uatu", true)], null)).toBe("indicator-dot");
  });
});

describe("parseHubState", () => {
  test("extracts well-formed workspace entries with display names and paths", () => {
    const state = parseHubState({
      workspaces: [
        { id: "uatu", displayName: "Uatu Docs", path: "/src/uatu", running: true },
        { id: "junk" },
      ],
    });
    expect(state).toEqual({ workspaces: [{ id: "uatu", displayName: "Uatu Docs", path: "/src/uatu", running: true }] });
  });

  test("pre-display-name hubs fall back to the id as the label", () => {
    const state = parseHubState({ workspaces: [{ id: "uatu", running: false }] });
    expect(state).toEqual({ workspaces: [{ id: "uatu", displayName: "uatu", path: "", running: false }] });
  });

  test("rejects non-hub payloads", () => {
    expect(parseHubState({ workspaces: [] })).toEqual({ workspaces: [] });
    expect(parseHubState({})).toBeNull();
    expect(parseHubState(null)).toBeNull();
  });
});

describe("workspace menu labels", () => {
  test("labels by display name and sorts by it within groups", () => {
    const workspaces = [
      summary("payments-service", false, "Payments API"),
      summary("api", false, "Billing"),
    ];
    expect(workspaceMenuLabel(workspaces[0]!)).toBe("Payments API");
    expect(sortHubWorkspaces(workspaces, null).map(workspace => workspace.id)).toEqual(["api", "payments-service"]);
  });

  test("duplicate display names get path detail; unique names get none", () => {
    const duplicates = [
      summary("api", true, "API", "/home/a/api"),
      summary("api-2", false, "API", "/home/b/api"),
      summary("docs", false, "Docs"),
    ];
    expect(workspaceMenuDetail(duplicates, duplicates[0]!)).toBe("/home/a/api");
    expect(workspaceMenuDetail(duplicates, duplicates[1]!)).toBe("/home/b/api");
    expect(workspaceMenuDetail(duplicates, duplicates[2]!)).toBeNull();
  });

  test("a duplicate without a path falls back to the stable id", () => {
    const duplicates = [
      summary("api", true, "API", ""),
      summary("api-2", false, "API", ""),
    ];
    expect(workspaceMenuDetail(duplicates, duplicates[1]!)).toBe("api-2");
  });
});

describe("submitHubSignOut", () => {
  // A minimal stand-in for the pieces of Document this touches; the unit
  // suite runs without a DOM.
  function fakeDocument() {
    const form: Record<string, unknown> & { submitted: boolean } = { submitted: false };
    form.submit = () => {
      form.submitted = true;
    };
    const appended: unknown[] = [];
    const doc = {
      createElement: (tag: string) => {
        form.tag = tag;
        return form;
      },
      body: { appendChild: (node: unknown) => appended.push(node) },
    };
    return { doc: doc as unknown as Document, form, appended };
  }

  test("posts a form to the hub's origin-rooted logout route", () => {
    const { doc, form } = fakeDocument();
    submitHubSignOut(doc);
    expect(form.tag).toBe("form");
    expect(form.method).toBe("post");
    // Origin-rooted on purpose: a session lives under /s/<id>/ but the hub's
    // logout route is at the origin root.
    expect(form.action).toBe("/logout");
  });

  test("submits a hidden form attached to the document", () => {
    const { doc, form, appended } = fakeDocument();
    submitHubSignOut(doc);
    // A detached form does not submit, and a visible one would flash.
    expect(form.hidden).toBe(true);
    expect(appended).toEqual([form]);
    expect(form.submitted).toBe(true);
  });
});
