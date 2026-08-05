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
