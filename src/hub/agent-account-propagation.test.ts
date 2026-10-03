import { describe, expect, test } from "bun:test";

import type { RunningSession } from "./backend";
import { createAccountChangeNotifier } from "./agent-account-propagation";

function running(workspaceId: string, port: number): RunningSession {
  return {
    workspaceId,
    basePath: `/s/${workspaceId}/`,
    endpoint: { hostname: "127.0.0.1", port },
    token: `tok-${workspaceId}`,
    exited: new Promise<number | null>(() => undefined),
    stop: async () => undefined,
  };
}

describe("account change notification", () => {
  test("every running workspace receives the change on its internal route, with its brokered token and loopback origin", async () => {
    const sessions = new Map([["a", running("a", 4001)], ["b", running("b", 4002)]]);
    const calls: Array<{ url: string; origin: string | null; body: unknown }> = [];
    const notify = createAccountChangeNotifier({
      sessions: { runningIds: () => [...sessions.keys()], get: id => sessions.get(id) },
      fetch: async (url, init) => {
        calls.push({ url: url.toString(), origin: new Headers(init.headers).get("origin"), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }));
      },
    });
    await notify("opencode", { kind: "removed", target: "groq", credential: "groq" });
    expect(calls.sort((x, y) => x.url.localeCompare(y.url))).toEqual([
      { url: "http://127.0.0.1:4001/s/a/api/chat/accounts-changed?t=tok-a", origin: "http://127.0.0.1:4001", body: { agentId: "opencode", change: { kind: "removed", target: "groq", credential: "groq" } } },
      { url: "http://127.0.0.1:4002/s/b/api/chat/accounts-changed?t=tok-b", origin: "http://127.0.0.1:4002", body: { agentId: "opencode", change: { kind: "removed", target: "groq", credential: "groq" } } },
    ]);
  });

  test("one failing workspace does not stop the others or fail the notification", async () => {
    const sessions = new Map([["a", running("a", 4001)], ["b", running("b", 4002)]]);
    const reached: string[] = [];
    const notify = createAccountChangeNotifier({
      sessions: { runningIds: () => [...sessions.keys()], get: id => sessions.get(id) },
      fetch: async url => {
        if (url.port === "4001") throw new Error("connection refused");
        reached.push(url.port);
        return new Response("{}");
      },
    });
    await expect(notify("claude", { kind: "added" })).resolves.toBeUndefined();
    expect(reached).toEqual(["4002"]);
  });
});
