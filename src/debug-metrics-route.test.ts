// Tests the /debug/metrics route shape that cli.ts mounts. We don't go
// through cli.ts directly (full watch session is heavy and out of scope for
// a route test); we replicate the same handler logic in a minimal Bun.serve
// instance so the contract — debug-on returns 200/JSON, debug-off returns
// 404 — is exercised end-to-end.

import { afterEach, describe, expect, test } from "bun:test";

import { MetricsRegistry } from "./debug-metrics";

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

function startServerWithDebug(debug: boolean, registry: MetricsRegistry): string {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    routes: {
      "/debug/metrics": {
        GET: () => {
          if (!debug) {
            return new Response("Not found", { status: 404 });
          }
          return Response.json(registry.snapshot());
        },
      },
    },
    fetch: () => new Response("not implemented", { status: 500 }),
  });
  return `http://${server.hostname}:${server.port}`;
}

describe("/debug/metrics route", () => {
  test("returns 200 with valid JSON when debug is on", async () => {
    const reg = new MetricsRegistry();
    reg.inc("watcher.events_total.add", 3);
    reg.set("refresh.in_flight", 0);
    const origin = startServerWithDebug(true, reg);

    const response = await fetch(`${origin}/debug/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.pid).toBe(process.pid);
    expect(typeof body.takenAtMs).toBe("number");
    expect(body.counters["watcher.events_total.add"]).toBe(3);
    expect(body.counters["refresh.in_flight"]).toBe(0);
  });

  test("returns 404 when debug is off", async () => {
    const reg = new MetricsRegistry();
    reg.inc("foo");
    const origin = startServerWithDebug(false, reg);

    const response = await fetch(`${origin}/debug/metrics`);
    expect(response.status).toBe(404);
  });
});
