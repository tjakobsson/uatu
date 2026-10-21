// createDashboardGroups() reshapes the dashboard's already-rendered rows
// (built by pages.ts's row()) into repository groups. It never builds a row
// itself — only regroups, chips and captions the ones it is handed — so
// these tests hand it small hand-built rows shaped the way pages.ts's row()
// shapes them (a .row-title it replaces, a .row-actions it reads buttons
// out of) and assert on the resulting DOM and its own stylesheet text.

import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";

import { createDashboardGroups, dashboardGroupsStyle } from "./dashboard-groups";

type Workspace = {
  id: string;
  displayName?: string;
  branch?: string;
  detached?: boolean;
  parentId?: string;
  repositoryId?: string;
  running: boolean;
  createWorktree?: boolean;
  availability?: "missing" | "replaced";
};

function setup() {
  const { document, window } = parseHTML(
    '<html><body><section><h2></h2><div id="sessions"></div></section><section><h2></h2><div id="workspaces"></div></section></body></html>',
  );
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  const render = createDashboardGroups();
  const row = (id: string, label: string, withFork: boolean) => {
    const node = document.createElement("div");
    node.className = "row";
    node.dataset.workspace = id;
    const title = document.createElement("div");
    title.className = "row-title";
    const link = document.createElement("a");
    link.textContent = label;
    title.append(link);
    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (withFork) {
      const fork = document.createElement("button");
      fork.setAttribute("aria-label", `Add worktree to ${label}`);
      actions.append(fork);
    }
    node.append(title, actions);
    return node;
  };
  return { document, render, row };
}

describe("W8 the repository heading band has a background in both schemes", () => {
  test("uses a token defined in the Hub's own SHARED_STYLE, not the undefined --surface-hover", () => {
    expect(dashboardGroupsStyle).toContain(".dashboard-group-heading{background:var(--surface-muted)}");
    expect(dashboardGroupsStyle).not.toContain("--surface-hover");
  });
});

describe("W10 the 'Main checkout' chip and fork wording are truthful about createWorktree", () => {
  test("a real repository main checkout (createWorktree true) keeps 'Main checkout' and the fork wording", () => {
    const { document, render, row } = setup();
    const main = row("atlas", "Atlas", true);
    document.getElementById("sessions")!.append(main);
    const workspaces: Workspace[] = [{ id: "atlas", displayName: "Atlas", branch: "main", running: false, createWorktree: true }];
    render(workspaces, new Map([["atlas", main]]));
    const chip = main.querySelector(".chip")!;
    expect(chip.textContent).toBe("Main checkout");
    const summary = document.querySelector("#workspaces summary")!;
    expect(summary.textContent).toContain("expand to Start or fork");
  });

  // W10: registering a linked worktree folder on its own through Add
  // workspace is a supported path (its .git is a FILE, so the Hub never
  // sets createWorktree) — it must never be labelled as this repository's
  // main checkout, and the collapsed summary must not promise a fork
  // control the expanded group does not have.
  test("a standalone-registered linked worktree (createWorktree false/undefined) is never chipped 'Main checkout'", () => {
    const { document, render, row } = setup();
    const standalone = row("orbit-desktop-standalone", "orbit-desktop-standalone", false);
    document.getElementById("sessions")!.append(standalone);
    const workspaces: Workspace[] = [{ id: "orbit-desktop-standalone", displayName: "orbit-desktop-standalone", branch: "feature/x", running: false, createWorktree: false }];
    render(workspaces, new Map([["orbit-desktop-standalone", standalone]]));
    const chip = standalone.querySelector(".chip")!;
    expect(chip.textContent).toBe("Linked checkout");
    expect(chip.textContent).not.toBe("Main checkout");
    const summary = document.querySelector("#workspaces summary")!;
    expect(summary.textContent).toContain("expand to Start");
    expect(summary.textContent).not.toContain("or fork");
  });

  test("createWorktree undefined (an unset state) is treated the same as false", () => {
    const { document, render, row } = setup();
    const standalone = row("solo", "solo", false);
    document.getElementById("sessions")!.append(standalone);
    const workspaces: Workspace[] = [{ id: "solo", displayName: "solo", running: false }];
    render(workspaces, new Map([["solo", standalone]]));
    expect(standalone.querySelector(".chip")!.textContent).toBe("Linked checkout");
  });
});

// Issue #504 (demo 04a/06a): once a repository's folder is deleted outside
// Uatu there is no `.git` left, so createWorktree is gone and the main row
// was chipped "Linked checkout". A missing row with registered worktrees
// under it is still their main checkout; one with none left is not claimed
// to be either kind of checkout.
describe("#504 a missing top-level row is never chipped a linked checkout", () => {
  test("a missing main workspace with registered worktrees keeps 'Main checkout' and offers no Start in its summary", () => {
    const { document, render, row } = setup();
    const main = row("atlas", "Atlas", false);
    const child = row("atlas-a", "feature/a", false);
    document.getElementById("workspaces")!.append(main, child);
    const workspaces: Workspace[] = [
      { id: "atlas", displayName: "Atlas", repositoryId: "r", running: false, availability: "missing" },
      { id: "atlas-a", parentId: "atlas", repositoryId: "r", branch: "feature/a", running: false, availability: "missing" },
    ];
    render(workspaces, new Map([["atlas", main], ["atlas-a", child]]));
    expect(main.querySelector(".chip")!.textContent).toBe("Main checkout");
    const summary = document.querySelector('[data-disclosure="atlas-inactive"] > summary')!;
    expect(summary.textContent).toBe("Atlas · folder missing · expand to review");
  });

  test("a missing row with nothing under it carries no checkout chip at all", () => {
    const { document, render, row } = setup();
    const lone = row("atlas", "Atlas", false);
    document.getElementById("workspaces")!.append(lone);
    render([{ id: "atlas", displayName: "Atlas", running: false, availability: "missing" }], new Map([["atlas", lone]]));
    expect(lone.querySelector(".chip")).toBeNull();
    expect(lone.textContent).not.toContain("Linked checkout");
    expect(document.querySelector('[data-disclosure="atlas-inactive"] > summary')!.textContent).toBe("Atlas · folder missing · expand to review");
  });
});

describe("Bug 2 a running main checkout's title stays the link it is on main", () => {
  test("re-labels the existing <a> in place instead of replacing it with plain text", () => {
    const { document, render, row } = setup();
    const main = row("atlas", "Atlas", true);
    // row() gives a running row's title an <a href="/s/<id>/">; simulate
    // that here since this fixture's row() (unlike pages.ts's real row())
    // doesn't set one itself.
    main.querySelector("a")!.setAttribute("href", "/s/atlas/");
    document.getElementById("sessions")!.append(main);
    const workspaces: Workspace[] = [{ id: "atlas", displayName: "Atlas", branch: "main", running: true, createWorktree: true }];
    render(workspaces, new Map([["atlas", main]]));
    const link = main.querySelector<HTMLAnchorElement>(".row-title a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/s/atlas/");
    expect(link!.textContent).toBe("main");
    expect(main.querySelector(".chip")!.textContent).toBe("Main checkout");
  });

  test("a stopped main checkout's <strong> title is re-labeled the same way, never turned into a bare text node", () => {
    const { document, render, row } = setup();
    const main = row("atlas", "Atlas", true);
    // Stopped rows render a <strong>, not an <a> — swap the fixture's <a>
    // for one to mirror row()'s actual stopped-row shape.
    const strong = document.createElement("strong");
    strong.textContent = "Atlas";
    main.querySelector(".row-title")!.replaceChildren(strong);
    document.getElementById("sessions")!.append(main);
    const workspaces: Workspace[] = [{ id: "atlas", displayName: "Atlas", detached: true, running: false, createWorktree: true }];
    render(workspaces, new Map([["atlas", main]]));
    const title = main.querySelector(".row-title strong");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe("Detached HEAD");
  });
});

describe("grouping and disclosure (unchanged behavior, sanity-checked alongside the W10 fix)", () => {
  test("children group under their parent and active repositories are never folded", () => {
    const { document, render, row } = setup();
    const main = row("atlas", "Atlas", true);
    const child = row("atlas-child", "feature/a", false);
    document.getElementById("sessions")!.append(main, child);
    const workspaces: Workspace[] = [
      { id: "atlas", displayName: "Atlas", branch: "main", running: true, createWorktree: true, repositoryId: "repo" },
      { id: "atlas-child", branch: "feature/a", running: false, parentId: "atlas", repositoryId: "repo" },
    ];
    render(workspaces, new Map([["atlas", main], ["atlas-child", child]]));
    expect(document.getElementById("sessions")!.contains(main)).toBe(true);
    expect(document.querySelector('[data-repository="atlas"]')!.contains(child)).toBe(true);
    expect(document.querySelectorAll("#workspaces > details").length).toBe(0);
  });
});
