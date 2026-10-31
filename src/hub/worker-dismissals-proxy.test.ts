import { afterEach, expect, test } from "bun:test";
import type { RunningSession } from "./backend";
import { proxyHttp } from "./proxy";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(true); });
function session(server: ReturnType<typeof Bun.serve>): RunningSession {
  return { workspaceId: "ws", instanceId: "synthetic", basePath: "/s/ws/", policyTrust: "unavailable", token: "synthetic", endpoint: { hostname: "127.0.0.1", port: server.port! }, exited: new Promise(() => {}), stop: async () => {} };
}
const request = () => new Request("http://hub.invalid/s/ws/api/chat/conversations/opencode%3Aparent?cursor=old");

test("snapshot tap preserves incremental delivery and exact bytes despite observer failure", async () => {
  let finish!: () => void;
  const prefix = '{"conversation":{"id":"opencode:parent"},"items":[';
  const suffix = '{"type":"question","id":"canonical","status":"pending"}]}';
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
      finish = () => { controller.enqueue(new TextEncoder().encode(suffix)); controller.close(); };
    } }), { headers: { "content-type": "application/json" } });
  } }); servers.push(server);
  let observed = 0;
  const response = await proxyHttp(request(), session(server), undefined, (parent, snapshot) => {
    observed++; expect(parent).toBe("opencode:parent");
    expect((snapshot as { items: unknown[] }).items).toEqual([{ type: "question", id: "canonical", status: "pending" }]);
    throw new Error("synthetic private storage failure");
  });
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toBe(prefix); expect(observed).toBe(0);
  finish(); let rest = "";
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
  expect(first + rest).toBe(prefix + suffix); expect(observed).toBe(1);
});

test("oversized snapshot tap remains transparent and cancellation releases the existing upstream", async () => {
  let cancelled!: () => void; const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
  let mode = "large";
  const large = JSON.stringify({ text: "x".repeat(4 * 1024 * 1024) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    if (mode === "large") return new Response(large, { headers: { "content-type": "application/json" } });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"items":[')); }, cancel() { cancelled(); } }), { headers: { "content-type": "application/json" } });
  } }); servers.push(server);
  let observations = 0;
  const observer = () => { observations++; };
  expect(await (await proxyHttp(request(), session(server), undefined, observer)).text()).toBe(large);
  expect(observations).toBe(0);
  mode = "cancel";
  const response = await proxyHttp(request(), session(server), undefined, observer);
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
  await cancellation;
  expect(observations).toBe(0);
});
