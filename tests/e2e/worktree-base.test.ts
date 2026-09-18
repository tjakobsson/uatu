import { expect, test } from "bun:test";
import { worktreePage } from "../../src/hub/worktree-pages";
import { WorktreeDemoState } from "./worktree-demo-state";

test("new creation chooses main independently of checkout and records explicit exact base", () => {
  const state = new WorktreeDemoState();
  state.rows[0]!.branch = "feature/current";
  const html = worktreePage(state.presentation("create"), "", "", true);
  expect(html).toContain("Create from");
  expect(html).toContain('name="selection" value="local:main"');
  state.mutate("create", { mode: "new", branch: "feature/defaulted", selection: "local:main" });
  expect(state.rows.at(-1)).toMatchObject({ sourceRef: "main", base: "main", running: false });
  state.mutate("create", { mode: "new", branch: "feature/chosen", selection: "remote:upstream/release" });
  expect(state.rows.at(-1)).toMatchObject({ branch: "feature/chosen", sourceRef: "upstream/release", base: "upstream/release" });
  state.rows[0]!.branch = "release";
  expect(state.rows.at(-1)!.sourceRef).toBe("upstream/release");
});

test("default main prefers local then unique remote, never guesses or resets a draft", () => {
  const state = new WorktreeDemoState(); state.rows[0]!.branch = "feature/current";
  const render = () => worktreePage(state.presentation("create"), "", "", true);
  state.repositoryRemoteRefs.set("repository-atlas", ["origin/main", "upstream/main"]);
  expect(render()).toContain('name="selection" value="local:main"');
  state.repositoryBranches.get("repository-atlas")!.delete("main");
  expect(render()).toContain('name="selection" value=""');
  state.repositoryRemoteRefs.set("repository-atlas", ["origin/main"]);
  expect(render()).toContain('name="selection" value="remote:origin/main"');
  state.draft = { mode: "new", selection: "", query: "edited" };
  expect(render()).toContain('name="selection" value=""');
  state.draft = {}; state.repositoryRemoteRefs.set("repository-atlas", []);
  expect(render()).toContain('name="selection" value=""');
});

test("missing or invalid base is refused and fetch preserves new mode, name and choice", () => {
  const state = new WorktreeDemoState();
  for (const selection of ["", "local:gone", "remote:gone/main"]) {
    state.mutate("create", { mode: "new", branch: "feature/refused", selection });
    expect(state.error).toBe(true); expect(state.rows).toHaveLength(5);
  }
  for (const scenario of ["stale", "fetch-auth", "fetch-network", "fetch-disappearance"] as const) {
    state.reset(scenario);
    state.mutate("fetch", { mode: "new", branch: "feature/draft", selection: "remote:origin/feature/search", query: "origin/feature/search" });
    expect(state.draft).toMatchObject({ mode: "new", branch: "feature/draft", query: "origin/feature/search", selection: scenario === "fetch-disappearance" ? "" : "remote:origin/feature/search" });
  }
});
