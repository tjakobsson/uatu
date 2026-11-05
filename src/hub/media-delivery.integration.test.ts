import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NotificationFeed } from "../chat/notification-feed";
import { MetricsRegistry } from "../debug/metrics";
import { buildRoutes, type RouteAssets } from "../server/routes";
import { startMediaHttpBoundary } from "../server/media-http-boundary";
import { createWatchSession, type WatchSession } from "../server/watch-session";
import { mediaUrl as sharedMediaUrl } from "../shared/media";
import type { RevisionedDocument } from "../shared/document-updates";
import type { DocumentMeta } from "../shared/types";
import { HubSessionStore, hubCookieName } from "./auth";
import { EMPTY_CREDENTIAL_CONTEXT_RESOLVER } from "./credential-context";
import { SseFrameParser } from "./live-sse";
import { PersonalWorkspaceStateStore } from "./personal-state";
import { WorkspaceRegistry } from "./registry";
import { startHubServer } from "./server";
import { SessionManager } from "./sessions";

// Real shared routes and WatchSession behind the normal authenticated Hub.
// The child's own file-read and handle counters measure socket read-ahead
// without wrapping, teeing, or draining its response for observation.
const credential = "synthetic-private-media-credential";
const basePath = "/s/project/";
const MiB = 1024 * 1024;
let directory = "", first = "", second = "", origin = "", cookie = "", bearer = "";
let watch: WatchSession;
let child: ReturnType<typeof Bun.serve>;
let hub: ReturnType<typeof startHubServer>;
let sessions: SessionManager;
let mediaRoute: { GET(request: Request): Promise<Response>; HEAD(request: Request): Promise<Response> };
const feed = new NotificationFeed();
const metrics = new MetricsRegistry();

async function generatedFile(file: string, size: number) {
  const handle = await open(file, "w");
  try {
    // Sparse, generated data avoids allocating an export-sized test buffer.
    await handle.truncate(size);
    await handle.write(new Uint8Array([1, 2, 3, 4]), 0, 4, 0);
    await handle.write(new Uint8Array([5, 6, 7, 8]), 0, 4, size - 4);
  } finally { await handle.close(); }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "uatu-hub-media-")));
  first = path.join(directory, "project"); second = path.join(directory, "other");
  for (const root of [first, second]) {
    await mkdir(path.join(root, "build/renders"), { recursive: true });
    await writeFile(path.join(root, ".uatu.json"), JSON.stringify({ ignore: { include: ["build/renders"], exclude: ["private.wav"] } }));
    await writeFile(path.join(root, ".gitignore"), "build/\n");
    await writeFile(path.join(root, "private.wav"), "must not cross Hub");
    await writeFile(path.join(root, ".env.wav"), "secret fixture");
  }
  const git = Bun.spawn(["git", "init", "-q"], { cwd: first, stdout: "ignore", stderr: "ignore" });
  expect(await git.exited).toBe(0);
  await writeFile(path.join(first, "build/renders/same.wav"), new Uint8Array([11, 12, 13, 14, 15, 16, 17, 18]));
  await writeFile(path.join(second, "build/renders/same.wav"), new Uint8Array([21, 22, 23, 24, 25, 26, 27, 28]));
  await generatedFile(path.join(first, "build/renders/large.wav"), 64 * MiB);
  await generatedFile(path.join(first, "build/renders/larger.wav"), 512 * MiB);
  watch = createWatchSession([{ kind: "dir", absolutePath: first }, { kind: "dir", absolutePath: second }], false, { metrics });
  await watch.start();
  await waitFor(() => [path.join(first, "build/renders/larger.wav"), path.join(first, "build/renders/large.wav"),
    ...[first, second].map(root => path.join(root, "build/renders/same.wav"))].every(file => !!watch.findDocument(file)), "media discovery");
  const assets: RouteAssets = {
    mermaid: "unused", logo: "unused", icon192: "unused", icon512: "unused", manifest: "unused",
    fonts: { hackMono: "unused", hackLicense: "unused", nerdFontsLicense: "unused", notices: "unused" },
  };
  const routes = buildRoutes({ mode: "prod", basePath, assets, getSession: () => watch,
    chatService: { notificationFeed: feed } as never, getWorkspaceCredential: () => credential,
    debug: false, getMetricsSnapshot: () => ({}),
  });
  mediaRoute = routes[`${basePath}api/media`] as typeof mediaRoute;
  if (!mediaRoute) throw new Error("shared GET/HEAD /api/media route is required");
  const inner = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, routes,
    fetch(request) { boundary.normalizeRequest(request); return new Response(null, { status: 404 }); },
  });
  const boundary = startMediaHttpBoundary({ server: inner, hostname: "127.0.0.1", port: 0,
    isMediaRequest: request => new URL(request.url).pathname === `${basePath}api/media`,
    fetch: request => request.method === "HEAD" ? mediaRoute.HEAD(request) : mediaRoute.GET(request),
  });
  await boundary.ready;
  child = boundary.server;
  const registry = new WorkspaceRegistry(path.join(directory, "registry.json"));
  await registry.load(); await registry.register(first);
  sessions = new SessionManager(registry, { local: { start: async (workspace, basePath) => ({
    workspaceId: workspace.id, basePath, instanceId: crypto.randomUUID(), policyTrust: "unavailable",
    endpoint: { hostname: "127.0.0.1", port: child.port! }, token: credential,
    exited: new Promise(() => {}), stop: async () => {},
  }) } }, EMPTY_CREDENTIAL_CONTEXT_RESOLVER);
  await sessions.start("project");
  const sessionStore = new HubSessionStore(path.join(directory, "sessions.json"));
  const personalState = new PersonalWorkspaceStateStore(path.join(directory, "personal.json"));
  await personalState.load();
  bearer = (await sessionStore.issue("media-user", "synthetic test device")).id;
  hub = startHubServer({ config: { host: "127.0.0.1", port: 0, tls: null, stateDir: directory,
    users: [{ name: "media-user", passwordHash: "unused" }] }, registry, sessions, sessionStore, personalState });
  origin = `http://127.0.0.1:${hub.port}`;
  cookie = `${hubCookieName(new URL(origin))}=${bearer}`;
}, 20_000);

afterAll(async () => {
  hub?.live.endAll(); hub?.liveBroker.dispose();
  await hub?.cloneJobs.close(); await sessions?.stopAll();
  await hub?.stop(true); await child?.stop(true); await watch?.stop(); feed.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function doc(root: string, name = "same.wav"): DocumentMeta {
  const value = watch.findDocument(path.join(root, "build/renders", name));
  if (!value) throw new Error(`missing indexed fixture ${name}`);
  return value;
}

function mediaUrl(value: DocumentMeta): URL {
  return new URL(`${basePath}${sharedMediaUrl(value as RevisionedDocument, watch.getStatePayload().epoch).slice(1)}`, origin);
}

function get(url: URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie); headers.set("accept-encoding", "gzip");
  return fetch(url, { ...init, headers });
}

describe("authenticated Hub media delivery", () => {
  test("normal authentication and child credential brokering preserve both roots and byte-range metadata", async () => {
    const url = mediaUrl(doc(first));
    const before = metrics.get("media.read_calls_total");
    expect((await fetch(url, { redirect: "manual" })).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer invalid" }, redirect: "manual" })).status).toBe(401);
    for (const foreign of ["https://foreign.example", "null"]) {
      const refused = await get(url, { headers: { origin: foreign } });
      expect(refused.status).toBe(403); await refused.body?.cancel();
    }
    expect(metrics.get("media.read_calls_total")).toBe(before);
    // A browser cannot select the child's credential. Hub replaces this value.
    url.searchParams.set("t", "forged-child-token");
    for (const [root, start] of [[first, 11], [second, 21]] as const) {
      const selected = root === first ? url : mediaUrl(doc(root));
      const response = await get(selected);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/wav");
      expect(response.headers.get("content-length")).toBe("8");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(JSON.stringify([...response.headers])).not.toContain(credential);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(Array.from({ length: 8 }, (_, i) => start + i));
    }
    for (const [range, expected, contentRange] of [
      ["bytes=2-4", [13, 14, 15], "bytes 2-4/8"],
      ["bytes=5-", [16, 17, 18], "bytes 5-7/8"],
      ["bytes=-2", [17, 18], "bytes 6-7/8"],
    ] as const) {
      const response = await fetch(url, { headers: { authorization: `Bearer ${bearer}`, range, "accept-encoding": "gzip" } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(response.headers.get("content-length")).toBe(String(expected.length));
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("content-type")).toBe("audio/wav");
      expect(response.headers.get("content-encoding")).toBeNull();
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...expected]);
    }
    const head = await get(url, { method: "HEAD", headers: { range: "bytes=2-4" } });
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe("8");
    expect(head.headers.get("content-range")).toBeNull(); expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(head.headers.get("content-type")).toBe("audio/wav"); expect(await head.text()).toBe("");
    const unsatisfiable = await get(url, { headers: { range: "bytes=99-" } });
    expect(unsatisfiable.status).toBe(416); expect(unsatisfiable.headers.get("content-range")).toBe("bytes */8");
    expect(unsatisfiable.headers.get("content-length")).toBe("0");
    expect(await unsatisfiable.text()).toBe("");
    await waitFor(() => doc(first).gitIgnoreStatus === "ignored", "ignored export classification");
    // Browsing visibility is not an exposure restriction.
    const hidden = mediaUrl(doc(first)); hidden.searchParams.set("showIgnored", "0");
    const allowed = await get(hidden); expect(allowed.status).toBe(200); await allowed.body?.cancel();
    for (const denied of ["private.wav", ".env.wav", "build/objects/no.wav", "../other/build/renders/same.wav"]) {
      const target = mediaUrl(doc(first)); target.searchParams.set("path", denied);
      const refused = await get(target); expect(refused.status).toBeGreaterThanOrEqual(400); await refused.body?.cancel();
    }
  });

  test("a large streamed representation retains its full Content-Length through HTTP", async () => {
    const abort = new AbortController();
    try {
      const direct = mediaUrl(doc(first, "large.wav"));
      direct.host = `127.0.0.1:${child.port}`; direct.searchParams.set("t", credential);
      const routeResponse = await mediaRoute.GET(new Request(direct));
      const declaredLength = routeResponse.headers.get("content-length");
      await routeResponse.body?.cancel();
      const childResponse = await fetch(direct, { signal: abort.signal });
      const childLength = childResponse.headers.get("content-length");
      await childResponse.body?.cancel();
      await waitFor(() => metrics.get("media.open_handles") === 0, "direct child probe release");
      const response = await get(mediaUrl(doc(first, "large.wav")), { signal: abort.signal });
      expect(response.status).toBe(200);
      // Name each boundary in failures so a missing child header cannot be
      // mistaken for a Hub header-filtering problem.
      expect({ route: declaredLength, childHTTP: childLength, hubHTTP: response.headers.get("content-length") }).toEqual({
        route: String(64 * MiB), childHTTP: String(64 * MiB), hubHTTP: String(64 * MiB),
      });
      expect(response.headers.get("content-encoding")).toBeNull();
      await response.body?.cancel();
    } finally {
      abort.abort();
      await waitFor(() => metrics.get("media.open_handles") === 0, "large metadata probe release");
    }
  });

  test("slow large exports have finite read-ahead, release on replacement/Close/abort, and do not stall live or control", async () => {
    const liveAbort = new AbortController();
    const live = await fetch(`${origin}/api/hub/live?ws=project&subs=${encodeURIComponent('[{"topic":"document","key":""}]')}`, {
      headers: { cookie }, signal: liveAbort.signal,
    });
    expect(live.status).toBe(200);
    const liveReader = live.body!.getReader();
    const frames: string[] = [], parser = new SseFrameParser();
    const pump = (async () => {
      try {
        for (;;) {
          const next = await liveReader.read(); if (next.done) return;
          for (const frame of parser.push(next.value)) if (!("comment" in frame)) frames.push(frame.data);
        }
      } catch { /* Test closes the page's live connection. */ }
    })();
    const aborts: AbortController[] = [];
    try {
      await waitFor(() => frames.some(frame => frame.includes('"kind":"snapshot"')), "brokered document snapshot");
      for (const [name, departure] of [["large.wav", "replace clip"], ["larger.wav", "Close"], ["larger.wav", "leave workspace"]] as const) {
        const bytesBefore = metrics.get("media.read_bytes_total"), callsBefore = metrics.get("media.read_calls_total");
        const abort = new AbortController(); aborts.push(abort);
        const response = await get(mediaUrl(doc(first, name)), { signal: abort.signal });
        expect(response.status).toBe(200); expect(response.headers.get("content-encoding")).toBeNull();
        const reader = response.body!.getReader();
        expect((await reader.read()).value!.byteLength).toBeGreaterThan(0);
        const transfer = {
          get bytes() { return metrics.get("media.read_bytes_total") - bytesBefore; },
          get reads() { return metrics.get("media.read_calls_total") - callsBefore; },
          get active() { return metrics.get("media.transfers_active") > 0; },
        };
        let last = -1, unchanged = 0;
        await waitFor(() => {
          unchanged = last === transfer.bytes ? unchanged + 1 : 0; last = transfer.bytes;
          return unchanged >= 10;
        }, "backpressure to stop child reads");
        // Same budget for files eight times apart in size, including both
        // HTTP stacks' socket queues. No export-sized accumulation is allowed.
        expect(transfer.active).toBe(true);
        expect(transfer.bytes).toBeLessThan(32 * MiB);
        expect(transfer.reads).toBeLessThan(1024);
        expect(metrics.get("media.open_handles")).toBe(1);
        const readsBeforeControl = transfer.reads;
        const fileReadsBeforeControl = metrics.get("media.read_calls_total");
        const marker = `live-during-${departure}.md`;
        await writeFile(path.join(first, marker), "# independent live progress\n");
        const control = await get(new URL(`${basePath}api/state`, origin));
        expect(control.status).toBe(200); expect((await control.json()).epoch).toBe(watch.getStatePayload().epoch);
        await waitFor(() => frames.some(frame => frame.includes(marker)), "live patch while media is stalled");
        expect(transfer.reads).toBe(readsBeforeControl);
        expect(metrics.get("media.read_calls_total")).toBe(fileReadsBeforeControl);
        // Source replacement and Close release the body's reader. Leaving the
        // page instead aborts its outstanding HTTP request.
        if (departure === "leave workspace") abort.abort();
        else await reader.cancel(departure);
        await waitFor(() => !transfer.active, "abandoned child delivery release");
        await waitFor(() => metrics.get("media.open_handles") === 0 && metrics.get("media.transfers_active") === 0, "child media handle release");
        if (departure === "replace clip") {
          const replacement = await get(mediaUrl(doc(second)), { headers: { range: "bytes=0-1" } });
          expect(replacement.status).toBe(206); expect([...new Uint8Array(await replacement.arrayBuffer())]).toEqual([21, 22]);
        }
      }
      expect(liveAbort.signal.aborted).toBe(false);
    } finally {
      for (const abort of aborts) abort.abort();
      liveAbort.abort(); await liveReader.cancel().catch(() => undefined); await pump;
    }
  }, 30_000);

  test("a detected file replacement interrupts old delivery and a stale seek remains 409/no-store", async () => {
    const selected = doc(first, "larger.wav"), old = { ...selected }, url = mediaUrl(old);
    const abort = new AbortController();
    try {
      const response = await get(url, { signal: abort.signal });
      const reader = response.body!.getReader(); await reader.read();
      const replacement = path.join(first, "build/renders/replacement.tmp");
      await generatedFile(replacement, 512 * MiB);
      await rename(replacement, selected.id);
      await waitFor(() => doc(first, "larger.wav").revision !== old.revision, "replacement revision");
      await waitFor(() => metrics.get("media.transfers_active") === 0 && metrics.get("media.open_handles") === 0, "old revision invalidation");
      const stale = await get(url, { headers: { range: "bytes=0-3" } });
      expect(stale.status).toBe(409); expect(stale.headers.get("cache-control")).toContain("no-store");
      expect(stale.headers.get("content-length")).toBe("0");
      expect(stale.headers.get("content-range")).toBeNull(); await stale.body?.cancel();
      const fresh = await get(mediaUrl(doc(first, "larger.wav")), { headers: { range: "bytes=0-3" } });
      expect(fresh.status).toBe(206); expect([...new Uint8Array(await fresh.arrayBuffer())]).toEqual([1, 2, 3, 4]);
      // Drain only the bounded bytes already queued before invalidation. The
      // old HTTP response must fail rather than claim a successful full file.
      let drained = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        (async () => {
          try {
            for (;;) {
              const next = await reader.read(); if (next.done) return "completed";
              drained += next.value.byteLength;
              if (drained > 32 * MiB) return "read-ahead budget exceeded";
            }
          } catch { return "failed"; }
        })(),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve("timed out"), 3000); }),
      ]).finally(() => clearTimeout(timer));
      expect(outcome).toBe("failed");
      expect(drained).toBeLessThan(32 * MiB);
      await reader.cancel().catch(() => undefined);
    } finally { abort.abort(); }
  }, 20_000);
});
