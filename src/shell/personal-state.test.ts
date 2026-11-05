import { afterEach, describe, expect, test } from "bun:test";

import {
  enablePersonalStatePersistence,
  flushPersonalWorkspaceState,
  loadPersonalWorkspaceState,
  parsePersonalWorkspaceState,
  persistPersonalWorkspaceState,
  resetPersonalStateForTests,
  setPersonalStateFetchForTests,
} from "./personal-state";

afterEach(() => resetPersonalStateForTests());

describe("personal workspace state client", () => {
  test("accepts all Files views and ignores an invalid view independently", () => {
    for (const filesFilter of ["all", "changed", "recent"] as const) {
      expect(parsePersonalWorkspaceState({ version: 1, filesFilter, follow: false })).toEqual({ version: 1, filesFilter, follow: false });
    }
    expect(parsePersonalWorkspaceState({ version: 1, filesFilter: "bad", follow: false })).toEqual({ version: 1, follow: false });
    expect(parsePersonalWorkspaceState({ version: 1 })).toEqual({ version: 1 });
  });
  test("ignored visibility is boolean and coalesces independently of unrelated fields", async () => {
    expect(parsePersonalWorkspaceState({ version: 1, showIgnored: false, filesFilter: "recent" })).toEqual({ version: 1, showIgnored: false, filesFilter: "recent" });
    expect(parsePersonalWorkspaceState({ version: 1, showIgnored: "false", follow: false })).toEqual({ version: 1, follow: false });
    const bodies: unknown[] = [];
    setPersonalStateFetchForTests(async (_input, init) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return Response.json({ version: 1 });
    });
    await loadPersonalWorkspaceState();
    enablePersonalStatePersistence();
    persistPersonalWorkspaceState({ showIgnored: false });
    persistPersonalWorkspaceState({ filesFilter: "recent" });
    await flushPersonalWorkspaceState();
    expect(bodies).toEqual([{ showIgnored: false, filesFilter: "recent" }]);
  });
  test("validates fields independently", () => {
    expect(parsePersonalWorkspaceState({
      version: 1,
      documentPath: "README.md",
      follow: false,
      previewMode: "bad",
      compareTarget: "last-commit",
      filesFilter: "changed",
    })).toEqual({
      version: 1,
      documentPath: "README.md",
      follow: false,
      compareTarget: "last-commit",
      filesFilter: "changed",
    });
  });

  test("coalesces enabled field updates into one PATCH", async () => {
    const requests: { method?: string; body?: string }[] = [];
    setPersonalStateFetchForTests((async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ method: init?.method, body: init?.body as string | undefined });
      return Response.json({ version: 1 });
    }) as typeof fetch);

    await loadPersonalWorkspaceState();
    enablePersonalStatePersistence();
    persistPersonalWorkspaceState({ follow: false });
    persistPersonalWorkspaceState({ filesFilter: "changed" });
    await flushPersonalWorkspaceState();
    expect(requests).toHaveLength(2);
    expect(JSON.parse(requests[1]!.body!)).toEqual({ follow: false, filesFilter: "changed" });
  });
});
