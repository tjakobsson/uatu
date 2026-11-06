import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, open, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { MetricsRegistry } from "../debug/metrics";
import { terminalCookieName } from "../terminal/auth";
import { buildRoutes } from "./routes";
import { createWatchSession, type WatchSession, type WatchSessionOptions } from "./watch-session";
import type { WatchEntry } from "./roots";
import { MEDIA_CHUNK_BYTES } from "./media-delivery";
import { startMediaHttpBoundary } from "./media-http-boundary";

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function directory() {
  const result = await mkdtemp(path.join(os.tmpdir(), "uatu-media-"));
  cleanup.push(() => rm(result, { recursive: true, force: true })); return result;
}
async function wait(predicate: () => boolean) {
  const end = Date.now() + 6000;
  while (!predicate()) { if (Date.now() > end) throw new Error("media condition timed out"); await Bun.sleep(10); }
}
async function serve(entries: WatchEntry[], basePath = "/", options: WatchSessionOptions = {}) {
  const metrics = new MetricsRegistry();
  let session = createWatchSession(entries, true, { ...options, metrics });
  await session.start();
  const repo = path.resolve(import.meta.dir, "../..");
  const asset = path.join(repo, "src/assets/uatu-logo.svg");
  const routes = buildRoutes({ mode: "prod", basePath, getSession: () => session,
      getWorkspaceCredential: () => "media-secret", chatService: {} as never, debug: false, getMetricsSnapshot: () => metrics.snapshot(),
      assets: { mermaid: asset, logo: asset, icon192: asset, icon512: asset, manifest: asset,
        fonts: { hackMono: asset, hackLicense: asset, nerdFontsLicense: asset, notices: asset } },
    });
  const inner = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    routes,
    fetch: () => new Response(null, { status: 404 }),
  });
  const mediaPath = `${basePath}api/media`;
  const boundary = startMediaHttpBoundary({ server: inner, hostname: "127.0.0.1", port: 0,
    isMediaRequest: request => new URL(request.url).pathname === mediaPath,
    fetch: request => (routes[mediaPath] as { GET(request: Request): Response | Promise<Response>; HEAD(request: Request): Response | Promise<Response> })[request.method as "GET" | "HEAD"](request),
  });
  await boundary.ready;
  const server = boundary.server;
  cleanup.push(async () => { await session.stop(); await server.stop(true); });
  const url = (rootId: string, relativePath: string) => {
    const doc = session.getUnscopedRoots().find(root => root.id === rootId)?.docs.find(doc => doc.relativePath === relativePath);
    if (!doc) throw new Error(`Missing indexed fixture ${relativePath}`);
    const result = new URL(`${basePath}api/media`, server.url);
    result.search = new URLSearchParams({ rootId, path: relativePath, epoch: session.getStatePayload().epoch, revision: String(doc.revision), t: "media-secret" }).toString();
    return result;
  };
  return { get session() { return session; }, metrics, server, url,
    async restart() { await session.stop(); session = createWatchSession(entries, true, { ...options, metrics }); await session.start(); },
  };
}
const root = (absolutePath: string): WatchEntry => ({ kind: "dir", absolutePath });
const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);

async function httpFixture(basePath: string) {
  const dir = await directory(); await writeFile(path.join(dir, "clip.wav"), bytes); await writeFile(path.join(dir, "empty.mp4"), "");
  const app = await serve([root(dir)], basePath);
  return { ...app, dir, url: app.url(dir, "clip.wav"), empty: app.url(dir, "empty.mp4") };
}
const basePaths = ["/", "/s/media/"];

test.each(basePaths)("actual HTTP full response is exact under %s", async basePath => {
  const { url } = await httpFixture(basePath);
  const full = await fetch(url, { headers: { "accept-encoding": "gzip" } });
  expect(full.status).toBe(200); expect(full.headers.get("content-type")).toBe("audio/wav");
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  expect(full.headers.get("cache-control")).toBe("no-store, no-transform"); expect(full.headers.get("content-encoding")).toBeNull();
  expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
  expect(full.headers.get("content-length")).toBe(String(bytes.length));
});

const ranges = [["bytes=10-99", 10, 99], ["bytes=4000-", 4000, 4095], ["bytes=-17", 4079, 4095],
  ["bytes=4090-999999999999999999999999", 4090, 4095], ["bytes=-999999999999999999999999", 0, 4095]] as const;
test.each(basePaths.flatMap(base => ranges.map(([range, start, end]) => ({ base, range, start, end }))))("actual HTTP partial response %j", async ({ base, range, start, end }) => {
  const { url } = await httpFixture(base);
  const response = await fetch(url, { headers: { range } });
  expect(response.status).toBe(206); expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${bytes.length}`);
  expect(response.headers.get("content-type")).toBe("audio/wav"); expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(start, end + 1));
  expect(response.headers.get("content-length")).toBe(String(end - start + 1));
});

test.each(basePaths.flatMap(base => ["bytes=4096-", "bytes=999999999999999999999-", "bytes=-0"].map(range => ({ base, range }))))("actual HTTP unsatisfiable response %j", async ({ base, range }) => {
  const { url } = await httpFixture(base);
  const response = await fetch(url, { headers: { range } });
  expect(response.status).toBe(416); expect(response.headers.get("content-range")).toBe("bytes */4096");
  expect(response.headers.get("content-length")).toBe("0"); expect((await response.arrayBuffer()).byteLength).toBe(0);
});

test.each(basePaths.flatMap(base => ["bytes=0-1,3-4", "nonsense", "bytes=", "bytes=-", "bytes=20-10", "bytes=+1-3", "bytes=1.2-3", "items=0-1"].map(range => ({ base, range }))))("actual HTTP malformed/multiple range response %j", async ({ base, range }) => {
  const { url } = await httpFixture(base);
  const response = await fetch(url, { headers: { range } });
  expect(response.status).toBe(200); expect(response.headers.get("content-range")).toBeNull();
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get("content-length")).toBe(String(bytes.length));
});

test.each(basePaths.flatMap(base => [undefined, "bytes=0-1", "bytes=999999-"].map(range => ({ base, range }))))("actual HTTP HEAD ignores Range %j", async ({ base, range }) => {
  const { url, metrics } = await httpFixture(base);
  const response = await fetch(url, { method: "HEAD", headers: range ? { range } : {} });
  expect(response.status).toBe(200); expect(response.headers.get("content-length")).toBe("4096");
  expect(response.headers.get("content-type")).toBe("audio/wav"); expect(response.headers.get("content-range")).toBeNull();
  expect((await response.arrayBuffer()).byteLength).toBe(0); expect(metrics.get("media.read_bytes_total")).toBe(0);
});

test.each(basePaths.flatMap(base => ["GET", "HEAD"].map(method => ({ base, method }))))("actual HTTP empty response %j", async ({ base, method }) => {
  const { empty } = await httpFixture(base);
  const response = await fetch(empty, { method });
  expect(response.status).toBe(200); expect(response.headers.get("content-length")).toBe("0"); expect(response.headers.get("content-type")).toBe("video/mp4");
  expect((await response.arrayBuffer()).byteLength).toBe(0);
});

test.each(basePaths)("actual HTTP empty-file range is bodyless 416 under %s", async base => {
  const { empty } = await httpFixture(base);
  const response = await fetch(empty, { headers: { range: "bytes=0-" } });
  expect(response.status).toBe(416); expect(response.headers.get("content-range")).toBe("bytes */0");
  expect((await response.arrayBuffer()).byteLength).toBe(0);
});

test("media authentication, exact roots, internal paths and policy are enforced without admission", async () => {
  const left = await directory(), right = await directory(), outside = await directory();
  for (const [dir, value] of [[left, "left"], [right, "right"]]) await writeFile(path.join(dir!, "clip.mp3"), value!);
  await writeFile(path.join(left, ".gitignore"), "clip.mp3\n");
  await writeFile(path.join(left, ".uatu.json"), JSON.stringify({ ignore: { exclude: ["excluded.mp3"], include: ["build/renders"] } }));
  await mkdir(path.join(left, "build/renders"), { recursive: true });
  await mkdir(path.join(left, "build/other"));
  for (const name of ["excluded.mp3", ".env.mp3", "build/other/no.mp3", "build/renders/yes.mp3"]) await writeFile(path.join(left, name), "secret or output");
  await writeFile(path.join(outside, "out.mp3"), "outside");
  await symlink(path.join(outside, "out.mp3"), path.join(left, "link.mp3"));
  const app = await serve([root(left), root(right)], "/s/media/");
  const url = app.url(left, "clip.mp3");
  const unauth = new URL(url); unauth.searchParams.delete("t");
  for (const method of ["GET", "HEAD"]) expect((await fetch(unauth, { method })).status).toBe(401);
  expect(await (await fetch(unauth, { headers: { cookie: `${terminalCookieName(unauth)}=media-secret` } })).text()).toBe("left");
  expect(await (await fetch(url)).text()).toBe("left"); expect(await (await fetch(app.url(right, "clip.mp3"))).text()).toBe("right");
  expect((await fetch(app.url(left, "build/renders/yes.mp3"))).status).toBe(200);
  for (const relative of ["excluded.mp3", ".env.mp3", "build/other/no.mp3", "link.mp3", "missing.mp3"]) {
    const denied = new URL(url); denied.searchParams.set("path", relative);
    expect((await fetch(denied)).status).toBe(404);
  }
  for (const relative of ["../out.mp3", "/clip.mp3", "a/../clip.mp3", "a\\clip.mp3", "clip.mp3\0", "./clip.mp3"]) {
    const invalid = new URL(url); invalid.searchParams.set("path", relative);
    expect((await fetch(invalid)).status).toBe(400);
  }
  for (const revision of ["no", "-1", "1.2", "9007199254740992"]) {
    const invalid = new URL(url); invalid.searchParams.set("revision", revision); expect((await fetch(invalid)).status).toBe(400);
  }
  const invalidRoot = new URL(url); invalidRoot.searchParams.set("rootId", outside); expect((await fetch(invalidRoot)).status).toBe(404);
  const duplicate = new URL(url); duplicate.searchParams.append("path", "clip.mp3"); expect((await fetch(duplicate)).status).toBe(400);
  // A file written after indexing cannot be admitted by this route. Hold the
  // observer out of it by checking the authoritative index before requesting.
  const unindexed = new URL(url); unindexed.searchParams.set("path", "not-indexed.mp3");
  expect((await fetch(unindexed)).status).toBe(404);
  const reads = app.metrics.get("media.read_bytes_total");
  await writeFile(path.join(left, ".uatu.json"), JSON.stringify({ ignore: { exclude: ["clip.mp3"] } }));
  // Policy recovery temporarily refuses old indexed identities with 409.
  // Assert the terminal exclusion only once the authoritative view applies it.
  await wait(() => !app.session.findDocument(path.join(left, "clip.mp3")));
  expect((await fetch(url)).status).toBe(404);
  expect(app.metrics.get("media.read_bytes_total")).toBe(reads);
});

test("policy recovery fails closed before the terminal media exclusion is visible", async () => {
  const dir = await directory(), file = path.join(dir, "clip.mp3"), config = path.join(dir, ".uatu.json");
  await writeFile(file, "clip"); await writeFile(config, "{}");
  let observer!: EventEmitter;
  const watch = (() => {
    const next = new EventEmitter(); observer = next;
    Object.assign(next, { close: async () => { next.removeAllListeners(); } });
    queueMicrotask(async () => { next.emit("all", "add", file, await stat(file)); next.emit("ready"); });
    return next;
  }) as unknown as NonNullable<WatchSessionOptions["watch"]>;
  const app = await serve([root(dir)], "/", { watch });
  const url = app.url(dir, "clip.mp3");
  const reads = app.metrics.get("media.read_bytes_total");
  await writeFile(config, JSON.stringify({ ignore: { exclude: ["clip.mp3"] } }));
  observer.emit("all", "change", config);
  expect(app.session.getDiscoveryState().status).toBe("recovering");
  // Start directly at the shared delivery seam so HTTP scheduling cannot hide
  // the interval before the asynchronous policy reload has applied its matcher.
  const recovering = await app.session.mediaResponse(new Request(url));
  expect(recovering.status).toBe(409);
  expect(recovering.headers.get("cache-control")).toBe("no-store, no-transform");
  expect((await recovering.arrayBuffer()).byteLength).toBe(0);
  expect(app.metrics.get("media.read_bytes_total")).toBe(reads);
  await wait(() => !app.session.findDocument(file));
  const excluded = await fetch(url);
  expect(excluded.status).toBe(404);
  expect((await excluded.arrayBuffer()).byteLength).toBe(0);
  expect(app.metrics.get("media.read_bytes_total")).toBe(reads);
});

test("single-file launch constraints are not widened by media identity", async () => {
  const dir = await directory(); const file = path.join(dir, "readme.md");
  await writeFile(file, "readme"); await writeFile(path.join(dir, "clip.wav"), bytes);
  const app = await serve([{ kind: "file", absolutePath: file, parentDir: dir }]);
  const url = app.url(file, "readme.md"); url.searchParams.set("path", "clip.wav");
  expect((await fetch(url)).status).toBe(404);
});

test("stale epochs/revisions and unobserved equal-mtime disk changes never select newer bytes", async () => {
  const dir = await directory(), file = path.join(dir, "clip.wav"); await writeFile(file, bytes);
  await utimes(file, 1_700_000_000, 1_700_000_000);
  let observer!: EventEmitter;
  const watch: NonNullable<WatchSessionOptions["watch"]> = (() => {
    observer = new EventEmitter();
    Object.assign(observer, { close: async () => { observer.removeAllListeners(); } });
    queueMicrotask(async () => { observer.emit("all", "add", file, await stat(file)); observer.emit("ready"); });
    return observer;
  }) as unknown as NonNullable<WatchSessionOptions["watch"]>;
  const app = await serve([root(dir)], "/", { watch });
  const original = app.url(dir, "clip.wav");
  const staleRevision = new URL(original); staleRevision.searchParams.set("revision", "0");
  for (const requestUrl of [staleRevision, new URL(original.toString().replace(/epoch=[^&]+/, "epoch=old"))]) {
    const response = await fetch(requestUrl); expect(response.status).toBe(409); expect(response.headers.get("cache-control")).toBe("no-store, no-transform"); expect((await response.arrayBuffer()).byteLength).toBe(0);
  }
  const before = await stat(file);
  await writeFile(file, new Uint8Array(bytes.length).fill(77)); await utimes(file, before.atime, before.mtime);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  expect(app.session.findDocument(file)!.revision).toBe(Number(original.searchParams.get("revision")));
  const stale = await fetch(original, { headers: { range: "bytes=10-20" } });
  expect(stale.status).toBe(409); expect((await stale.arrayBuffer()).byteLength).toBe(0);
  observer.emit("all", "change", file);
  await wait(() => app.session.findDocument(file)?.revision !== Number(original.searchParams.get("revision")));
  const current = app.url(dir, "clip.wav"); expect(new Uint8Array(await (await fetch(current)).arrayBuffer())).toEqual(new Uint8Array(bytes.length).fill(77));
  await app.restart();
  expect((await fetch(current)).status).toBe(409);
  const payload = JSON.stringify(app.session.getStatePayload());
  for (const field of ["fingerprint", "ctimeMs", '"dev"', '"ino"', '"size"']) expect(payload).not.toContain(field);
});

test("pull-driven delivery reads at most one bounded chunk and cancellation closes its handle", async () => {
  const dir = await directory(), file = path.join(dir, "large.wav");
  const handle = await open(file, "w"); await handle.truncate(128 * 1024 * 1024); await handle.close();
  const app = await serve([root(dir)]);
  const request = new Request(app.url(dir, "large.wav"));
  const response = await app.session.mediaResponse(request);
  expect(app.metrics.get("media.read_bytes_total")).toBe(0);
  const reader = response.body!.getReader();
  const first = await reader.read(); expect(first.value!.byteLength).toBe(MEDIA_CHUNK_BYTES);
  expect(app.metrics.get("media.read_bytes_total")).toBe(MEDIA_CHUNK_BYTES);
  await reader.cancel(); await wait(() => app.metrics.get("media.open_handles") === 0);
  expect(app.metrics.get("media.transfers_active")).toBe(0);
  // Exercise actual HTTP backpressure and downstream cancellation as well.
  const abort = new AbortController();
  const http = await fetch(app.url(dir, "large.wav"), { signal: abort.signal });
  const httpReader = http.body!.getReader(); await httpReader.read(); abort.abort();
  await httpReader.cancel().catch(() => {});
  await wait(() => app.metrics.get("media.open_handles") === 0 && app.metrics.get("media.transfers_active") === 0);
  expect(app.metrics.get("media.read_bytes_total")).toBeLessThan(16 * 1024 * 1024);
});

test.each(["write", "replacement", "removal", "recovery", "shutdown"])("outstanding transfers are invalidated before publication on %s", async action => {
  const dir = await directory(), file = path.join(dir, "clip.wav");
  await writeFile(file, new Uint8Array(4 * MEDIA_CHUNK_BYTES));
  const app = await serve([root(dir)]);
  const url = app.url(dir, "clip.wav");
  const response = await app.session.mediaResponse(new Request(url)); const reader = response.body!.getReader();
  await reader.read();
  const oldRevision = app.session.findDocument(file)!.revision;
  if (action === "write") {
    const handle = await open(file, "r+"); await handle.write(new Uint8Array([88]), 0, 1, 0); await handle.close();
    app.session._internalWatcher()!.emit("all", "change", file);
  } else if (action === "replacement") {
    const next = path.join(dir, "next.tmp"); await writeFile(next, new Uint8Array(4 * MEDIA_CHUNK_BYTES).fill(1)); await rename(next, file);
    app.session._internalWatcher()!.emit("all", "change", file);
  } else if (action === "removal") {
    await rm(file); app.session._internalWatcher()!.emit("all", "unlink", file);
  } else if (action === "recovery") {
    const recovering = app.session.recover();
    await expect(reader.read()).rejects.toThrow(); await recovering;
  } else await app.session.stop();
  if (action !== "recovery") await expect(reader.read()).rejects.toThrow();
  if (action === "write" || action === "replacement") expect(app.session.findDocument(file)!.revision).toBe(oldRevision);
  await wait(() => app.metrics.get("media.open_handles") === 0);
  expect((await fetch(url)).status).not.toBe(200);
});
