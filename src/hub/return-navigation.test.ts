import { describe, expect, test } from "bun:test";
import { createReturnNavigation, type ReturnWorkspace } from "./return-navigation";

const key = "uatu.hub.return.v1";
const workspace = { id: "a", displayName: "Shared", path: "/a", running: true };
function fixture() {
  const values = new Map<string, string>();
  const changes: Array<ReturnWorkspace | null> = [];
  let handle = "session-a";
  let workspaces = [workspace];
  const reads: string[] = [];
  const options = {
    fetch: async (url: string) => {
      reads.push(url);
      return Response.json(url.endsWith("/state") ? { workspaces } : { sessions: [{ handle, current: true }] });
    },
    storage: () => ({ getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => { values.set(name, value); }, removeItem: (name: string) => { values.delete(name); } }),
    changed: (value: ReturnWorkspace | null) => { changes.push(value); },
    timeout: 20,
  };
  return { values, reads, changes, options, session: (value: string) => { handle = value; }, catalog: (value: typeof workspaces) => { workspaces = value; } };
}

describe("browsing-session Return", () => {
  test("an independent context never invents a visit from the catalog", async () => {
    const f = fixture();
    expect(await createReturnNavigation(f.options).validate()).toBeNull();
    expect(f.reads).toEqual([]);
    expect(f.values.size).toBe(0);
  });
  test("only a running confirmed visit writes id and non-secret session handle", async () => {
    const f = fixture();
    const nav = createReturnNavigation(f.options);
    expect(await nav.validate("a")).toEqual(workspace);
    expect(JSON.parse(f.values.get(key)!)).toEqual({ version: 1, workspaceId: "a", sessionHandle: "session-a" });
    f.catalog([{ ...workspace, running: false }]);
    expect(await nav.validate("a")).toBeNull();
    expect(f.values.has(key)).toBe(true);
    f.values.clear();
    expect(await nav.validate("a")).toBeNull();
    expect(f.values.size).toBe(0);
  });
  test("copied genuine hints require new reads; rename and stopped state remain truthful", async () => {
    const f = fixture();
    await createReturnNavigation(f.options).validate("a");
    f.catalog([{ ...workspace, displayName: "Renamed", running: false }]);
    const copy = createReturnNavigation(f.options);
    expect(copy.current()).toBeNull();
    expect(await copy.validate()).toEqual({ ...workspace, displayName: "Renamed", running: false });
    expect(f.reads).toHaveLength(4);
  });
  test("different or expired authentication sessions and removed registrations clear metadata", async () => {
    const f = fixture();
    await createReturnNavigation(f.options).validate("a");
    f.session("new-login");
    expect(await createReturnNavigation(f.options).validate()).toBeNull();
    expect(f.values.has(key)).toBe(false);
    const nav = createReturnNavigation(f.options);
    await nav.validate("a");
    f.catalog([]);
    expect(await nav.validate()).toBeNull();
    expect(f.values.has(key)).toBe(false);
  });
  test("invalid records cannot expose labels", async () => {
    for (const record of [{}, { version: 1, workspaceId: "a" }, { version: 1, workspaceId: 5, sessionHandle: "session-a" }]) {
      const f = fixture();
      f.values.set(key, JSON.stringify(record));
      expect(await createReturnNavigation(f.options).validate()).toBeNull();
      expect(f.values.has(key)).toBe(false);
      expect(f.changes.every(value => value === null)).toBe(true);
    }
  });
  test("both reads start concurrently and the combined deadline includes hanging bodies", async () => {
    const f = fixture();
    const reads: string[] = [];
    const nav = createReturnNavigation({ ...f.options, fetch: async url => {
      reads.push(url);
      return { ok: true, status: 200, json: () => new Promise(() => {}) } as unknown as Response;
    } });
    const result = nav.validate("a");
    expect(reads).toEqual(["/api/hub/state", "/api/hub/sessions"]);
    expect(await result).toBeNull();
    expect(nav.current()).toBeNull();
    expect(f.values.size).toBe(0);
  });
  test("timeout does not cancel a shared Hub refresh or accept its late result", async () => {
    const f = fixture();
    let resolve!: (value: unknown) => void;
    const state = new Promise(r => { resolve = r; });
    const nav = createReturnNavigation(f.options);
    expect(await nav.validate("a", state)).toBeNull();
    resolve({ workspaces: [workspace] });
    await Promise.resolve();
    expect(f.values.size).toBe(0);
    expect(f.reads).toEqual(["/api/hub/sessions"]);
  });
  test("logout and supersession prevent delayed success from reviving a hint", async () => {
    for (const invalidate of [true, false]) {
      const f = fixture();
      let resolve!: (value: unknown) => void;
      const state = new Promise(r => { resolve = r; });
      const nav = createReturnNavigation(f.options);
      const attempt = nav.validate("a", state);
      if (invalidate) nav.invalidate();
      else nav.suspend();
      resolve({ workspaces: [workspace] });
      expect(await attempt).toBeNull();
      expect(f.values.size).toBe(0);
    }
  });
  test("401 invalidates even when the other read later succeeds", async () => {
    const f = fixture();
    await createReturnNavigation(f.options).validate("a");
    const nav = createReturnNavigation({ ...f.options, fetch: async () => new Response(null, { status: 401 }) });
    expect(await nav.validate()).toBeNull();
    expect(f.values.size).toBe(0);
  });
  test("malformed session snapshots invalidate a previously genuine hint", async () => {
    for (const sessions of [{}, null, [], [{ current: true }]]) {
      const f = fixture();
      await createReturnNavigation(f.options).validate("a");
      const nav = createReturnNavigation({ ...f.options, fetch: async url => Response.json(url.endsWith("/state") ? { workspaces: [workspace] } : { sessions }) });
      expect(await nav.validate()).toBeNull();
      expect(f.values.size).toBe(0);
    }
  });
  test("unavailable storage never blocks the caller or fabricates inherited context", async () => {
    const f = fixture();
    const nav = createReturnNavigation({ ...f.options, storage: () => { throw new Error("denied"); } });
    expect(await nav.validate()).toBeNull();
    expect(await nav.validate("a")).toEqual(workspace);
  });
  test("the production HTML serialization runs without module bindings", async () => {
    const factory = new Function(`return (${createReturnNavigation.toString()});`)() as typeof createReturnNavigation;
    expect(await factory(fixture().options).validate("a")).toEqual(workspace);
  });
});
